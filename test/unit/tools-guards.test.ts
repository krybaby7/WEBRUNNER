import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import type { FetchService } from "../../src/core/fetch/index.js";
import type { FlightProvider } from "../../src/core/flights/types.js";
import { DailyCostCap } from "../../src/core/llm/daily-cap.js";
import type { SearchService } from "../../src/core/search/index.js";
import type { Deps } from "../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../src/schemas/error.js";
import { registerBrowseTaskTool } from "../../src/tools/browse_task.js";
import { registerDeepResearchTool, type DeepResearchRunner } from "../../src/tools/deep_research.js";
import { registerFetchPageTool } from "../../src/tools/fetch_page.js";
import {
  TOOL_WALL_CLOCK_MS,
  WallClockExceeded,
  dailyCapResult,
  runWithWallClock,
  wallClockResult,
  withWallClock,
} from "../../src/tools/guard.js";
import { registerSearchFlightsTool } from "../../src/tools/search_flights.js";
import { registerTools } from "../../src/tools/index.js";
import { registerWebSearchTool } from "../../src/tools/web_search.js";
import { makeConfig } from "./llm/helpers.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const open: Array<() => Promise<void>> = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-guards-"));
});
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** A promise that never settles: the tool can only end through its wall-clock cap. */
const forever = <T>(): Promise<T> => new Promise<T>(() => undefined);

function envelope(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

describe("wall-clock helpers", () => {
  it("documents the caps", () => {
    expect(TOOL_WALL_CLOCK_MS).toEqual({
      web_search: 30_000,
      fetch_page: 90_000,
      search_flights: 120_000,
      browse_task: 11 * 60_000,
      search_hotels: 120_000,
      market_quote: 30_000,
      weather: 20_000,
      exchange_rate: 20_000,
      social_search: 180_000,
      search_reviews: 180_000,
      accounts: 330_000,
    });
  });

  it("withWallClock passes the result through when the work finishes in time", async () => {
    await expect(withWallClock(1000, () => Promise.resolve("done"))).resolves.toBe("done");
  });

  it("withWallClock rejects with WallClockExceeded and aborts the signal at the deadline", async () => {
    let seen: AbortSignal | undefined;
    const result = withWallClock(30, (signal) => {
      seen = signal;
      return forever<string>();
    });
    await expect(result).rejects.toBeInstanceOf(WallClockExceeded);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(WallClockExceeded);
  });

  it("withWallClock does not abort the signal when the work wins", async () => {
    let seen: AbortSignal | undefined;
    await withWallClock(1000, (signal) => {
      seen = signal;
      return Promise.resolve(1);
    });
    expect(seen?.aborted).toBe(false);
  });

  it("withWallClock rethrows the work's own failure and drops one that arrives after the deadline", async () => {
    await expect(withWallClock(1000, () => Promise.reject(new Error("own failure")))).rejects.toThrow("own failure");
    const late = withWallClock(20, () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("too late")), 60)));
    await expect(late).rejects.toBeInstanceOf(WallClockExceeded);
    // The late rejection must not surface as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 100));
  });

  it("wallClockResult is the retryable timeout envelope", () => {
    const res = wallClockResult("fetch_page", 90_000);
    expect(res.isError).toBe(true);
    const error = ErrorEnvelopeSchema.parse(res.structuredContent).error;
    expect(error).toMatchObject({ code: "timeout", retryable: true, details: { limit_ms: 90_000 } });
    expect(error.message).toContain("fetch_page");
    expect(error.message).toContain("90 s");
  });

  it("runWithWallClock maps only the deadline to the envelope", async () => {
    const res = await runWithWallClock("x", 20, () => forever());
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error.code).toBe("timeout");
    await expect(runWithWallClock("x", 1000, () => Promise.reject(new Error("bug")))).rejects.toThrow("bug");
  });
});

