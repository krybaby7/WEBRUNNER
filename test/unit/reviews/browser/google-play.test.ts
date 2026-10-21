import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGooglePlayDetailsUrl,
  buildGooglePlaySearchUrl,
  createGooglePlayReviewsRecipe,
  googlePlayReviewsRecipe,
  isGooglePlayUrl,
  parsePlayPackageId,
} from "../../../../src/core/browser/recipes/google-play-reviews.js";
import { RecipeError } from "../../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import { APPROXIMATE_DATE_CAVEAT } from "../../../../src/core/reviews/relative-date.js";
import { GooglePlayReviewSource } from "../../../../src/core/reviews/sources/google-play.js";
import { SubjectNotFoundError } from "../../../../src/core/reviews/sources/shared-browser.js";
import { ReviewSchema, ReviewSubjectSchema } from "../../../../src/schemas/reviews.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../../browser/helpers.js";
import { makeQuery, neverLlm, promptOf, runRecipe, scriptedLlm, startReviewsServer, type ReviewsFixtureServer } from "./helpers.js";

const probe = await probeChromium();

describe("Google Play URL helpers", () => {
  it("reads the package id from details URLs only", () => {
    expect(parsePlayPackageId("https://play.google.com/store/apps/details?id=notion.id&hl=en")).toBe("notion.id");
    expect(parsePlayPackageId("https://play.google.com/store/apps/details?id=com.cron.calendar")).toBe("com.cron.calendar");
    expect(parsePlayPackageId("https://play.google.com/store/search?q=Notion&c=apps")).toBeUndefined();
    expect(parsePlayPackageId("https://apps.apple.com/us/app/notion/id1232780281")).toBeUndefined();
    expect(parsePlayPackageId("https://play.google.com/store/apps/details?id=bad%20id")).toBeUndefined();
    expect(parsePlayPackageId(undefined)).toBeUndefined();
    expect(isGooglePlayUrl("https://play.google.com/store/apps/dev?id=1")).toBe(true);
    expect(isGooglePlayUrl("https://www.google.com/maps")).toBe(false);
  });

  it("builds the search and details URLs of PLAN.md 14.6", () => {
    expect(buildGooglePlaySearchUrl("Notion")).toBe("https://play.google.com/store/search?q=Notion&c=apps&hl=en");
    expect(buildGooglePlayDetailsUrl("notion.id")).toBe("https://play.google.com/store/apps/details?id=notion.id&hl=en&gl=us&showAllReviews=true");
    expect(googlePlayReviewsRecipe.buildUrl?.(makeQuery({ subject: "Notion" }))).toBe("https://play.google.com/store/search?q=Notion&c=apps&hl=en");
    const url = "https://play.google.com/store/apps/details?id=notion.id";
    expect(googlePlayReviewsRecipe.buildUrl?.(makeQuery({ subject: url, subject_url: url }))).toBe(buildGooglePlayDetailsUrl("notion.id"));
    expect(googlePlayReviewsRecipe.buildUrl?.(makeQuery({ subject: "https://example.com/x", subject_url: "https://example.com/x" }))).toBeNull();
  });
});

