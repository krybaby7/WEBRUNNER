import { afterEach, describe, expect, it } from "vitest";
import type { FetchService } from "../../../src/core/fetch/index.js";
import type { FlightProvider } from "../../../src/core/flights/types.js";
import type { SearchService } from "../../../src/core/search/index.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { registerAccountsTool } from "../../../src/tools/accounts.js";
import { registerBrowseTaskTool } from "../../../src/tools/browse_task.js";
import { registerDeepResearchTool } from "../../../src/tools/deep_research.js";
import { registerFetchPageTool } from "../../../src/tools/fetch_page.js";
import { registerHealthTool } from "../../../src/tools/health.js";
import { registerTools, TOOL_NAMES } from "../../../src/tools/index.js";
import { registerPingTool } from "../../../src/tools/ping.js";
import { registerSearchFlightsTool } from "../../../src/tools/search_flights.js";
import { registerSocialSearchTool } from "../../../src/tools/social_search.js";
import { registerSearchHotelsTool } from "../../../src/tools/search_hotels.js";
import { registerSearchReviewsTool } from "../../../src/tools/search_reviews.js";
import { registerWebSearchTool } from "../../../src/tools/web_search.js";
import { makeConfig } from "../llm/helpers.js";
import { recordingLogger, scriptedLlm } from "../research/helpers.js";
import { callTool, connectServer, fakeBrowser, type Connected, type ToolResult } from "./helpers.js";

/**
 * Error envelope audit (PLAN.md 3.6): whatever a tool's dependency throws, the
 * handler returns an `internal` envelope with a one-line message and never
 * lets the exception, or its stack, reach the client.
 */

const STACK_MARKER = "secretInternalFunction";
const STACK = `Error: boom\n    at ${STACK_MARKER} (/home/owner/webrunner/src/core/secret.ts:42:7)\n    at async run (/home/owner/webrunner/src/core/other.ts:1:1)`;

