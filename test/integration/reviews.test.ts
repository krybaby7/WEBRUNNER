import { describe, expect, it } from "vitest";
import { AppStoreSource } from "../../src/core/reviews/sources/app-store.js";
import { TrustpilotSource } from "../../src/core/reviews/sources/trustpilot.js";
import { ReviewSourceError } from "../../src/core/reviews/types.js";
import { ReviewSchema, ReviewSubjectSchema, type NormalizedReviewsQuery } from "../../src/schemas/reviews.js";

/**
 * Real App Store and Trustpilot calls, keyless. Runs only with RUN_INTEGRATION=1:
 *
 *   RUN_INTEGRATION=1 npx vitest run test/integration/reviews.test.ts
 *
 * Trustpilot served an AWS WAF challenge from the development environment, so
 * its test accepts either a parsed page or a `blocked` failure (the browser and
 * LLM fallback are not wired here).
 */
const enabled = process.env["RUN_INTEGRATION"] === "1";

const base: NormalizedReviewsQuery = {
  subject: "Notion",
  kind: "app",
  sources: ["app_store"],
  max_results: 30,
  per_source: 12,
  sort: "relevance",
  app_store_country: "us",
};

describe.skipIf(!enabled)("App Store live", () => {
  it("finds Notion by name and returns valid recent reviews", async () => {
    const caveats: string[] = [];
    const out = await new AppStoreSource().search(base, AbortSignal.timeout(30_000), { caveats });
    expect(ReviewSubjectSchema.safeParse(out.subject).success).toBe(true);
    expect(out.subject.name).toMatch(/Notion/i);
    expect(out.reviews.length).toBeGreaterThan(0);
    expect(out.reviews.length).toBeLessThanOrEqual(12);
    for (const r of out.reviews) {
      expect(ReviewSchema.safeParse(r).success).toBe(true);
      expect(r.rating).toBeDefined();
      expect(r.version).toBeDefined();
    }
  }, 60_000);

  it("reads an app from its App Store URL", async () => {
    const url = "https://apps.apple.com/us/app/notion-notes-tasks-ai/id1232780281";
    const out = await new AppStoreSource().search({ ...base, subject: url, subject_url: url, per_source: 3 }, AbortSignal.timeout(30_000));
    expect(out.reviews).toHaveLength(3);
    expect(out.subject.url).toContain("id1232780281");
  }, 60_000);
});

describe.skipIf(!enabled)("Trustpilot live", () => {
  it("either parses the page or reports the bot wall as blocked", async () => {
    const url = "https://www.booking.com/";
    const outcome = await new TrustpilotSource()
      .search({ ...base, kind: "business", sources: ["trustpilot"], subject: url, subject_url: url }, AbortSignal.timeout(30_000))
      .then(
        (out) => ({ out }),
        (err: unknown) => ({ err }),
      );
    if ("out" in outcome) {
      expect(outcome.out.subject.name).toBeTruthy();
      for (const r of outcome.out.reviews) expect(ReviewSchema.safeParse(r).success).toBe(true);
    } else {
      expect(outcome.err).toBeInstanceOf(ReviewSourceError);
      expect((outcome.err as ReviewSourceError).code).toBe("blocked");
    }
  }, 60_000);
});