describe("tool wall-clock caps", () => {
  it("web_search returns the timeout envelope when the search never finishes", async () => {
    const search: SearchService = { search: () => forever() };
    const client = await connect((s) => registerWebSearchTool(s, { config: {} as Config, log, search }, { wallClockMs: 40 }));
    const error = envelope(await client.callTool({ name: "web_search", arguments: { query: "q" } }));
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(error.message).toContain("web_search");
  });

  it("fetch_page returns the timeout envelope when the fetch never finishes", async () => {
    const fetch: FetchService = { fetchPage: () => forever() };
    const client = await connect((s) => registerFetchPageTool(s, { config: {} as Config, log, fetch }, { wallClockMs: 40 }));
    const error = envelope(await client.callTool({ name: "fetch_page", arguments: { url: "https://example.com/" } }));
    expect(error).toMatchObject({ code: "timeout", retryable: true });
  });

  it("search_flights returns the timeout envelope and cancels the sources", async () => {
    let seen: AbortSignal | undefined;
    const slow: FlightProvider = {
      name: "duffel",
      isConfigured: () => true,
      search: (_q, signal) => {
        seen = signal;
        return forever();
      },
    };
    const client = await connect((s) =>
      registerSearchFlightsTool(
        s,
        { config: { currency: "USD" } as Config, log },
        { providers: () => [slow], wallClockMs: 60, timeoutsMs: { duffel: 60_000, google_flights: 60_000 } },
      ),
    );
    const error = envelope(
      await client.callTool({ name: "search_flights", arguments: { origin: "LHR", destination: "JFK", depart_date: "2026-12-01" } }),
    );
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(seen?.aborted).toBe(true);
  });

  it("browse_task returns the timeout envelope when the agent hangs", async () => {
    const deps: Deps = { config: { anthropic_api_key: "k" } as Config, log, browser: {} as BrowserSession, llm: { complete: vi.fn() } };
    const client = await connect((s) => registerBrowseTaskTool(s, deps, () => forever(), { wallClockMs: 40 }));
    const error = envelope(await client.callTool({ name: "browse_task", arguments: { goal: "find it" } }));
    expect(error).toMatchObject({ code: "timeout", retryable: true });
  });

  it("deep_research takes its cap from config, cancels the engine through the signal and returns timeout", async () => {
    let seen: AbortSignal | undefined;
    const runner: DeepResearchRunner = (_input, deps) => {
      seen = deps.signal;
      return forever();
    };
    const deps: Deps = {
      config: makeConfig({ research_max_ms: 50 }),
      log,
      search: { search: () => forever() },
      fetch: { fetchPage: () => forever() },
      llm: { complete: () => forever() },
    };
    const client = await connect((s) => registerDeepResearchTool(s, deps, runner));
    const error = envelope(await client.callTool({ name: "deep_research", arguments: { question: "What is the capital of France?" } }));
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
  });

  it("deep_research passes a live signal to a run that finishes in time", async () => {
    let aborted: boolean | undefined;
    const runner: DeepResearchRunner = (_input, deps) => {
      aborted = deps.signal?.aborted;
      return Promise.reject(new Error("stop here"));
    };
    const deps: Deps = {
      config: makeConfig({ research_max_ms: 60_000 }),
      log,
      search: { search: () => forever() },
      fetch: { fetchPage: () => forever() },
      llm: { complete: () => forever() },
    };
    const client = await connect((s) => registerDeepResearchTool(s, deps, runner));
    const error = envelope(await client.callTool({ name: "deep_research", arguments: { question: "What is the capital of France?" } }));
    expect(error.code).toBe("internal");
    expect(aborted).toBe(false);
  });

  it("every tool description states its cap", async () => {
    const client = await connect((s) => registerTools(s, { config: makeConfig(), log }));
    const { tools } = await client.listTools();
    const desc = (name: string): string => tools.find((t) => t.name === name)?.description ?? "";
    expect(desc("web_search")).toMatch(/30 seconds/);
    expect(desc("fetch_page")).toMatch(/90 seconds/);
    expect(desc("search_flights")).toMatch(/120 seconds/);
    expect(desc("browse_task")).toMatch(/10 minutes/);
    expect(desc("browse_task")).toMatch(/11 minutes/);
    expect(desc("deep_research")).toMatch(/15 minutes/);
    expect(desc("deep_research")).toMatch(/WEBRUNNER_RESEARCH_MAX_MS/);
    expect(desc("accounts")).toMatch(/330 seconds/);
    for (const name of ["web_search", "fetch_page", "search_flights", "browse_task", "deep_research", "accounts"]) {
      expect(desc(name)).toMatch(/timeout/);
    }
  });
});