describe.skipIf(!probe.available)(`google-play-reviews recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
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

  const recipe = (over: Parameters<typeof createGooglePlayReviewsRecipe>[0] = {}) =>
    createGooglePlayReviewsRecipe({
      searchBaseUrl: `${server.url}/play/search`,
      detailsBaseUrl: `${server.url}/play/details`,
      pollMs: 50,
      maxWaitMs: 8000,
      expandWaitMs: 1500,
      ...over,
    });

  it("finds the app by name, opens the details page, expands all reviews and reads them with a developer response", async () => {
    const llm = neverLlm();
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Notion", kind: "app", sources: ["google_play"] }), llm);
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
    expect(r.spy.forbidden).toEqual([]);
    expect(server.requests).toContain("GET /play/search?q=Notion&c=apps&hl=en");
    expect(server.requests).toContain("GET /play/details?id=notion.id&hl=en&gl=us&showAllReviews=true");

    const { subject, reviews } = r.result!;
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
    expect(subject).toMatchObject({ source: "google_play", name: "Notion: AI Workspace", rating_avg: 4.6, review_count: 401_000 });
    expect(subject.categories).toEqual(["Productivity", "Developer: Notion Labs, Inc."]);
    expect(subject.url).toContain("/play/details?id=notion.id");

    // 3 cards on the page, 10 in the dialog after "See all reviews", 14 after one scroll (the same ids are deduped).
    expect(reviews).toHaveLength(14);
    for (const review of reviews) {
      expect(ReviewSchema.safeParse(review).success).toBe(true);
      expect(review.source).toBe("google_play");
      expect(review.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
    expect(r.caveats).not.toContain(APPROXIMATE_DATE_CAVEAT);

    const morgan = reviews[0]!;
    expect(morgan).toMatchObject({
      id: "google_play:b1bcf48a-2f1f-4625-a132-38ac06649c43",
      author: "Morgan Midnight",
      rating: 4,
      created_at: "2026-02-26T00:00:00.000Z",
      helpful_votes: 82,
      truncated: false,
    });
    expect(morgan.text).toMatch(/^This app is great for organization/);
    expect(morgan.response).toBeUndefined();

    const bay = reviews.find((x) => x.author === "Bay")!;
    expect(bay.rating).toBe(1);
    expect(bay.helpful_votes).toBe(350);
    expect(bay.created_at).toBe("2025-09-27T00:00:00.000Z");
    expect(bay.response).toEqual({
      text: "Thanks for the honest feedback. You can turn off Notion AI suggestions in Settings, and we are working on making that easier to find.",
      created_at: "2025-09-29T00:00:00.000Z",
    });
    const lea = reviews.find((x) => x.author === "Léa M.")!;
    expect(lea.response?.text).toMatch(/Version 1\.5/);
    expect(lea.response?.created_at).toBe("2026-05-02T00:00:00.000Z");
    expect(reviews.find((x) => x.author === "Jeff Moore")?.rating).toBe(5);
    expect(reviews.find((x) => x.author === "Yuki")?.helpful_votes).toBe(1);
  });

  it("skips the search when subject_url names the package", async () => {
    const before = server.requests.length;
    const url = "https://play.google.com/store/apps/details?id=notion.id";
    const r = await runRecipe(session, recipe(), makeQuery({ subject: url, subject_url: url, per_source: 3 }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.result!.reviews).toHaveLength(3);
    expect(server.requests.slice(before).some((x) => x.startsWith("GET /play/search"))).toBe(false);
  });

  it("falls back to the LLM when the cards have no review ids", async () => {
    const llm = scriptedLlm((req) => {
      const text = promptOf(req);
      expect(text).toContain("Morgan Midnight");
      expect(text).toContain("Site: Google Play");
      return {
        subject: { name: "Notion: AI Workspace", rating_avg: 4.6, review_count: 401000, address: null, categories: ["Productivity"], price_level: null },
        reviews: [
          { author: "Morgan Midnight", rating: 4, title: null, text: "This app is great for organization.", date_text: "February 26, 2026", helpful_votes: 82, verified: null, response_text: null, response_date_text: null },
          { author: "Bay", rating: 1, title: null, text: "This was a fantastic app until the AI rebrand.", date_text: "September 27, 2025", helpful_votes: 350, verified: null, response_text: "Thanks for the honest feedback.", response_date_text: "September 29, 2025" },
          { author: "Jeff Moore", rating: 5, title: null, text: "I love love love Notion.", date_text: "July 25, 2026", helpful_votes: 43, verified: null, response_text: null, response_date_text: null },
        ],
      };
    });
    const url = "https://play.google.com/store/apps/details?id=unstructured.app";
    const r = await runRecipe(session, recipe(), makeQuery({ subject: url, subject_url: url }), llm);
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    expect(r.result!.reviews).toHaveLength(3);
    expect(r.result!.reviews[1]?.response).toEqual({ text: "Thanks for the honest feedback.", created_at: "2025-09-29T00:00:00.000Z" });
    expect(r.result!.reviews.every((x) => /^google_play:[0-9a-f]{12}$/.test(x.id))).toBe(true);
    expect(r.result!.subject).toMatchObject({ name: "Notion: AI Workspace", rating_avg: 4.6, review_count: 401_000 });
    expect(r.spy.forbidden).toEqual([]);
  });

  it("reports blocked, not found and timeout", async () => {
    const blocked = await runRecipe(session, recipe(), makeQuery({ subject: "https://play.google.com/store/apps/details?id=blocked.app", subject_url: "https://play.google.com/store/apps/details?id=blocked.app" }), neverLlm());
    expect((blocked.error as RecipeError).code).toBe("blocked");

    const nothing = await runRecipe(session, recipe(), makeQuery({ subject: "Nothing At All" }), neverLlm());
    expect(nothing.error).toBeInstanceOf(SubjectNotFoundError);

    const missing = await runRecipe(session, recipe(), makeQuery({ subject: "https://play.google.com/store/apps/details?id=missing.app", subject_url: "https://play.google.com/store/apps/details?id=missing.app" }), neverLlm());
    expect(missing.error).toBeInstanceOf(SubjectNotFoundError);

    const other = await runRecipe(session, recipe(), makeQuery({ subject: "https://example.com/app", subject_url: "https://example.com/app" }), neverLlm());
    expect(other.error).toBeInstanceOf(SubjectNotFoundError);

    const t0 = Date.now();
    const stalled = await runRecipe(session, recipe(), makeQuery({ subject: "https://play.google.com/store/apps/details?id=stalled.app", subject_url: "https://play.google.com/store/apps/details?id=stalled.app" }), neverLlm(), { deadline: Date.now() + 2500 });
    expect((stalled.error as RecipeError).code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("works through GooglePlayReviewSource", async () => {
    const source = new GooglePlayReviewSource({ browser: session, recipe: recipe(), timeoutMs: 20_000 });
    const result = await source.search(makeQuery({ subject: "Notion", per_source: 5 }), new AbortController().signal);
    expect(result.reviews).toHaveLength(5);
    expect(result.subject.name).toBe("Notion: AI Workspace");
  });
});
