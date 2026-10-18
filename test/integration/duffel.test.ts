import { describe, expect, it } from "vitest";
import { DuffelProvider } from "../../src/core/flights/providers/duffel.js";
import { FlightOfferSchema, type NormalizedFlightsQuery } from "../../src/schemas/flights.js";

/**
 * Real Duffel call. Runs only with RUN_INTEGRATION=1 and DUFFEL_API_KEY set,
 * and should be given a sandbox key (duffel_test_...): test mode returns
 * offers from the fictional "Duffel Airways" and is free.
 *
 *   RUN_INTEGRATION=1 DUFFEL_API_KEY=duffel_test_... npx vitest run test/integration/duffel.test.ts
 */
const apiKey = process.env["DUFFEL_API_KEY"];
const enabled = process.env["RUN_INTEGRATION"] === "1" && apiKey !== undefined && apiKey !== "";

function isoDate(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!enabled)("Duffel sandbox", () => {
  const provider = new DuffelProvider({ ...(apiKey !== undefined && { apiKey }) });

  it("returns valid, price-sorted round-trip offers", async () => {
    const query: NormalizedFlightsQuery = {
      origin: "LHR",
      destination: "JFK",
      depart_date: isoDate(30),
      return_date: isoDate(37),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: "economy",
      sources: ["duffel"],
      currency: "GBP",
    };
    const offers = await provider.search(query, AbortSignal.timeout(60_000));

    expect(offers.length).toBeGreaterThan(0);
    expect(offers.length).toBeLessThanOrEqual(30);
    for (const o of offers) {
      expect(FlightOfferSchema.safeParse(o).success).toBe(true);
      expect(o.source).toBe("duffel");
      expect(o.slices).toHaveLength(2);
    }
    const prices = offers.map((o) => o.price.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  }, 90_000);

  it("returns valid nonstop one-way offers", async () => {
    const offers = await provider.search(
      {
        origin: "LHR",
        destination: "JFK",
        depart_date: isoDate(30),
        passengers: { adults: 1, children: 0, infants: 0 },
        cabin: "economy",
        max_stops: 0,
        sources: ["duffel"],
        currency: "GBP",
      },
      AbortSignal.timeout(60_000),
    );
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(FlightOfferSchema.safeParse(o).success).toBe(true);
      expect(o.stops).toBe(0);
    }
  }, 90_000);
});
