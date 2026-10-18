import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyCostCap } from "../../../src/core/llm/daily-cap.js";
import type { ReviewSourceProvider } from "../../../src/core/reviews/types.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { SearchReviewsOutputSchema } from "../../../src/schemas/reviews.js";
import { registerTools } from "../../../src/tools/index.js";
import { registerSearchReviewsTool, type SearchReviewsToolOptions } from "../../../src/tools/search_reviews.js";
import { makeConfig } from "../llm/helpers.js";
import { scriptedLlm } from "../research/helpers.js";
import { callTool, connectServer, type Connected, type ToolResult } from "../tools/helpers.js";
import { failingSource, fakeSource, forever, makeLogger, review, sourceWith } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-reviews-"));
});
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(sources: ReviewSourceProvider[], over: Partial<Deps> = {}, options: Omit<SearchReviewsToolOptions, "sources"> = {}): Promise<Connected> {
  const deps: Deps = { config: makeConfig(), log: makeLogger(), ...over };
  const c = await connectServer((server) => registerSearchReviewsTool(server, deps, { sources: () => sources, ...options }));
  cleanups.push(() => c.close());
  return c;
}

const call = (c: Connected, args: Record<string, unknown> = { subject: "Notion" }): Promise<ToolResult> => callTool(c.client, "search_reviews", args);

function ok(result: ToolResult) {
  expect(result.isError).not.toBe(true);
  return SearchReviewsOutputSchema.parse(result.structuredContent);
}

function err(result: ToolResult) {
  expect(result.isError).toBe(true);
  const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(envelope);
  return envelope.error;
}

const appStore = () => sourceWith("app_store", [review("app_store", "a1", { rating: 5 }), review("app_store", "a2", { rating: 2 })]);

