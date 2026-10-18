import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { GoogleHotelsProvider } from "../../src/core/hotels/providers/google-hotels.js";
import { HotelProviderError } from "../../src/core/hotels/types.js";
import { createLlmClient } from "../../src/core/llm/index.js";
import type { LlmClient } from "../../src/core/llm/types.js";
import { HotelResultSchema, type NormalizedHotelsQuery } from "../../src/schemas/hotels.js";
import { makeConfig, makeTempDir, removeDir } from "../unit/browser/helpers.js";

/**
 * Real Google Hotels search through a real browser. Gated:
 *
 *   RUN_INTEGRATION=1 npx vitest run test/integration/google-hotels.test.ts
 *
 * The deterministic DOM probe needs no model; the extractor fallback uses the
 * real model when ANTHROPIC_API_KEY is set and is absent otherwise (a page the
 * probe cannot read then fails with `config`, which this test reports).
 *
 * Acceptable outcomes, printed by the test:
 *   - at least 5 valid hotels with a name and a nightly price, or
 *   - a clean `blocked` error (Google may block datacenter IPs or rate-limit).
 */
const RUN = process.env["RUN_INTEGRATION"] === "1";

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!RUN)(`Google Hotels, live${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  let session: BrowserSession;
  let profileDir: string;
  let llm: LlmClient | undefined;

  beforeAll(async () => {
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
    const key = process.env["ANTHROPIC_API_KEY"];
    llm = key !== undefined && key !== "" ? createLlmClient(loadConfig()) : undefined;
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  it("returns at least 5 hotels for Paris 30 days out, or a clean blocked error", async () => {
    const query: NormalizedHotelsQuery = {
      destination: "Paris",
      check_in: isoDate(30),
      check_out: isoDate(33),
      nights: 3,
      guests: { adults: 2, children: 0 },
      sort: "relevance",
      sources: ["google_hotels"],
      currency: "USD",
      max_results: 20,
    };
    const provider = new GoogleHotelsProvider({ browser: session, ...(llm !== undefined && { llm }), timeoutMs: 90_000 });
    const caveats: string[] = [];
    let hotels;
    try {
      hotels = await provider.search(query, AbortSignal.timeout(120_000), { caveats });
    } catch (err) {
      // Anything but a clean block is a real failure: rethrow it so its message is visible.
      if (!(err instanceof HotelProviderError) || err.code !== "blocked") throw err;
      console.warn(`[google-hotels integration] OUTCOME: blocked by Google (${(err as Error).message}); acceptable.`);
      return;
    }
    const organic = hotels.filter((h) => !h.tags.includes("Sponsored"));
    console.warn(
      `[google-hotels integration] OUTCOME: ${hotels.length} hotels (${organic.length} organic) via ${caveats.some((c) => /extraction model/.test(c)) ? "the extractor" : "the DOM probe"}; first ${JSON.stringify({ name: hotels[0]?.name, price: hotels[0]?.price_per_night, total: hotels[0]?.total_price, rating: hotels[0]?.rating })}; rated ${hotels.filter((h) => h.rating !== undefined).length}; caveats: ${JSON.stringify(caveats)}`,
    );
    expect(hotels.length).toBeGreaterThanOrEqual(5);
    for (const h of hotels) {
      expect(HotelResultSchema.safeParse(h).success).toBe(true);
      expect(h.source).toBe("google_hotels");
    }
    expect(hotels.filter((h) => h.price_per_night !== undefined).length).toBeGreaterThanOrEqual(5);
    expect(session.stats().activePages).toBe(0);
  }, 150_000);
});
