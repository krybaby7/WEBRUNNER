import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { GoogleFlightsProvider } from "../../src/core/flights/providers/google-flights.js";
import { FlightProviderError } from "../../src/core/flights/types.js";
import { createLlmClient } from "../../src/core/llm/index.js";
import type { LlmClient } from "../../src/core/llm/types.js";
import { FlightOfferSchema, type NormalizedFlightsQuery } from "../../src/schemas/flights.js";
import { makeConfig, makeTempDir, removeDir } from "../unit/browser/helpers.js";
import { labelReadingLlm } from "../unit/flights/gf-helpers.js";

/**
 * Real Google Flights search through a real browser. Gated:
 *
 *   RUN_INTEGRATION=1 npx vitest run test/integration/google-flights.test.ts
 *
 * Extraction uses the real extractor model when ANTHROPIC_API_KEY is set.
 * Without a key the test reads each result label with the deterministic
 * `labelReadingLlm` from the unit-test helpers instead, so the live page,
 * the recipe and the offer assembly are still exercised; it prints which one ran.
 *
 * Two outcomes are acceptable and the test prints which one happened:
 *   - at least 5 valid offers, or
 *   - a clean `blocked` error (Google may block datacenter IPs or rate-limit).
 */
const RUN = process.env["RUN_INTEGRATION"] === "1";

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!RUN)(`Google Flights, live${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  let session: BrowserSession;
  let profileDir: string;
  let llm: LlmClient;
  let extractor: string;

  beforeAll(async () => {
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
    const key = process.env["ANTHROPIC_API_KEY"];
    if (key !== undefined && key !== "") {
      llm = createLlmClient(loadConfig());
      extractor = "real extractor model";
    } else {
      llm = labelReadingLlm();
      extractor = "deterministic label reader (ANTHROPIC_API_KEY is not set)";
    }
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  it("returns at least 5 offers for LHR to JFK 30 days out, or a clean blocked error", async () => {
    const query: NormalizedFlightsQuery = {
      origin: "LHR",
      destination: "JFK",
      depart_date: isoDate(30),
      return_date: isoDate(37),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: "economy",
      sources: ["google_flights"],
      currency: "USD",
    };
    const provider = new GoogleFlightsProvider({ browser: session, llm, timeoutMs: 90_000 });
    const caveats: string[] = [];
    let offers;
    try {
      offers = await provider.search(query, AbortSignal.timeout(120_000), { caveats });
    } catch (err) {
      // Anything but a clean block is a real failure: rethrow it so its message is visible.
      if (!(err instanceof FlightProviderError) || err.code !== "blocked") throw err;
      console.warn(`[google-flights integration] OUTCOME: blocked by Google (${(err as Error).message}); acceptable.`);
      return;
    }
    console.warn(
      `[google-flights integration] OUTCOME: ${offers.length} offers via ${extractor}; cheapest ${JSON.stringify(offers[0]?.price)}; caveats: ${JSON.stringify(caveats)}`,
    );
    expect(offers.length).toBeGreaterThanOrEqual(5);
    for (const o of offers) {
      expect(FlightOfferSchema.safeParse(o).success).toBe(true);
      expect(o.source).toBe("google_flights");
      expect(o.itinerary).toBe("outbound_only");
    }
    expect(offers.map((o) => o.price.amount)).toEqual([...offers.map((o) => o.price.amount)].sort((a, b) => a - b));
    expect(session.stats().activePages).toBe(0);
  }, 150_000);
});
