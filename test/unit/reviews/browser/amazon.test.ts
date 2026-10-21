import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AMAZON_NEEDS_LOGIN_MESSAGE,
  amazonReviewsRecipe,
  amazonSortFor,
  buildAmazonReviewsUrl,
  buildAmazonSearchUrl,
  createAmazonReviewsRecipe,
  distributionFromPercentages,
  isAmazonUrl,
  parseAmazonAsin,
} from "../../../../src/core/browser/recipes/amazon-reviews.js";
import { RecipeError } from "../../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import { APPROXIMATE_DATE_CAVEAT } from "../../../../src/core/reviews/relative-date.js";
import { AmazonReviewSource } from "../../../../src/core/reviews/sources/amazon.js";
import { SubjectNotFoundError } from "../../../../src/core/reviews/sources/shared-browser.js";
import { ReviewSourceError } from "../../../../src/core/reviews/types.js";
import { ReviewSchema, ReviewSubjectSchema } from "../../../../src/schemas/reviews.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../../browser/helpers.js";
import { makeQuery, neverLlm, promptOf, runRecipe, scriptedLlm, startReviewsServer, type ReviewsFixtureServer } from "./helpers.js";

const probe = await probeChromium();

describe("Amazon URL helpers", () => {
  it("reads the ASIN from product, product-reviews and gp/product URLs on any amazon.* host", () => {
    expect(parseAmazonAsin("https://www.amazon.com/dp/B0B2FCT81R")).toBe("B0B2FCT81R");
    expect(parseAmazonAsin("https://www.amazon.com/Sony-WH-1000XM5/dp/B0B2FCT81R/ref=sr_1_1?keywords=x")).toBe("B0B2FCT81R");
    expect(parseAmazonAsin("https://www.amazon.de/gp/product/B0B2FCT81R")).toBe("B0B2FCT81R");
    expect(parseAmazonAsin("https://www.amazon.co.uk/product-reviews/B0B2FCT81R?pageNumber=2")).toBe("B0B2FCT81R");
    expect(parseAmazonAsin("https://www.amazon.com/s?k=Sony")).toBeUndefined();
    expect(parseAmazonAsin("https://example.com/dp/B0B2FCT81R")).toBeUndefined();
    expect(parseAmazonAsin(undefined)).toBeUndefined();
    expect(isAmazonUrl("https://amzn.to/abc")).toBe(true);
    expect(isAmazonUrl("https://www.amazonaws.com/x")).toBe(false);
  });

  it("builds the search and reviews URLs with the sort mapping of PLAN.md 14.6", () => {
    expect(buildAmazonSearchUrl("Sony WH-1000XM5")).toBe("https://www.amazon.com/s?k=Sony%20WH-1000XM5");
    expect(buildAmazonReviewsUrl("B0B2FCT81R", "recent")).toBe(
      "https://www.amazon.com/product-reviews/B0B2FCT81R?reviewerType=all_reviews&sortBy=recent&pageNumber=1",
    );
    expect(buildAmazonReviewsUrl("B0B2FCT81R", "relevance")).toContain("sortBy=helpful");
    expect(amazonSortFor("rating_low")).toBe("helpful");
    expect(amazonReviewsRecipe.buildUrl?.(makeQuery({ subject: "Sony" }))).toBe("https://www.amazon.com/s?k=Sony");
    expect(amazonReviewsRecipe.buildUrl?.(makeQuery({ subject: "https://www.amazon.com/dp/B0B2FCT81R", subject_url: "https://www.amazon.com/dp/B0B2FCT81R", sort: "recent" }))).toBe(
      buildAmazonReviewsUrl("B0B2FCT81R", "recent"),
    );
    expect(amazonReviewsRecipe.buildUrl?.(makeQuery({ subject: "https://example.com/x", subject_url: "https://example.com/x" }))).toBeNull();
  });

  it("derives histogram counts from percentages only when the total is known, and says so", () => {
    const caveats: string[] = [];
    const d = distributionFromPercentages({ percentages: { "1": 8, "2": 3, "3": 7, "4": 10, "5": 72 }, reviewCountText: "12,345 global ratings" }, (m) => caveats.push(m));
    expect(d).toEqual({ "1": 988, "2": 370, "3": 864, "4": 1235, "5": 8888 });
    expect(caveats).toHaveLength(1);
    expect(distributionFromPercentages({ percentages: { "1": 8, "2": 3, "3": 7, "4": 10, "5": 72 } }, () => undefined)).toBeUndefined();
    expect(distributionFromPercentages({ percentages: { "5": 72 }, reviewCountText: "100" }, () => undefined)).toBeUndefined();
  });
});

