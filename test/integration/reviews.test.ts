import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { AppStoreSource } from "../../src/core/reviews/sources/app-store.js";
import { TrustpilotSource } from "../../src/core/reviews/sources/trustpilot.js";
import { ReviewSourceError } from "../../src/core/reviews/types.js";
import { ReviewSchema, ReviewSubjectSchema, type NormalizedReviewsQuery } from "../../src/schemas/reviews.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../unit/browser/helpers.js";

/**
 * Real App Store and Trustpilot calls, keyless. Runs only with RUN_INTEGRATION=1:
 *
 *   RUN_INTEGRATION=1 npx vitest run test/integration/reviews.test.ts
 *
 * Trustpilot serves an AWS WAF challenge to raw requests from cloud IPs. The
 * first test runs without a browser and accepts either a parsed page or a
 * `blocked` failure; the second wires a headless Chromium, which renders the
 * page past the challenge, and expects reviews read from the embedded JSON with
 * no model (as on 2026-10-21 from a cloud session).
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

const chromium = enabled ? await probeChromium() : { available: false, reason: "RUN_INTEGRATION is not set" };

describe.skipIf(!enabled || !chromium.available)("Trustpilot live through the browser", () => {
  let session: BrowserSession;
  let profileDir: string;
  beforeAll(async () => {
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  });
  afterAll(async () => {
    await session?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  it("reads a bare domain's reviews from the rendered page with no model", async () => {
    const out = await new TrustpilotSource({ browser: session }).search(
      { ...base, kind: "business", sources: ["trustpilot"], subject: "notion.so", per_source: 5 },
      AbortSignal.timeout(60_000),
    );
    expect(out.subject.name).toMatch(/Notion/);
    expect(out.subject.rating_avg).toBeGreaterThan(0);
    expect(out.reviews.length).toBeGreaterThan(0);
    for (const r of out.reviews) {
      expect(ReviewSchema.safeParse(r).success).toBe(true);
      expect(r.rating).toBeDefined();
    }
  }, 90_000);
});
