import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { createCache } from "../../../src/core/cache/index.js";
import { FetchServiceError, createFetchService, type FetchService } from "../../../src/core/fetch/index.js";
import { buildFastFetchers } from "../../../src/core/fetch/fast/index.js";
import { FetchError, type FetchMethod, type FetchResult, type Fetcher } from "../../../src/core/fetch/types.js";
import type { Logger } from "../../../src/log.js";
import { OPTS, htmlResponse, mockFetch, neverAborted } from "./helpers.js";

const URL_A = "https://example.com/article";
const BODY = "The quick brown fox jumps over the lazy dog while the service keeps reading. ".repeat(20);

function page(method: FetchMethod = "jina"): FetchResult {
  return {
    url: URL_A,
    final_url: URL_A,
    title: "Article",
    markdown: `# Article\n\n${BODY}`,
    truncated: false,
    method,
    fetched_at: "2026-10-18T00:00:00.000Z",
    botWall: false,
  };
}

type Step = FetchResult | Error;

/** A fetcher that answers from a script (the last step repeats) and counts calls. */
function scripted(name: FetchMethod, ...steps: Step[]): Fetcher & { calls: number } {
  const f = {
    name,
    calls: 0,
    isConfigured: () => true,
    async fetch(): Promise<FetchResult> {
      const step = steps[Math.min(f.calls, steps.length - 1)];
      f.calls++;
      if (step === undefined) throw new Error("no step scripted");
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return f;
}

let dir: string;
let log: Logger;
let waits: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-fetch-resilience-"));
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  waits = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(fast: Fetcher[], browser?: Fetcher, extra: { timeoutMs?: number } = {}): FetchService {
  return createFetchService({
    fastFetchers: fast,
    ...(browser !== undefined && { browserFetcher: browser }),
    cache: createCache(dir),
    log,
    retry: {
      random: () => 0,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
    ...extra,
  });
}

async function failure(p: Promise<unknown>): Promise<FetchServiceError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchServiceError);
    return err as FetchServiceError;
  }
  throw new Error("expected the call to fail");
}