describe.skipIf(!probe.available)(`amazon-reviews recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: ReviewsFixtureServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startReviewsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  const recipe = (over: Parameters<typeof createAmazonReviewsRecipe>[0] = {}) =>
    createAmazonReviewsRecipe({ baseUrl: `${server.url}/amazon`, pollMs: 50, maxWaitMs: 8000, settleMs: 800, ...over });

  const amazonUrl = (asin: string) => `https://www.amazon.com/dp/${asin}`;

  it("searches, opens the reviews list sorted as asked and maps ratings, verified badges, helpful votes and absolute dates", async () => {
    const llm = neverLlm();
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Sony WH-1000XM5", kind: "product", sources: ["amazon"], sort: "recent" }), llm);
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
    expect(r.spy.forbidden).toEqual([]);
    expect(server.requests).toContain("GET /amazon/s?k=Sony%20WH-1000XM5");
    expect(server.requests).toContain("GET /amazon/product-reviews/B0B2FCT81R?reviewerType=all_reviews&sortBy=recent&pageNumber=1");

    const { subject, reviews } = r.result!;
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
    expect(subject).toMatchObject({
      source: "amazon",
      name: "Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones",
      rating_avg: 4.4,
      review_count: 12_345,
      rating_distribution: { "1": 988, "2": 370, "3": 864, "4": 1235, "5": 8888 },
    });
    expect(subject.url).toMatch(/\/dp\/B0B2FCT81R/);
    expect(r.caveats.some((c) => /rating_distribution/.test(c))).toBe(true);
    expect(r.caveats).not.toContain(APPROXIMATE_DATE_CAVEAT);

    expect(reviews).toHaveLength(10);
    for (const review of reviews) {
      expect(ReviewSchema.safeParse(review).success).toBe(true);
      expect(review.source).toBe("amazon");
      expect(review.id).toMatch(/^amazon:R[A-Z0-9]{14}$/);
      expect(review.created_at).toMatch(/T00:00:00\.000Z$/);
      expect(typeof review.verified).toBe("boolean");
      expect(review.title?.length).toBeGreaterThan(0);
    }
    const jordan = reviews[0]!;
    expect(jordan).toMatchObject({
      id: "amazon:R1A2B3C4D5E6F7G",
      author: "Jordan M.",
      rating: 5,
      title: "Best noise cancelling I have owned",
      created_at: "2026-03-03T00:00:00.000Z",
      helpful_votes: 128,
      verified: true,
      truncated: false,
    });
    expect(jordan.text).toMatch(/^Silence on a plane, finally\./);
    expect(jordan.url).toMatch(/\/gp\/customer-reviews\/R1A2B3C4D5E6F7G/);
    const amelia = reviews.find((x) => x.author === "Amelia Hart")!;
    expect(amelia).toMatchObject({ rating: 4, helpful_votes: 1, verified: true, created_at: "2026-02-14T00:00:00.000Z" });
    const rakesh = reviews.find((x) => x.author === "Rakesh")!;
    expect(rakesh).toMatchObject({ rating: 2, verified: false, helpful_votes: 41 });
    expect(reviews.find((x) => x.author === "Marcus T.")?.helpful_votes).toBeUndefined();
    expect(reviews.find((x) => x.author === "Tobias Lindqvist")).toMatchObject({ rating: 1, created_at: "2025-09-02T00:00:00.000Z" });
  });

  it("maps the sign-in redirect to blocked with needsLogin and the accounts hint", async () => {
    const llm = neverLlm();
    const r = await runRecipe(session, recipe(), makeQuery({ subject: amazonUrl("B0SIGNIN00"), subject_url: amazonUrl("B0SIGNIN00") }), llm);
    expect(r.error).toBeInstanceOf(RecipeError);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.message).toBe(AMAZON_NEEDS_LOGIN_MESSAGE);
    expect(err.message).toMatch(/accounts connect amazon/);
    expect(llm.calls).toHaveLength(0);
    expect(server.requests.some((x) => x.startsWith("GET /amazon/ap/signin"))).toBe(true);
  });

  it("maps the CAPTCHA page to blocked without needsLogin, on the reviews page and on the search page", async () => {
    const r = await runRecipe(session, recipe(), makeQuery({ subject: amazonUrl("B0CAPTCHA0"), subject_url: amazonUrl("B0CAPTCHA0") }), neverLlm());
    expect((r.error as RecipeError).code).toBe("blocked");
    expect((r.error as RecipeError).needsLogin).toBe(false);
    expect((r.error as RecipeError).message).toMatch(/CAPTCHA/);
    expect(r.spy.forbidden).toEqual([]);

    const search = await runRecipe(session, recipe(), makeQuery({ subject: "Captcha Headphones" }), neverLlm());
    expect((search.error as RecipeError).code).toBe("blocked");
    expect((search.error as RecipeError).needsLogin).toBe(false);
  });

  it("falls back to the LLM when the page has no review hooks", async () => {
    const llm = scriptedLlm((req) => {
      const text = promptOf(req);
      expect(text).toContain("Jordan M.");
      expect(text).toContain("Site: Amazon");
      return {
        subject: { name: "Sony WH-1000XM5", rating_avg: 4.4, review_count: 12345, address: null, categories: [], price_level: null },
        reviews: [
          { author: "Jordan M.", rating: 5, title: "Best noise cancelling I have owned", text: "Silence on a plane, finally.", date_text: "Reviewed in the United States on March 3, 2026", helpful_votes: 128, verified: true, response_text: null, response_date_text: null },
          { author: "Amelia Hart", rating: 4, title: "Great sound, slightly tight fit", text: "Warm, detailed sound.", date_text: "February 14, 2026", helpful_votes: 1, verified: true, response_text: null, response_date_text: null },
          { author: "Rakesh", rating: 2, title: "Hinge cracked after six months", text: "Sound is superb but the hinge cracked.", date_text: "January 28, 2026", helpful_votes: 41, verified: false, response_text: null, response_date_text: null },
        ],
      };
    });
    const r = await runRecipe(session, recipe(), makeQuery({ subject: amazonUrl("B0UNSTRUCT"), subject_url: amazonUrl("B0UNSTRUCT") }), llm);
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    expect(r.result!.reviews).toHaveLength(3);
    expect(r.result!.reviews[0]).toMatchObject({ author: "Jordan M.", rating: 5, verified: true, created_at: "2026-03-03T00:00:00.000Z", helpful_votes: 128 });
    expect(r.result!.reviews.every((x) => /^amazon:[0-9a-f]{12}$/.test(x.id))).toBe(true);
    expect(r.result!.subject).toMatchObject({ name: "Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones", rating_avg: 4.4, review_count: 12_345 });
  });

  it("returns an empty list with a caveat for a product without reviews", async () => {
    const r = await runRecipe(session, recipe(), makeQuery({ subject: amazonUrl("B0NOREVIEW"), subject_url: amazonUrl("B0NOREVIEW") }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.result!.reviews).toEqual([]);
    expect(r.result!.subject.name).toBe("Unreviewed Gadget");
    expect(r.caveats.some((c) => /no customer reviews/i.test(c))).toBe(true);
  });

  it("reports not found, HTTP 503 and timeout", async () => {
    const nothing = await runRecipe(session, recipe(), makeQuery({ subject: "Nothing Whatsoever" }), neverLlm());
    expect(nothing.error).toBeInstanceOf(SubjectNotFoundError);

    const other = await runRecipe(session, recipe(), makeQuery({ subject: "https://example.com/p", subject_url: "https://example.com/p" }), neverLlm());
    expect(other.error).toBeInstanceOf(SubjectNotFoundError);

    const down = await runRecipe(session, recipe(), makeQuery({ subject: amazonUrl("B0STATUS50"), subject_url: amazonUrl("B0STATUS50") }), neverLlm());
    expect((down.error as RecipeError).code).toBe("provider");
    expect((down.error as RecipeError).retryable).toBe(true);

    const t0 = Date.now();
    const stalled = await runRecipe(session, recipe(), makeQuery({ subject: amazonUrl("B0STALLED0"), subject_url: amazonUrl("B0STALLED0") }), neverLlm(), { deadline: Date.now() + 2500 });
    expect((stalled.error as RecipeError).code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("works through AmazonReviewSource, carrying needsLogin into the ReviewSourceError", async () => {
    const source = new AmazonReviewSource({ browser: session, recipe: recipe(), timeoutMs: 20_000 });
    const ok = await source.search(makeQuery({ subject: "Sony WH-1000XM5", per_source: 4 }), new AbortController().signal);
    expect(ok.reviews).toHaveLength(4);
    const err = (await source.search(makeQuery({ subject: amazonUrl("B0SIGNIN00"), subject_url: amazonUrl("B0SIGNIN00") }), new AbortController().signal).catch((e: unknown) => e)) as ReviewSourceError;
    expect(err).toBeInstanceOf(ReviewSourceError);
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.message).toMatch(/accounts connect amazon/);
  });
});
