import { describe, expect, it } from "vitest";
import { RecipeError } from "../../../../src/core/browser/recipes/types.js";
import { LlmError } from "../../../../src/core/llm/types.js";
import { AmazonReviewSource } from "../../../../src/core/reviews/sources/amazon.js";
import { buildBrowserReviewSources } from "../../../../src/core/reviews/sources/browser.js";
import { GoogleMapsReviewSource } from "../../../../src/core/reviews/sources/google-maps.js";
import { GooglePlayReviewSource } from "../../../../src/core/reviews/sources/google-play.js";
import {
  BROWSER_SOURCE_DEFAULT_TIMEOUT_MS,
  ReviewSearchResultSchema,
  SubjectNotFoundError,
  assembleReview,
  assembleSubject,
  parseCount,
  parseHelpful,
  parseStarsLabel,
  parseStarsValue,
  reviewId,
  truncateReviewText,
  type ReviewsRecipe,
} from "../../../../src/core/reviews/sources/shared-browser.js";
import { ReviewSourceError, type ReviewSearchResult } from "../../../../src/core/reviews/types.js";
import { reviewId as normalizeReviewId, truncateReviewText as normalizeTruncate } from "../../../../src/core/reviews/normalize.js";
import { APPROXIMATE_DATE_CAVEAT } from "../../../../src/core/reviews/relative-date.js";
import { DEFAULT_SOURCES_BY_KIND, NormalizedReviewsQuerySchema, REVIEW_KINDS, REVIEW_TEXT_MAX_CHARS } from "../../../../src/schemas/reviews.js";
import { fakeBrowser, makeLogger, makeQuery, scriptedLlm } from "./helpers.js";

const never = (): AbortSignal => new AbortController().signal;

function fakeRecipe(run: ReviewsRecipe["run"]): ReviewsRecipe {
  return { site: "fake", paramsSchema: NormalizedReviewsQuerySchema, resultSchema: ReviewSearchResultSchema, run };
}

const SUBJECT = { source: "google_maps" as const, name: "Hôtel Lutetia" };
function review(n: number, over: Partial<ReviewSearchResult["reviews"][number]> = {}): ReviewSearchResult["reviews"][number] {
  return { id: `x:${n}`, source: "google_maps", text: `review ${n}`, truncated: false, ...over };
}

describe("buildBrowserReviewSources", () => {
  it("returns google_maps, google_play and amazon with the kinds of PLAN.md 14.6", () => {
    const sources = buildBrowserReviewSources({});
    expect(sources.map((s) => s.name)).toEqual(["google_maps", "google_play", "amazon"]);
    for (const s of sources) {
      const expected = REVIEW_KINDS.filter((k) => DEFAULT_SOURCES_BY_KIND[k].includes(s.name));
      expect([...s.defaultKinds]).toEqual(expected);
    }
    expect(sources.find((s) => s.name === "google_maps")?.defaultKinds).toEqual(["place", "business", "any"]);
    expect(sources.find((s) => s.name === "google_play")?.defaultKinds).toEqual(["app", "any"]);
    expect(sources.find((s) => s.name === "amazon")?.defaultKinds).toEqual(["product", "any"]);
  });

  it("is configured exactly when a browser session exists", () => {
    expect(buildBrowserReviewSources({}).every((s) => !s.isConfigured())).toBe(true);
    expect(buildBrowserReviewSources({ browser: fakeBrowser() }).every((s) => s.isConfigured())).toBe(true);
    expect(new GoogleMapsReviewSource().isConfigured()).toBe(false);
    expect(new GooglePlayReviewSource({ browser: fakeBrowser() }).isConfigured()).toBe(true);
    expect(new AmazonReviewSource({ browser: fakeBrowser() }).name).toBe("amazon");
  });

  it("fails with config when no browser is available", async () => {
    const err = await new AmazonReviewSource().search(makeQuery(), never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewSourceError);
    expect((err as ReviewSourceError).code).toBe("config");
    expect((err as ReviewSourceError).source).toBe("amazon");
  });
});