describe("fast fetch retries", () => {
  it("retries a retryable provider error and returns the recovered page", async () => {
    const jina = scripted("jina", new FetchError("jina", "provider", "HTTP 503", true, 503), page());
    const out = await service([jina]).fetchPage({ url: URL_A, mode: "fast" });
    expect(out.method).toBe("jina");
    expect(jina.calls).toBe(2);
    expect(waits).toHaveLength(1);
  });

  it("retries a retryable timeout", async () => {
    const jina = scripted("jina", new FetchError("jina", "timeout", "timed out", true), page());
    await service([jina]).fetchPage({ url: URL_A, mode: "fast" });
    expect(jina.calls).toBe(2);
  });

  it("stops after two retries and surfaces the last error", async () => {
    const jina = scripted("jina", new FetchError("jina", "provider", "HTTP 502", true, 502));
    const err = await failure(service([jina]).fetchPage({ url: URL_A, mode: "fast" }));
    expect(jina.calls).toBe(3);
    expect(err).toMatchObject({ code: "provider", retryable: true });
    expect(waits).toHaveLength(2);
  });

  it("never retries a bot wall", async () => {
    const jina = scripted("jina", new FetchError("jina", "blocked", "bot wall (HTTP 403)", false, 403));
    const err = await failure(service([jina]).fetchPage({ url: URL_A, mode: "fast" }));
    expect(jina.calls).toBe(1);
    expect(err.code).toBe("blocked");
    expect(waits).toEqual([]);
  });

  it("never retries invalid input", async () => {
    const direct = scripted("direct", new FetchError("direct", "invalid_input", "Unsupported content type image/gif", false));
    const err = await failure(service([direct]).fetchPage({ url: URL_A, mode: "fast" }));
    expect(direct.calls).toBe(1);
    expect(err.code).toBe("invalid_input");
  });

  it("does not retry a provider error that is not retryable (a 404)", async () => {
    const direct = scripted("direct", new FetchError("direct", "provider", "returned HTTP 404", false, 404));
    await failure(service([direct]).fetchPage({ url: URL_A, mode: "fast" }));
    expect(direct.calls).toBe(1);
  });

  it("does not retry a config error", async () => {
    const jina = scripted("jina", new FetchError("jina", "config", "needs a key", false, 401));
    await failure(service([jina]).fetchPage({ url: URL_A, mode: "fast" }));
    expect(jina.calls).toBe(1);
  });

  it("retries the whole chain, not a chain that already produced a page", async () => {
    const jina = scripted("jina", new FetchError("jina", "provider", "HTTP 503", true, 503));
    const direct = scripted("direct", page("direct"));
    const out = await service([jina, direct]).fetchPage({ url: URL_A, mode: "fast" });
    // The direct fetcher answered in the first pass, so there is nothing to retry.
    expect(out.method).toBe("direct");
    expect(jina.calls).toBe(1);
    expect(direct.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("a chain that times out is retried, each attempt under its own timeout", async () => {
    let calls = 0;
    const slow: Fetcher = {
      name: "jina",
      isConfigured: () => true,
      fetch: () => {
        calls++;
        return calls < 3 ? new Promise<FetchResult>(() => undefined) : Promise.resolve(page());
      },
    };
    const out = await service([slow], undefined, { timeoutMs: 25 }).fetchPage({ url: URL_A, mode: "fast" });
    expect(out.method).toBe("jina");
    expect(calls).toBe(3);
  });

  it("does not retry the browser fetcher", async () => {
    const browser = scripted("browser", new FetchError("browser", "provider", "navigation failed", true));
    const err = await failure(service([scripted("jina", page())], browser).fetchPage({ url: URL_A, mode: "browser" }));
    expect(browser.calls).toBe(1);
    expect(err.code).toBe("provider");
  });

  it("auto mode falls back to the browser on a bot wall without retrying the fast chain", async () => {
    const jina = scripted("jina", new FetchError("jina", "blocked", "wall", false, 403));
    const browser = scripted("browser", page("browser"));
    const out = await service([jina], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("browser");
    expect(jina.calls).toBe(1);
  });
});

describe("fast fetcher concurrency", () => {
  const config = loadConfig({ env: {}, configPath: "/nonexistent/config.json", home: "/nonexistent" });

  /** An injected fetch that holds each request for a moment and records the peak in flight. */
  function gaugedFetch(holdMs = 15): { fetchImpl: typeof fetch; peak: () => number; calls: () => number } {
    let running = 0;
    let peak = 0;
    let calls = 0;
    const { fetchImpl } = mockFetch(async () => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, holdMs));
      running--;
      return htmlResponse(`<!doctype html><title>t</title><article><p>${BODY}</p></article>`);
    });
    return { fetchImpl, peak: () => peak, calls: () => calls };
  }

  it("runs at most 6 requests at once per fetcher by default", async () => {
    const g = gaugedFetch();
    const direct = buildFastFetchers(config, g.fetchImpl).find((f) => f.name === "direct");
    await Promise.all(Array.from({ length: 20 }, (_, i) => direct?.fetch(`https://example.com/p${i}`, OPTS, neverAborted())));
    expect(g.calls()).toBe(20);
    expect(g.peak()).toBe(6);
  });

  it("honors a configured limit", async () => {
    const g = gaugedFetch();
    const direct = buildFastFetchers(config, g.fetchImpl, { concurrency: 2 }).find((f) => f.name === "direct");
    await Promise.all(Array.from({ length: 8 }, (_, i) => direct?.fetch(`https://example.com/p${i}`, OPTS, neverAborted())));
    expect(g.peak()).toBe(2);
  });

  it("limits each fetcher separately", async () => {
    const running: Record<string, number> = {};
    const peak: Record<string, number> = {};
    const jinaBody = JSON.stringify({ data: { title: "t", url: "https://example.com/", content: BODY, httpStatus: 200 } });
    const { fetchImpl } = mockFetch(async (url) => {
      const host = new URL(url).hostname;
      running[host] = (running[host] ?? 0) + 1;
      peak[host] = Math.max(peak[host] ?? 0, running[host] ?? 0);
      await new Promise((r) => setTimeout(r, 15));
      running[host] = (running[host] ?? 1) - 1;
      return host === "r.jina.ai"
        ? new Response(jinaBody, { headers: { "content-type": "application/json" } })
        : htmlResponse(`<!doctype html><title>t</title><article><p>${BODY}</p></article>`);
    });
    const fetchers = buildFastFetchers(config, fetchImpl, { concurrency: 2 });
    const jina = fetchers.find((f) => f.name === "jina");
    const direct = fetchers.find((f) => f.name === "direct");
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => jina?.fetch(`https://example.com/j${i}`, OPTS, neverAborted())),
      ...Array.from({ length: 6 }, (_, i) => direct?.fetch(`https://example.com/d${i}`, OPTS, neverAborted())),
    ]);
    // Each fetcher got its own two slots: neither blocked the other.
    expect(peak["r.jina.ai"]).toBe(2);
    expect(peak["example.com"]).toBe(2);
  });

  it("keeps name and configuration of the wrapped fetchers", () => {
    const fetchers = buildFastFetchers(config);
    expect(fetchers.map((f) => f.name)).toEqual(["jina", "direct"]);
    expect(fetchers.every((f) => f.isConfigured())).toBe(true);
  });
});
