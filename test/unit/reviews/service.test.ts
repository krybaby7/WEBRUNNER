import { describe, expect, it } from "vitest";
import { LlmError, type LlmRequest } from "../../../src/core/llm/types.js";
import { createReviewsService, DEFAULT_SOURCE_TIMEOUTS_MS, REVIEWS_CACHE_TTL_MS, ReviewsSearchError, type ReviewsServiceDeps } from "../../../src/core/reviews/index.js";
import { APPROXIMATE_DATE_CAVEAT } from "../../../src/core/reviews/normalize.js";
import type { ReviewSourceProvider } from "../../../src/core/reviews/types.js";
import { REVIEW_TEXT_MAX_CHARS, SearchReviewsOutputSchema } from "../../../src/schemas/reviews.js";
import { scriptedLlm, userText, type RecordedLlm } from "../research/helpers.js";
import { failingSource, fakeSource, forever, makeLogger, memoryCache, NOW, parsedInput, review, sourceWith, type MemoryCache } from "./helpers.js";

function make(sources: ReviewSourceProvider[], over: Partial<ReviewsServiceDeps> & { cache?: MemoryCache } = {}) {
  const cache = over.cache ?? memoryCache();
  const log = makeLogger();
  const service = createReviewsService({ sources, cache, log, now: () => NOW, ...over });
  return { service, cache, log };
}

async function failure(p: Promise<unknown>): Promise<ReviewsSearchError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReviewsSearchError);
  return err as ReviewsSearchError;
}

const appStore = () => sourceWith("app_store", [review("app_store", "a1", { rating: 5 }), review("app_store", "a2", { rating: 2 })]);
const trustpilot = () => sourceWith("trustpilot", [review("trustpilot", "t1", { rating: 1 }), review("trustpilot", "t2", { rating: 4 })]);

