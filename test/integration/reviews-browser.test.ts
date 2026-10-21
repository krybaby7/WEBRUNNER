import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { buildBrowserReviewSources } from "../../src/core/reviews/sources/browser.js";
import { ReviewSourceError, type ReviewSourceProvider } from "../../src/core/reviews/types.js";
import { ReviewSchema, type NormalizedReviewsQuery } from "../../src/schemas/reviews.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../unit/browser/helpers.js";

/**
 * Live browser review sources (RUN_INTEGRATION=1). Each site may block an
 * automated visitor, so a `blocked` (or `needs_login`) failure is an accepted
 * outcome; anything else must be a valid result. No LLM: the deterministic
 * probes alone are exercised.
 */
const run = process.env["RUN_INTEGRATION"] === "1";
const probe = run ? await probeChromium() : { available: false, reason: "RUN_INTEGRATION is not set" };

function query(over: Partial<NormalizedReviewsQuery>): NormalizedReviewsQuery {
  return { subject: "x", kind: "any", sources: ["google_maps"], max_results: 30, per_source: 10, sort: "relevance", app_store_country: "us", ...over };
}

describe.skipIf(!probe.available)("browser review sources, live", () => {
  let session: BrowserSession;
  let profileDir: string;
  let sources: ReviewSourceProvider[];

  beforeAll(async () => {
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
    sources = buildBrowserReviewSources({ browser: session });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  async function attempt(name: ReviewSourceProvider["name"], q: NormalizedReviewsQuery) {
    const source = sources.find((s) => s.name === name)!;
    const caveats: string[] = [];
    try {
      const result = await source.search(q, AbortSignal.timeout(90_000), { caveats });
      for (const r of result.reviews) expect(ReviewSchema.safeParse(r).success).toBe(true);
      console.warn(`[live ${name}] ${result.subject.name}: ${result.reviews.length} reviews; caveats: ${caveats.join(" | ")}`);
      return { result };
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewSourceError);
      const e = err as ReviewSourceError;
      console.warn(`[live ${name}] ${e.code}${e.needsLogin ? " (needs login)" : ""}: ${e.message}`);
      expect(["blocked", "timeout", "not_found", "config"]).toContain(e.code);
      return { error: e };
    }
  }

  it("google_maps: Hotel Lutetia Paris", async () => {
    const r = await attempt("google_maps", query({ subject: "Hotel Lutetia", location: "Paris", kind: "place", sources: ["google_maps"] }));
    if (r.result !== undefined) expect(r.result.subject.name).toMatch(/lutetia/i);
  }, 120_000);

  it("google_play: Notion", async () => {
    const r = await attempt("google_play", query({ subject: "Notion", kind: "app", sources: ["google_play"] }));
    if (r.result !== undefined) {
      expect(r.result.subject.name).toMatch(/notion/i);
      expect(r.result.reviews.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("amazon: Sony WH-1000XM5 (expected: blocked with needs_login for a signed-out profile)", async () => {
    const r = await attempt("amazon", query({ subject: "Sony WH-1000XM5", kind: "product", sources: ["amazon"], sort: "recent" }));
    if (r.error !== undefined && r.error.code === "blocked" && r.error.needsLogin) expect(r.error.message).toMatch(/accounts connect amazon/);
  }, 120_000);
});
