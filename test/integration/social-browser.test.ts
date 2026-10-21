import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { buildBrowserSocialPlatforms, type BrowserSocialPlatforms } from "../../src/core/social/platforms/browser.js";
import { SocialItemSchema, type SocialSearchQuery } from "../../src/schemas/social.js";
import { SocialProviderError, type SocialPlatformProvider } from "../../src/core/social/types.js";
import { makeConfig, makeTempDir, removeDir } from "../unit/browser/helpers.js";

/**
 * Live X, Facebook and old.reddit through the browser social platforms. Gated:
 *   RUN_INTEGRATION=1 npx vitest run test/integration/social-browser.test.ts
 *
 * The test profile is a fresh temporary one, so it is logged out: X and
 * Facebook are expected to report `needsLogin` (or `blocked` from networks
 * the platforms refuse), old.reddit may answer anonymously from a home IP or
 * log the visitor out and block from a cloud IP. Each outcome is reported on
 * stderr; the assertion is that the platform answers with validated items or
 * a typed SocialProviderError, never anything else. No LLM key is needed: the
 * X and Reddit paths are deterministic and Facebook's LLM-only path reports
 * `config` honestly when ANTHROPIC_API_KEY is unset.
 */
const RUN = process.env["RUN_INTEGRATION"] === "1";

const QUERY: SocialSearchQuery = {
  mode: "search",
  query: "claude code",
  platforms: ["x", "facebook", "reddit"],
  kind: "posts",
  sort: "engagement",
  max_results: 10,
  per_platform: 5,
};

describe.skipIf(!RUN)(`social browser platforms against the live sites${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  let session: BrowserSession;
  let profileDir: string;
  let platforms: BrowserSocialPlatforms;

  beforeAll(async () => {
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
    platforms = buildBrowserSocialPlatforms({ browser: session, timeoutsMs: { x: 60_000, facebook: 60_000, reddit: 60_000 } });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  async function report(provider: SocialPlatformProvider): Promise<void> {
    const caveats: string[] = [];
    try {
      const items = await provider.search(QUERY, AbortSignal.timeout(90_000), { caveats });
      for (const i of items) expect(SocialItemSchema.safeParse(i).success).toBe(true);
      expect(items.length).toBeLessThanOrEqual(QUERY.per_platform);
      console.warn(`[social-browser] ${provider.name}: ${items.length} item(s)${caveats.length > 0 ? `; caveats: ${caveats.join(" | ")}` : ""}`);
    } catch (err) {
      expect(err).toBeInstanceOf(SocialProviderError);
      const e = err as SocialProviderError;
      expect(["blocked", "timeout", "provider", "config"]).toContain(e.code);
      if (e.needsLogin) expect(e.message).toMatch(new RegExp(`accounts connect ${provider.name}`));
      console.warn(`[social-browser] ${provider.name}: ${e.code}${e.needsLogin ? " (needs_login)" : ""}: ${e.message}`);
    }
  }

  it("x answers with items or a typed error (needs_login expected from a logged-out profile)", async () => {
    await report(platforms.x);
  }, 120_000);

  it("facebook answers with items or a typed error (needs_login or config expected)", async () => {
    await report(platforms.facebook);
  }, 120_000);

  it("old.reddit answers with items or a typed error", async () => {
    await report(platforms.redditBrowser);
  }, 120_000);
});