describe("createReviewsService", () => {
  it("documents the per-source timeouts: 15 s for the API source, 60 s for browser sources and Trustpilot (its WAF fallback renders)", () => {
    expect(DEFAULT_SOURCE_TIMEOUTS_MS).toEqual({ app_store: 15_000, trustpilot: 60_000, google_maps: 60_000, google_play: 60_000, amazon: 60_000 });
    expect(REVIEWS_CACHE_TTL_MS).toBe(3_600_000);
  });

  it("runs the sources in parallel, interleaves them and reports subjects and sources_used in query order", async () => {
    let inFlight = 0;
    const slow = (name: "app_store" | "trustpilot") =>
      fakeSource(name, async () => {
        inFlight++;
        await new Promise((r) => setTimeout(r, 100));
        expect(inFlight).toBe(2);
        return { subject: { source: name, name: `${name} subject` }, reviews: [review(name, "1"), review(name, "2")] };
      });
    const { service } = make([slow("app_store"), slow("trustpilot")]);
    const out = await service.search(parsedInput({ sources: ["trustpilot", "app_store"] }));
    expect(SearchReviewsOutputSchema.safeParse(out).success).toBe(true);
    expect(out.reviews.map((r) => r.id)).toEqual(["trustpilot:1", "app_store:1", "trustpilot:2", "app_store:2"]);
    expect(out.subjects.map((s) => s.source)).toEqual(["trustpilot", "app_store"]);
    expect(out.sources_used).toEqual(["trustpilot", "app_store"]);
    expect(out.sources_failed).toEqual([]);
    expect(out.fetched_at).toBe(new Date(NOW).toISOString());
    expect(out.query.sources).toEqual(["trustpilot", "app_store"]);
  });

  it("picks the default sources by kind from the configured ones and never calls the others", async () => {
    const a = appStore();
    const t = trustpilot();
    const maps = sourceWith("google_maps", [], { configured: false });
    const { service } = make([a, t, maps]);
    const app = await service.search(parsedInput({ kind: "app" }));
    expect(app.query.sources).toEqual(["app_store"]);
    expect(t.search).not.toHaveBeenCalled();
    const business = await service.search(parsedInput({ kind: "business" }));
    expect(business.query.sources).toEqual(["trustpilot"]);
    expect(maps.search).not.toHaveBeenCalled();
    // No configured default for places: every configured source answers.
    const place = await service.search(parsedInput({ kind: "place" }));
    expect(place.query.sources).toEqual(["app_store", "trustpilot"]);
  });

  it("reports an explicitly named unconfigured or unknown source in sources_failed and still answers", async () => {
    const { service } = make([appStore(), sourceWith("amazon", [], { configured: false })]);
    const out = await service.search(parsedInput({ sources: ["amazon", "app_store", "google_play"] }));
    expect(out.sources_used).toEqual(["app_store"]);
    expect(out.sources_failed).toEqual([
      { source: "amazon", error: expect.stringContaining("not configured") as string, needs_login: false },
      { source: "google_play", error: expect.stringContaining("not configured") as string, needs_login: false },
    ]);
  });

  it("is a config error when nothing is configured and no sources are named", async () => {
    const { service } = make([sourceWith("app_store", [], { configured: false })]);
    const err = await failure(service.search(parsedInput()));
    expect(err).toMatchObject({ code: "config", retryable: false });
    expect(err.message).toContain("No review source is configured");
  });

  it("carries needs_login through from a source that hit a login wall", async () => {
    const maps = failingSource("google_maps", "blocked", "Google Maps asks for a sign-in; run accounts connect google", { needsLogin: true });
    const { service, log } = make([appStore(), maps]);
    const out = await service.search(parsedInput({ sources: ["app_store", "google_maps"] }));
    expect(out.sources_used).toEqual(["app_store"]);
    expect(out.sources_failed).toEqual([{ source: "google_maps", error: expect.stringContaining("sign-in") as string, needs_login: true }]);
    expect(log.warn).toHaveBeenCalledWith("review source failed", expect.objectContaining({ source: "google_maps", code: "blocked", needs_login: true }));
  });

  it("fails with the most specific shared code when no source answered", async () => {
    const blockedWins = make([failingSource("app_store", "timeout", "slow", { retryable: true }), failingSource("trustpilot", "blocked", "wall", { needsLogin: true })]);
    const b = await failure(blockedWins.service.search(parsedInput({ sources: ["app_store", "trustpilot"] })));
    expect(b).toMatchObject({ code: "blocked", retryable: false });
    expect(b.message).toContain("No review source answered.");
    expect(b.message).toContain("accounts tool");
    expect(b.details).toEqual({
      sources_failed: [
        { source: "app_store", error: "slow", needs_login: false },
        { source: "trustpilot", error: "wall", needs_login: true },
      ],
    });

    const shared = make([failingSource("app_store", "timeout", "a", { retryable: true }), failingSource("trustpilot", "timeout", "b", { retryable: true })]);
    expect(await failure(shared.service.search(parsedInput({ sources: ["app_store", "trustpilot"] })))).toMatchObject({ code: "timeout", retryable: true });

    const mixed = make([failingSource("app_store", "provider", "a"), failingSource("trustpilot", "timeout", "b", { retryable: true })]);
    expect(await failure(mixed.service.search(parsedInput({ sources: ["app_store", "trustpilot"] })))).toMatchObject({ code: "provider", retryable: true });

    // not_found is a provider-side miss; an unconfigured source does not decide the code when a real failure exists.
    const notFound = make([failingSource("app_store", "not_found", "no such app"), sourceWith("amazon", [], { configured: false })]);
    const nf = await failure(notFound.service.search(parsedInput({ sources: ["app_store", "amazon"] })));
    expect(nf.code).toBe("provider");
    expect(nf.message).toContain("no such app");

    // A single failing source is reported by name.
    const single = make([failingSource("app_store", "provider", "feed down", { retryable: true })]);
    expect((await failure(single.service.search(parsedInput()))).message).toBe("app_store: feed down");
  });

  it("times out a source that ignores its signal and keeps the others", async () => {
    const hang = fakeSource("trustpilot", () => forever());
    const { service } = make([appStore(), hang], { timeoutsMs: { trustpilot: 50 } });
    const out = await service.search(parsedInput({ sources: ["app_store", "trustpilot"] }));
    expect(out.sources_used).toEqual(["app_store"]);
    expect(out.sources_failed[0]).toMatchObject({ source: "trustpilot", error: expect.stringContaining("did not answer within") as string });
  });

  it("stops when the caller's signal aborts", async () => {
    const hang = fakeSource("app_store", () => forever());
    const { service } = make([hang]);
    const err = await failure(service.search(parsedInput(), AbortSignal.timeout(30)));
    expect(err.code).toBe("timeout");
  });

  describe("cache", () => {
    it("serves a second identical call from the cache, one entry per source and subject, for an hour", async () => {
      const a = appStore();
      const t = trustpilot();
      const { service, cache } = make([a, t]);
      const first = await service.search(parsedInput({ sources: ["app_store", "trustpilot"] }));
      const second = await service.search(parsedInput({ sources: ["app_store", "trustpilot"] }));
      expect(a.search).toHaveBeenCalledTimes(1);
      expect(t.search).toHaveBeenCalledTimes(1);
      expect(second.reviews).toEqual(first.reviews);
      expect(second.subjects).toEqual(first.subjects);
      expect(cache.store.size).toBe(2);
      for (const entry of cache.store.values()) expect(entry.ttlMs).toBe(REVIEWS_CACHE_TTL_MS);
    });

    it("keys on the subject (case-insensitively), per_source and the storefront, not on sort or filters", async () => {
      const a = appStore();
      const { service } = make([a]);
      await service.search(parsedInput({ subject: "Notion" }));
      await service.search(parsedInput({ subject: "notion", sort: "recent", min_rating: 3 }));
      expect(a.search).toHaveBeenCalledTimes(1);
      await service.search(parsedInput({ subject: "Notion", per_source: 5 }));
      await service.search(parsedInput({ subject: "Notion", app_store_country: "gb" }));
      await service.search(parsedInput({ subject: "Slack" }));
      expect(a.search).toHaveBeenCalledTimes(4);
    });

    it("does not cache failures, and ignores an entry that fails the schema", async () => {
      let calls = 0;
      const flaky = fakeSource("app_store", () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("first call fails")) : Promise.resolve({ subject: { source: "app_store", name: "x" }, reviews: [review("app_store", "1")] });
      });
      const { service, cache } = make([flaky]);
      await failure(service.search(parsedInput()));
      expect(cache.store.size).toBe(0);
      await service.search(parsedInput());
      expect(cache.store.size).toBe(1);
      for (const [k] of cache.store) cache.store.set(k, { value: { garbage: true }, ttlMs: 1 });
      await service.search(parsedInput());
      expect(calls).toBe(3);
    });
  });

  it("filters, sorts and cuts across sources, with caveats for what was dropped", async () => {
    const a = sourceWith("app_store", [
      review("app_store", "old", { rating: 5, created_at: new Date(NOW - 400 * 86_400_000).toISOString() }),
      review("app_store", "new", { rating: 5, created_at: new Date(NOW - 86_400_000).toISOString() }),
      review("app_store", "undated", { rating: 5, created_at: undefined }),
      review("app_store", "unrated", { rating: undefined }),
      review("app_store", "low", { rating: 1 }),
    ]);
    const t = sourceWith("trustpilot", [review("trustpilot", "mid", { rating: 3.5 })]);
    const { service } = make([a, t]);
    const out = await service.search(parsedInput({ sources: ["app_store", "trustpilot"], min_rating: 3, recency: "year", sort: "rating_high", max_results: 1 }));
    expect(out.reviews.map((r) => r.id)).toEqual(["app_store:new"]);
    expect(out.caveats).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 review(s) without a rating were left out"),
        expect.stringContaining("1 review(s) without a date were left out"),
        expect.stringContaining("1 further review(s) were left out to stay within max_results (1)"),
      ]),
    );
  });

  it("cuts over-long text itself, forces the source tag, and passes source caveats through once", async () => {
    const long = "y".repeat(REVIEW_TEXT_MAX_CHARS + 10);
    const a = fakeSource("app_store", (_q, _s, hooks) => {
      hooks?.caveats?.push(APPROXIMATE_DATE_CAVEAT);
      hooks?.caveats?.push(APPROXIMATE_DATE_CAVEAT);
      return Promise.resolve({ subject: { source: "app_store", name: "x" }, reviews: [review("app_store", "1", { text: long })] });
    });
    const { service } = make([a]);
    const out = await service.search(parsedInput());
    expect(out.reviews[0]?.text).toHaveLength(REVIEW_TEXT_MAX_CHARS);
    expect(out.reviews[0]?.truncated).toBe(true);
    expect(out.caveats.filter((c) => c === APPROXIMATE_DATE_CAVEAT)).toHaveLength(1);
  });

  it("rejects a source whose reviews fail the schema as a provider failure", async () => {
    const bad = fakeSource("app_store", () => Promise.resolve({ subject: { source: "app_store", name: "" }, reviews: [] }));
    const { service } = make([bad]);
    const err = await failure(service.search(parsedInput()));
    expect(err.code).toBe("provider");
    expect(err.message).toContain("fail the schema");
  });

  it("says so when nothing matched", async () => {
    const { service } = make([sourceWith("app_store", [])]);
    const out = await service.search(parsedInput());
    expect(out.reviews).toEqual([]);
    expect(out.caveats).toContain("No reviews matched this search.");
  });

  describe("summarize", () => {
    const summary = (ids: string[]) => ({
      text: `People like it [${ids[0]}] and dislike the price [${ids[1]}].`,
      themes: [
        { theme: "Ease of use", sentiment: "positive", item_ids: [ids[0], "app_store:made-up"] },
        { theme: "Price", sentiment: "negative", item_ids: [ids[1], ids[1]] },
      ],
    });

    it("writes a summary whose item_ids all exist, under the call's cost cap", async () => {
      const llm: RecordedLlm = scriptedLlm({ extractor: [(req: LlmRequest) => summary([...userText(req).matchAll(/id=(\S+)/g)].map((m) => m[1] as string))], costPerCall: 0.03 });
      const { service } = make([appStore(), trustpilot()], { llm });
      const out = await service.search(parsedInput({ sources: ["app_store", "trustpilot"], summarize: true, max_cost_usd: 0.25 }));
      expect(out.summary).toBeDefined();
      const known = new Set(out.reviews.map((r) => r.id));
      for (const theme of out.summary?.themes ?? []) {
        expect(theme.item_ids.length).toBeGreaterThan(0);
        for (const id of theme.item_ids) expect(known.has(id)).toBe(true);
      }
      expect(out.summary?.themes[0]?.item_ids).toEqual(["app_store:a1"]);
      expect(out.summary?.themes[1]?.item_ids).toEqual(["trustpilot:t1"]);
      expect(out.summary?.cost_usd).toBeCloseTo(0.03);
      const req = llm.requests[0];
      expect(req?.role).toBe("extractor");
      expect(req?.maxTokens).toBe(16_000);
      expect(req?.meter?.maxCostUsd).toBe(0.25);
      expect(userText(req as never)).toContain("app_store: app_store subject");
      expect(out.caveats.some((c) => /No summary/.test(c))).toBe(false);
    });

    it("still returns the reviews with a caveat when the LLM fails or is missing", async () => {
      const failing = scriptedLlm({ extractor: [], failures: () => new LlmError("provider", "api", "Claude API is down", { retryable: true }) });
      const a = make([appStore()], { llm: failing });
      const out = await a.service.search(parsedInput({ summarize: true }));
      expect(out.summary).toBeUndefined();
      expect(out.reviews).toHaveLength(2);
      expect(out.caveats).toContain("No summary: the Claude API call failed (Claude API is down).");

      const unset = scriptedLlm({ extractor: [], failures: () => new LlmError("config", "not_configured", "ANTHROPIC_API_KEY is not set", { retryable: false }) });
      const b = make([appStore()], { llm: unset });
      expect((await b.service.search(parsedInput({ summarize: true }))).caveats).toContain("No summary: ANTHROPIC_API_KEY is not set, so the summary step was skipped.");

      const c = make([appStore()]);
      expect((await c.service.search(parsedInput({ summarize: true }))).caveats).toContain("No summary: the Claude API client is not available.");

      const d = make([sourceWith("app_store", [])], { llm: scriptedLlm({ extractor: [summary(["x", "y"])] }) });
      expect((await d.service.search(parsedInput({ summarize: true }))).caveats).toContain("No summary: there are no reviews to summarise.");
    });

    it("turns a budget overrun on the summary into a caveat, not a failure", async () => {
      const spendy = scriptedLlm({ extractor: [summary(["app_store:a1", "app_store:a2"])], costPerCall: 0.3 });
      const a = fakeSource("app_store", async (_q, _s, hooks) => {
        // A source's own LLM use counts against the same meter.
        hooks?.meter?.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.3);
        return { subject: { source: "app_store", name: "x" }, reviews: [review("app_store", "a1")] };
      });
      const { service } = make([a], { llm: spendy });
      const out = await service.search(parsedInput({ summarize: true, max_cost_usd: 0.25 }));
      expect(out.summary).toBeUndefined();
      expect(out.caveats.some((c) => /^No summary: Cost cap of \$0\.25 reached/.test(c))).toBe(true);
      expect(spendy.requests).toHaveLength(1);
    });
  });
});