/** A plain Error("boom") that carries a realistic stack, so a leak is detectable. */
function boom(): Error {
  const err = new Error("boom");
  err.stack = STACK;
  return err;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function baseDeps(): Deps {
  return {
    config: makeConfig(),
    log: recordingLogger().logger,
    llm: scriptedLlm({}),
    browser: fakeBrowser(),
    search: { search: () => Promise.reject(boom()) } satisfies SearchService,
    fetch: { fetchPage: () => Promise.reject(boom()) } satisfies FetchService,
  };
}

interface Case {
  args: Record<string, unknown>;
  /** Register the one tool under test with a dependency or runner that throws a plain Error("boom"). */
  register: (server: Parameters<Parameters<typeof connectServer>[0]>[0], deps: Deps) => void;
  /** Patch the deps so the throwing dependency is reached. */
  deps?: (deps: Deps) => Deps;
}

const throwingProvider: FlightProvider = {
  name: "duffel",
  isConfigured: () => true,
  search: () => Promise.reject(boom()),
};

const CASES: Record<(typeof TOOL_NAMES)[number], Case | "cannot-fail"> = {
  // ping reads no dependency and does no I/O, so there is nothing to inject.
  ping: "cannot-fail",
  web_search: {
    args: { query: "anything" },
    register: (server, deps) => registerWebSearchTool(server, deps),
  },
  fetch_page: {
    args: { url: "https://example.org/" },
    register: (server, deps) => registerFetchPageTool(server, deps),
  },
  browse_task: {
    args: { goal: "find the thing" },
    register: (server, deps) =>
      registerBrowseTaskTool(server, deps, () => {
        throw boom();
      }),
  },
  search_flights: {
    args: { origin: "JFK", destination: "LHR", depart_date: "2030-01-15" },
    // The provider factory throws before any source is called: nothing per-source can catch it.
    register: (server, deps) =>
      registerSearchFlightsTool(server, deps, {
        providers: () => {
          throw boom();
        },
      }),
  },
  social_search: {
    args: { query: "anything" },
    // The platform factory throws before any platform is called: nothing per-platform can catch it.
    register: (server, deps) =>
      registerSocialSearchTool(server, deps, {
        platforms: () => {
          throw boom();
        },
      }),
  },
  search_hotels: {
    args: { destination: "Paris", check_in: "2030-01-15", check_out: "2030-01-18" },
    // The provider factory throws before any source is called: nothing per-source can catch it.
    register: (server, deps) =>
      registerSearchHotelsTool(server, deps, {
        providers: () => {
          throw boom();
        },
      }),
  },
  search_reviews: {
    args: { subject: "Notion" },
    // The source factory throws before any source runs: nothing per-source can catch it.
    register: (server, deps) =>
      registerSearchReviewsTool(server, deps, {
        sources: () => {
          throw boom();
        },
      }),
  },
  deep_research: {
    args: { question: "what is going on?" },
    register: (server, deps) => registerDeepResearchTool(server, deps, () => Promise.reject(boom())),
  },
  accounts: {
    args: { action: "list" },
    // The service factory throws before any action runs: only the catch-all can turn it into an envelope.
    register: (server, deps) =>
      registerAccountsTool(server, deps, {
        service: () => {
          throw boom();
        },
      }),
  },
  health: {
    args: {},
    register: (server, deps) => registerHealthTool(server, deps, TOOL_NAMES),
    deps: (deps) => ({
      ...deps,
      browser: {
        ...fakeBrowser(),
        stats: () => {
          throw boom();
        },
      },
    }),
  },
};

function expectInternalEnvelope(result: ToolResult): void {
  expect(result.isError).toBe(true);
  const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(envelope);
  expect(envelope.error.code).toBe("internal");
  expect(typeof envelope.error.retryable).toBe("boolean");

  const { message } = envelope.error;
  expect(message).toContain("boom");
  expect(message).not.toContain("\n");
  expect(message).not.toMatch(/^\s*at\s/m);
  // No stack frame, file path or function name from the thrown error anywhere in the result.
  const everything = JSON.stringify(result);
  expect(everything).not.toContain(STACK_MARKER);
  expect(everything).not.toContain("secret.ts");
  expect(everything).not.toContain("/home/owner");
}

async function connectOne(register: Case["register"], deps: Deps): Promise<Connected> {
  const c = await connectServer((server) => register(server, deps));
  cleanups.push(() => c.close());
  return c;
}

describe("error envelope audit", () => {
  it("covers every registered tool", async () => {
    const c = await connectServer((server) => registerTools(server, baseDeps()));
    cleanups.push(() => c.close());
    const listed = (await c.client.listTools()).tools.map((t) => t.name).sort();
    expect(Object.keys(CASES).sort()).toEqual(listed);
  });

  for (const [name, entry] of Object.entries(CASES)) {
    if (entry === "cannot-fail") {
      it(`${name} has no failure path and returns a normal result`, async () => {
        const { client } = await connectOne((server, deps) => registerPingTool(server, deps), baseDeps());
        const result = await callTool(client, name);
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({ ok: true });
      });
      continue;
    }
    it(`${name} turns a thrown Error("boom") into an internal envelope without a stack trace`, async () => {
      const deps = entry.deps !== undefined ? entry.deps(baseDeps()) : baseDeps();
      const { client } = await connectOne(entry.register, deps);
      expectInternalEnvelope(await callTool(client, name, entry.args));
    });
  }

  it("search_flights reports a source that throws as a failed source, not a crash", async () => {
    const { client } = await connectOne(
      (server, deps) => registerSearchFlightsTool(server, deps, { providers: () => [throwingProvider] }),
      baseDeps(),
    );
    const result = await callTool(client, "search_flights", {
      origin: "JFK",
      destination: "LHR",
      depart_date: "2030-01-15",
    });
    expect(result.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
    // Per-source failures keep their own classification (a provider failure), and carry no stack.
    expect(envelope.error.code).toBe("provider");
    expect(envelope.error.message).toContain("boom");
    expect(JSON.stringify(result)).not.toContain(STACK_MARKER);
  });
});