describe("BrowserReviewSourceBase", () => {
  it("acquires a page, gives the recipe a 60 s deadline by default, surfaces caveats, tags and cuts reviews, releases", async () => {
    const browser = fakeBrowser();
    const seen: { deadline?: number; meter?: unknown } = {};
    const source = new GoogleMapsReviewSource({
      browser,
      recipe: fakeRecipe(async (page, q, ctx) => {
        expect(page).toBe(browser.page);
        seen.deadline = ctx.deadline;
        seen.meter = ctx.meter;
        ctx.caveats?.push("a note");
        return { subject: { source: "amazon", name: "mislabelled" }, reviews: Array.from({ length: q.per_source + 3 }, (_, i) => review(i, { source: "amazon" })) };
      }),
    });
    const before = Date.now();
    const hooks = { caveats: [] as string[] };
    const result = await source.search(makeQuery({ per_source: 4 }), never(), hooks);
    expect(seen.deadline! - before).toBeGreaterThanOrEqual(BROWSER_SOURCE_DEFAULT_TIMEOUT_MS);
    expect(seen.deadline! - before).toBeLessThan(BROWSER_SOURCE_DEFAULT_TIMEOUT_MS + 1500);
    expect(seen.meter).toBeUndefined();
    expect(hooks.caveats).toEqual(["a note"]);
    expect(result.subject.source).toBe("google_maps");
    expect(result.reviews).toHaveLength(4);
    expect(result.reviews.every((r) => r.source === "google_maps")).toBe(true);
    expect(browser.release).toHaveBeenCalledWith(browser.page);
    expect(BROWSER_SOURCE_DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it("honours timeoutMs and the per-source override of buildBrowserReviewSources", async () => {
    let deadline = 0;
    const recipe = fakeRecipe(async (_p, _q, ctx) => {
      deadline = ctx.deadline;
      return { subject: SUBJECT, reviews: [] };
    });
    const before = Date.now();
    await new GoogleMapsReviewSource({ browser: fakeBrowser(), recipe, timeoutMs: 12_345 }).search(makeQuery(), never());
    expect(deadline - before).toBeGreaterThanOrEqual(12_345);
    expect(deadline - before).toBeLessThan(13_500);
  });

  it("maps a RecipeError onto ReviewSourceError, keeping code, retryable and needsLogin", async () => {
    const browser = fakeBrowser();
    const source = new AmazonReviewSource({
      browser,
      recipe: fakeRecipe(async () => {
        throw new RecipeError("blocked", "Amazon shows reviews only to signed-in visitors; run accounts connect amazon", { needsLogin: true });
      }),
    });
    const hooks = { caveats: [] as string[] };
    const err = (await source.search(makeQuery(), never(), hooks).catch((e: unknown) => e)) as ReviewSourceError;
    expect(err).toBeInstanceOf(ReviewSourceError);
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/accounts connect amazon/);
    expect(err.source).toBe("amazon");
    expect(browser.release).toHaveBeenCalled();

    const plain = (await new AmazonReviewSource({
      browser,
      recipe: fakeRecipe(async () => {
        throw new RecipeError("blocked", "captcha");
      }),
    })
      .search(makeQuery(), never())
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(plain.code).toBe("blocked");
    expect(plain.needsLogin).toBe(false);

    const timeout = (await new AmazonReviewSource({
      browser,
      recipe: fakeRecipe(async () => {
        throw new RecipeError("timeout", "slow");
      }),
    })
      .search(makeQuery(), never())
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(timeout.code).toBe("timeout");
    expect(timeout.retryable).toBe(true);
  });

  it("maps SubjectNotFoundError onto not_found and LlmError onto its own code", async () => {
    const browser = fakeBrowser();
    const notFound = (await new GooglePlayReviewSource({
      browser,
      recipe: fakeRecipe(async () => {
        throw new SubjectNotFoundError("no app matched");
      }),
    })
      .search(makeQuery(), never())
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(notFound.code).toBe("not_found");
    expect(notFound.retryable).toBe(false);

    const llm = (await new GooglePlayReviewSource({
      browser,
      recipe: fakeRecipe(async () => {
        throw new LlmError("budget_exceeded", "api", "over budget", { retryable: false });
      }),
    })
      .search(makeQuery(), never())
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(llm).toBeInstanceOf(ReviewSourceError);
    expect(llm.code).toBe("provider");
    expect(llm.message).toBe("over budget");

    const config = (await new GooglePlayReviewSource({
      browser,
      recipe: fakeRecipe(async () => {
        throw new LlmError("config", "not_configured", "no key", { retryable: false });
      }),
    })
      .search(makeQuery(), never())
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(config.code).toBe("config");
  });

  it("gives the recipe a config-failing LLM when none is configured, and passes the meter from hooks", async () => {
    const browser = fakeBrowser();
    let llmError: unknown;
    const meter = { check: () => undefined } as never;
    const source = new GoogleMapsReviewSource({
      browser,
      recipe: fakeRecipe(async (_p, _q, ctx) => {
        expect(ctx.meter).toBe(meter);
        llmError = await ctx.llm.complete({ role: "extractor", system: "", messages: [] }).catch((e: unknown) => e);
        throw llmError;
      }),
    });
    const err = (await source.search(makeQuery(), never(), { meter }).catch((e: unknown) => e)) as ReviewSourceError;
    expect(llmError).toBeInstanceOf(RecipeError);
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("passes the configured LLM through", async () => {
    const llm = scriptedLlm(() => ({ ok: true }));
    const source = new GoogleMapsReviewSource({
      browser: fakeBrowser(),
      llm,
      recipe: fakeRecipe(async (_p, _q, ctx) => {
        await ctx.llm.complete({ role: "extractor", system: "s", messages: [{ role: "user", content: "x" }] });
        return { subject: SUBJECT, reviews: [review(1)] };
      }),
    });
    const r = await source.search(makeQuery(), never());
    expect(llm.calls).toHaveLength(1);
    expect(r.reviews).toHaveLength(1);
  });

  it("closes the page on abort and reports timeout", async () => {
    const browser = fakeBrowser();
    const controller = new AbortController();
    const source = new GoogleMapsReviewSource({
      browser,
      recipe: fakeRecipe(
        (_p, _q, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => reject(new Error("Target page, context or browser has been closed")));
          }),
      ),
    });
    const pending = source.search(makeQuery(), controller.signal);
    setTimeout(() => controller.abort(), 20);
    const err = (await pending.catch((e: unknown) => e)) as ReviewSourceError;
    expect(err.code).toBe("timeout");
    expect(browser.page.close).toHaveBeenCalled();
    expect(browser.release).toHaveBeenCalled();
  });

  it("rejects at once when the signal is already aborted", async () => {
    const browser = fakeBrowser();
    const controller = new AbortController();
    controller.abort();
    const err = (await new AmazonReviewSource({ browser, recipe: fakeRecipe(async () => ({ subject: SUBJECT, reviews: [] })) })
      .search(makeQuery(), controller.signal)
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(err.code).toBe("timeout");
    expect(browser.acquire).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipe result with a provider error", async () => {
    const source = new AmazonReviewSource({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async () => ({ subject: { source: "amazon", name: "" }, reviews: [] })),
    });
    const err = (await source.search(makeQuery(), never()).catch((e: unknown) => e)) as ReviewSourceError;
    expect(err.code).toBe("provider");
    expect(err.message).toMatch(/invalid result/);
  });

  it("surfaces a failed acquire as a retryable provider error", async () => {
    const browser = fakeBrowser();
    browser.acquire.mockRejectedValue(new Error("pool exhausted"));
    const err = (await new AmazonReviewSource({ browser, recipe: fakeRecipe(async () => ({ subject: SUBJECT, reviews: [] })) })
      .search(makeQuery(), never())
      .catch((e: unknown) => e)) as ReviewSourceError;
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(true);
  });
});

describe("review assembly helpers", () => {
  const now = Date.parse("2026-10-21T12:00:00.000Z");

  it("parses star labels in the forms the three sites print", () => {
    expect(parseStarsLabel("4 stars")).toBe(4);
    expect(parseStarsLabel("1 star")).toBe(1);
    expect(parseStarsLabel("Rated 4 stars out of five stars")).toBe(4);
    expect(parseStarsLabel("4.0 out of 5 stars")).toBe(4);
    expect(parseStarsLabel("4.6 stars")).toBe(4.5);
    expect(parseStarsLabel("4,5 Sterne")).toBe(4.5);
    expect(parseStarsLabel("Rated 4.6 stars out of five stars")).toBe(4.5);
    expect(parseStarsValue("Rated 4.6 stars out of five stars")).toBe(4.6);
    expect(parseStarsValue("4.4 out of 5")).toBe(4.4);
    expect(parseStarsLabel("Photo of Jane")).toBeUndefined();
    expect(parseStarsLabel("12 reviews")).toBeUndefined();
    expect(parseStarsLabel(undefined)).toBeUndefined();
  });

  it("parses counts and helpful votes", () => {
    expect(parseCount("401K reviews")).toBe(401_000);
    expect(parseCount("1.2M")).toBe(1_200_000);
    expect(parseCount("12,345 global ratings")).toBe(12_345);
    expect(parseCount("(1,234)")).toBe(1234);
    expect(parseCount("4 months")).toBe(4);
    expect(parseCount("no digits")).toBeUndefined();
    expect(parseHelpful("128 people found this helpful")).toBe(128);
    expect(parseHelpful("One person found this helpful")).toBe(1);
    expect(parseHelpful("3 likes")).toBe(3);
    expect(parseHelpful("Like")).toBeUndefined();
  });

  it("builds ids from the native id or a 12-hex hash of author and text (the one helper every source uses)", () => {
    expect(reviewId("amazon", "R1A2B3C4D5E6F7G", "x\ny")).toBe("amazon:R1A2B3C4D5E6F7G");
    expect(reviewId("google_maps", undefined, "Marie D.\nLovely")).toMatch(/^google_maps:[0-9a-f]{12}$/);
    expect(reviewId("google_maps", "", "Marie D.\nLovely")).toBe(reviewId("google_maps", undefined, "Marie D.\nLovely"));
    expect(reviewId("google_maps", undefined, "Marie D.\nLovely")).not.toBe(reviewId("google_maps", undefined, "Tom\nLovely"));
    expect(reviewId("google_maps", "has spaces in it", "a\nb")).toMatch(/^google_maps:[0-9a-f]{12}$/);
    expect(reviewId).toBe(normalizeReviewId);
    expect(truncateReviewText).toBe(normalizeTruncate);
  });

  it("truncates text at REVIEW_TEXT_MAX_CHARS and flags it", () => {
    const long = "word ".repeat(1000);
    const cut = truncateReviewText(long);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(REVIEW_TEXT_MAX_CHARS);
    expect(truncateReviewText("  short\n\n\n\ntext  ")).toEqual({ text: "short\n\ntext", truncated: false });
  });

  it("assembles a review, approximating relative dates with the caveat pushed once", () => {
    const caveats: string[] = [];
    const caveat = (m: string): void => {
      if (!caveats.includes(m)) caveats.push(m);
    };
    const r = assembleReview(
      "google_maps",
      { nativeId: "abc", author: " Marie  D. ", ratingLabel: "5 stars", text: "Great", dateText: "2 months ago", helpfulText: "3 likes", responseText: "Thanks", responseDateText: "a month ago", url: "https://www.google.com/maps/contrib/1/reviews" },
      { nowMs: now, caveat },
    );
    expect(r).toMatchObject({ id: "google_maps:abc", author: "Marie D.", rating: 5, text: "Great", truncated: false, helpful_votes: 3, url: "https://www.google.com/maps/contrib/1/reviews" });
    expect(r?.created_at).toBe(new Date(now - 60 * 86_400_000).toISOString());
    expect(r?.response).toEqual({ text: "Thanks", created_at: new Date(now - 30 * 86_400_000).toISOString() });
    expect(caveats).toEqual([APPROXIMATE_DATE_CAVEAT]);
    assembleReview("google_maps", { text: "Another", dateText: "a day ago" }, { nowMs: now, caveat });
    expect(caveats).toEqual([APPROXIMATE_DATE_CAVEAT]);
    expect(assembleReview("amazon", { author: "x" }, { nowMs: now, caveat })).toBeUndefined();
    const exact = assembleReview("amazon", { text: "ok", dateText: "Reviewed in the United States on March 3, 2026", verified: true }, { nowMs: now, caveat: () => undefined });
    expect(exact?.created_at).toBe("2026-03-03T00:00:00.000Z");
    expect(exact?.verified).toBe(true);
  });

  it("assembles a subject, keeping tenths for the average and falling back to the query subject", () => {
    const s = assembleSubject("google_play", { name: "Notion: AI Workspace", ratingLabel: "Rated 4.6 stars out of five stars", reviewCountText: "401K reviews", categories: ["Productivity", " Productivity "], url: "https://play.google.com/store/apps/details?id=notion.id" }, "Notion");
    expect(s).toEqual({ source: "google_play", name: "Notion: AI Workspace", url: "https://play.google.com/store/apps/details?id=notion.id", rating_avg: 4.6, review_count: 401_000, categories: ["Productivity"] });
    expect(assembleSubject("amazon", {}, "Sony WH-1000XM5")).toEqual({ source: "amazon", name: "Sony WH-1000XM5" });
    expect(assembleSubject("amazon", { distribution: { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 } }, "x").rating_distribution).toEqual({ "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 });
    expect(assembleSubject("amazon", { distribution: { "1": 1 } }, "x").rating_distribution).toBeUndefined();
  });
});

describe("makeLogger", () => {
  it("records", () => {
    const log = makeLogger();
    log.info("x");
    expect(log.info).toHaveBeenCalledWith("x");
  });
});