describe("daily cost cap in the tools", () => {
  const T0 = Date.parse("2026-10-18T10:00:00Z");

  function spent(usd: number): DailyCostCap {
    const cap = new DailyCostCap({ capUsd: 5, dir, now: () => T0, log });
    if (usd > 0) cap.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, usd);
    return cap;
  }

  it("dailyCapResult is undefined when no cap is configured or there is room", () => {
    expect(dailyCapResult({ config: {} as Config, log })).toBeUndefined();
    expect(dailyCapResult({ config: {} as Config, log, dailyCap: spent(4.99) })).toBeUndefined();
  });

  it("dailyCapResult is a budget_exceeded envelope naming the variable and the day's spend", () => {
    const res = dailyCapResult({ config: {} as Config, log, dailyCap: spent(5.25) });
    expect(res).toBeDefined();
    const error = ErrorEnvelopeSchema.parse(res?.structuredContent).error;
    expect(error).toMatchObject({
      code: "budget_exceeded",
      retryable: false,
      details: { scope: "daily", variable: "WEBRUNNER_DAILY_COST_CAP_USD", date: "2026-10-18", spent_usd: 5.25, cap_usd: 5 },
    });
    expect(error.message).toContain("WEBRUNNER_DAILY_COST_CAP_USD");
    expect(error.message).toContain("$5.25");
    expect(error.message).toContain("$5.00");
    expect(error.message).toContain("2026-10-18");
  });

  it("deep_research refuses to start once the cap is reached, without calling the engine", async () => {
    const runner = vi.fn<DeepResearchRunner>();
    const deps: Deps = {
      config: makeConfig(),
      log,
      search: { search: () => forever() },
      fetch: { fetchPage: () => forever() },
      llm: { complete: () => forever() },
      dailyCap: spent(5),
    };
    const client = await connect((s) => registerDeepResearchTool(s, deps, runner));
    const error = envelope(await client.callTool({ name: "deep_research", arguments: { question: "What is the capital of France?" } }));
    expect(error).toMatchObject({ code: "budget_exceeded", retryable: false });
    expect(error.message).toContain("WEBRUNNER_DAILY_COST_CAP_USD");
    expect(runner).not.toHaveBeenCalled();
  });

  it("browse_task refuses to start once the cap is reached, without calling the agent", async () => {
    const runner = vi.fn();
    const deps: Deps = {
      config: { anthropic_api_key: "k" } as Config,
      log,
      browser: {} as BrowserSession,
      llm: { complete: vi.fn() },
      dailyCap: spent(7),
    };
    const client = await connect((s) => registerBrowseTaskTool(s, deps, runner));
    const error = envelope(await client.callTool({ name: "browse_task", arguments: { goal: "find it" } }));
    expect(error).toMatchObject({ code: "budget_exceeded", retryable: false });
    expect(error.message).toContain("$7.00");
    expect(runner).not.toHaveBeenCalled();
  });

  it("browse_task runs while there is room, and says so when a partial run ended on the daily cap", async () => {
    const dailyCap = spent(4);
    const runner = vi.fn(() => {
      // The run itself spends the last of the day's budget and stops as "partial".
      dailyCap.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2);
      return Promise.resolve({
        goal: "find it",
        outcome: "partial" as const,
        summary: "Stopped: the cost cap of $1.00 was reached.",
        final_url: "https://a.test/",
        steps_taken: 3,
      });
    });
    const deps: Deps = {
      config: { anthropic_api_key: "k" } as Config,
      log,
      browser: {} as BrowserSession,
      llm: { complete: vi.fn() },
      dailyCap,
    };
    const client = await connect((s) => registerBrowseTaskTool(s, deps, runner));
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "find it" } });
    expect(res.isError).not.toBe(true);
    expect((res.structuredContent as { summary: string }).summary).toMatch(/WEBRUNNER_DAILY_COST_CAP_USD/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("the tools do not mention the cap when none is configured", async () => {
    const runner = vi.fn(() =>
      Promise.resolve({ goal: "g", outcome: "partial" as const, summary: "limit", final_url: "https://a.test/", steps_taken: 1 }),
    );
    const deps: Deps = { config: { anthropic_api_key: "k" } as Config, log, browser: {} as BrowserSession, llm: { complete: vi.fn() } };
    const client = await connect((s) => registerBrowseTaskTool(s, deps, runner));
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect((res.structuredContent as { summary: string }).summary).toBe("limit");
  });
});