describe("search_reviews tool", () => {
  it("is registered with the other tools and describes its sources, their needs and the terms of service", async () => {
    const c = await connectServer((server) => registerTools(server, { config: makeConfig(), log: makeLogger() }));
    cleanups.push(() => c.close());
    const tool = (await c.client.listTools()).tools.find((t) => t.name === "search_reviews");
    expect(tool).toBeDefined();
    const d = tool?.description ?? "";
    for (const name of ["App Store", "Trustpilot", "Google Maps", "Google Play", "Amazon"]) expect(d).toContain(name);
    expect(d).toMatch(/real browser/);
    expect(d).toMatch(/connected account/);
    expect(d).toMatch(/against their terms of service/);
    expect(d).toMatch(/personal, low-volume use/i);
    expect(d).toMatch(/180 seconds/);
    expect(d).toMatch(/timeout/);
    expect(d).toMatch(/ANTHROPIC_API_KEY/);
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("returns reviews, subjects and sources_used from a fake source", async () => {
    const out = ok(await call(await connect([appStore()])));
    expect(out.reviews.map((r) => r.id)).toEqual(["app_store:a1", "app_store:a2"]);
    expect(out.subjects).toEqual([{ source: "app_store", name: "app_store subject" }]);
    expect(out.sources_used).toEqual(["app_store"]);
    expect(out.query).toMatchObject({ subject: "Notion", kind: "any", sources: ["app_store"], max_results: 30, per_source: 15, sort: "relevance", app_store_country: "us" });
    expect(Date.parse(out.fetched_at)).not.toBeNaN();
  });

  it("carries needs_login through to sources_failed", async () => {
    const maps = failingSource("google_maps", "blocked", "sign in required", { needsLogin: true });
    const out = ok(await call(await connect([appStore(), maps]), { subject: "Notion", sources: ["app_store", "google_maps"] }));
    expect(out.sources_failed).toEqual([{ source: "google_maps", error: "sign in required", needs_login: true }]);
  });

  // The MCP SDK validates arguments against the input schema before the handler runs and answers
  // with its own isError result, so a schema violation never reaches the handler's invalid_input
  // branch (which stays as a defensive path, as in the other tools).
  it.each<[Record<string, unknown>, RegExp]>([
    [{}, /subject/],
    [{ subject: "" }, /subject/],
    [{ subject: "x".repeat(301) }, /subject/],
    [{ subject: "Notion", min_rating: 4, max_rating: 2 }, /min_rating/],
    [{ subject: "Notion", app_store_country: "USA" }, /app_store_country/],
    [{ subject: "Notion", sources: [] }, /sources/],
    [{ subject: "Notion", sources: ["yelp"] }, /sources/],
    [{ subject: "Notion", max_results: 101 }, /max_results/],
    [{ subject: "Notion", recency: "decade" }, /recency/],
  ])("rejects %j as invalid input before any source runs", async (args, pattern) => {
    const src = appStore();
    const result = await call(await connect([src]), args);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Input validation error|invalid_input/);
    expect(result.content[0]?.text).toMatch(pattern);
    expect(src.search).not.toHaveBeenCalled();
  });

  it("returns config when no source is configured and none is named", async () => {
    const e = err(await call(await connect([sourceWith("app_store", [], { configured: false })])));
    expect(e).toMatchObject({ code: "config", retryable: false });
    expect(e.message).toContain("No review source is configured");
  });

  it("returns blocked with the failed sources when every source was walled", async () => {
    const e = err(await call(await connect([failingSource("app_store", "blocked", "wall")])));
    expect(e).toMatchObject({ code: "blocked", retryable: false, details: { sources_failed: [{ source: "app_store", error: "wall", needs_login: false }] } });
  });

  it("returns the timeout envelope at the wall clock and cancels the source", async () => {
    let aborted = false;
    const hang = fakeSource("app_store", (_q, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return forever();
    });
    const e = err(await call(await connect([hang], {}, { wallClockMs: 150, timeoutsMs: { app_store: 60_000 } })));
    expect(e).toMatchObject({ code: "timeout", retryable: true, details: { limit_ms: 150 } });
    expect(e.message).toContain("search_reviews");
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  it("returns timeout when the per-source timeout fells the only source", async () => {
    const e = err(await call(await connect([fakeSource("app_store", () => forever())], {}, { timeoutsMs: { app_store: 40 } })));
    expect(e).toMatchObject({ code: "timeout", retryable: true });
    expect(e.message).toContain("did not answer within");
  });

  it("refuses with budget_exceeded when the daily cap is reached and a summary is asked for, and not otherwise", async () => {
    const cap = new DailyCostCap({ capUsd: 5, dir, now: () => Date.parse("2026-10-18T10:00:00Z"), log: makeLogger() });
    cap.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 5.5);
    const src = appStore();
    const c = await connect([src], { dailyCap: cap, llm: scriptedLlm({ extractor: [] }) });
    const e = err(await call(c, { subject: "Notion", summarize: true }));
    expect(e).toMatchObject({ code: "budget_exceeded", retryable: false });
    expect(e.message).toContain("WEBRUNNER_DAILY_COST_CAP_USD");
    expect(src.search).not.toHaveBeenCalled();
    // Without a summary the call does not spend, so it runs.
    ok(await call(c, { subject: "Notion" }));
  });

  it("writes a summary with a scripted LLM and reports an LLM failure as a caveat", async () => {
    const llm = scriptedLlm({
      extractor: [{ text: "Good [app_store:a1], bad [app_store:a2].", themes: [{ theme: "Value", sentiment: "mixed", item_ids: ["app_store:a1", "app_store:a2", "nope"] }] }],
      costPerCall: 0.01,
    });
    const out = ok(await call(await connect([appStore()], { llm }), { subject: "Notion", summarize: true }));
    expect(out.summary).toEqual({ text: "Good [app_store:a1], bad [app_store:a2].", themes: [{ theme: "Value", sentiment: "mixed", item_ids: ["app_store:a1", "app_store:a2"] }], cost_usd: 0.01 });

    const broken = scriptedLlm({ extractor: [], failures: () => new Error("boom") });
    const partial = ok(await call(await connect([appStore()], { llm: broken }), { subject: "Notion", summarize: true }));
    expect(partial.summary).toBeUndefined();
    expect(partial.reviews).toHaveLength(2);
    expect(partial.caveats).toContain("No summary: boom");
  });

  it("turns a throwing source factory into an internal envelope without a stack", async () => {
    const deps: Deps = { config: makeConfig(), log: makeLogger() };
    const c = await connectServer((server) =>
      registerSearchReviewsTool(server, deps, {
        sources: () => {
          throw new Error("factory exploded\n    at secretFn (/home/owner/x.ts:1:1)");
        },
      }),
    );
    cleanups.push(() => c.close());
    const e = err(await call(c));
    expect(e).toMatchObject({ code: "internal", retryable: false });
    expect(e.message).toBe("search_reviews failed: factory exploded");
    expect(JSON.stringify(e)).not.toContain("secretFn");
  });

  it("reports a source that throws a plain error as a provider failure, not a crash", async () => {
    const e = err(await call(await connect([fakeSource("app_store", () => Promise.reject(new Error("boom")))])));
    expect(e).toMatchObject({ code: "provider", retryable: false });
    expect(e.message).toBe("app_store: boom");
  });
});
