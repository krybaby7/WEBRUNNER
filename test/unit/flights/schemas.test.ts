import { describe, expect, it } from "vitest";
import {
  FlightOfferSchema,
  FlightSourceSchema,
  FlightsInputError,
  IataCodeSchema,
  NormalizedFlightsQuerySchema,
  SearchFlightsInputSchema,
  SearchFlightsOutputSchema,
  isRealCalendarDate,
  normalizeFlightsInput,
} from "../../../src/schemas/flights.js";

const validInput = {
  origin: "London",
  destination: "JFK",
  depart_date: "2026-12-01",
};

const validOffer = {
  id: "off_1",
  source: "duffel",
  price: { amount: 538.4, currency: "GBP" },
  total_duration_min: 480,
  stops: 0,
  slices: [
    {
      segments: [
        {
          airline: "BA",
          airline_name: "British Airways",
          flight_number: "BA117",
          depart_airport: "LHR",
          depart_at: "2026-12-01T09:30:00",
          arrive_airport: "JFK",
          arrive_at: "2026-12-01T12:30:00-05:00",
          duration_min: 480,
        },
      ],
      layovers: [],
    },
  ],
};

describe("SearchFlightsInputSchema", () => {
  it("accepts a valid one-way input and applies cabin and passenger defaults", () => {
    const parsed = SearchFlightsInputSchema.parse(validInput);
    expect(parsed.cabin).toBe("economy");
    expect(parsed.passengers).toEqual({ adults: 1, children: 0, infants: 0 });
    expect(parsed.return_date).toBeUndefined();
  });

  it("accepts a full round-trip input", () => {
    const parsed = SearchFlightsInputSchema.parse({
      origin: "LHR",
      destination: "New York",
      depart_date: "2026-12-01",
      return_date: "2026-12-08",
      passengers: { adults: 2, children: 1, infants: 1 },
      cabin: "premium_economy",
      max_stops: 1,
      sources: ["duffel", "google_flights"],
      currency: "eur",
    });
    expect(parsed.currency).toBe("EUR");
    expect(parsed.passengers.adults).toBe(2);
  });

  it("accepts a same-day return", () => {
    expect(
      SearchFlightsInputSchema.safeParse({ ...validInput, return_date: "2026-12-01" }).success,
    ).toBe(true);
  });

  it.each([
    ["wrong separator", "2026/12/01"],
    ["day-first", "01-12-2026"],
    ["no zero padding", "2026-1-5"],
    ["datetime", "2026-12-01T10:00:00Z"],
    ["month 13", "2026-13-01"],
    ["day 0", "2026-12-00"],
    ["Feb 30", "2026-02-30"],
    ["Feb 29 in a non-leap year", "2027-02-29"],
    ["April 31", "2026-04-31"],
    ["empty", ""],
  ])("rejects a bad depart_date (%s)", (_label, value) => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, depart_date: value }).success).toBe(false);
  });

  it("accepts Feb 29 in a leap year", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, depart_date: "2028-02-29" }).success).toBe(true);
  });

  it("rejects a return_date before depart_date", () => {
    const r = SearchFlightsInputSchema.safeParse({ ...validInput, return_date: "2026-11-30" });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid return_date", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, return_date: "2026-02-30" }).success).toBe(false);
  });

  it("rejects an invalid cabin", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, cabin: "luxury" }).success).toBe(false);
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, cabin: "Economy" }).success).toBe(false);
  });

  it("rejects max_stops outside 0, 1, 2", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, max_stops: 3 }).success).toBe(false);
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, max_stops: -1 }).success).toBe(false);
  });

  it("rejects unknown sources and an empty sources list", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, sources: ["kayak"] }).success).toBe(false);
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, sources: [] }).success).toBe(false);
  });

  it("rejects a malformed currency", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, currency: "US" }).success).toBe(false);
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, currency: "DOLLARS" }).success).toBe(false);
  });

  it("rejects empty places", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, origin: "  " }).success).toBe(false);
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, destination: "" }).success).toBe(false);
  });

  it("rejects impossible passenger mixes", () => {
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, passengers: { adults: 0 } }).success).toBe(false);
    expect(
      SearchFlightsInputSchema.safeParse({ ...validInput, passengers: { adults: 1, infants: 2 } }).success,
    ).toBe(false);
    expect(
      SearchFlightsInputSchema.safeParse({ ...validInput, passengers: { adults: 5, children: 5 } }).success,
    ).toBe(false);
    expect(SearchFlightsInputSchema.safeParse({ ...validInput, passengers: { adults: 1.5 } }).success).toBe(false);
  });
});

describe("isRealCalendarDate", () => {
  it("checks the real calendar", () => {
    expect(isRealCalendarDate("2026-02-28")).toBe(true);
    expect(isRealCalendarDate("2026-02-30")).toBe(false);
    expect(isRealCalendarDate("2026-12-31")).toBe(true);
    expect(isRealCalendarDate("0099-01-01")).toBe(false);
    expect(isRealCalendarDate("not a date")).toBe(false);
  });
});

describe("IataCodeSchema and NormalizedFlightsQuerySchema", () => {
  it.each(["LHR", "NYC", "JFK"])("accepts %s", (code) => {
    expect(IataCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each(["lhr", "LH", "LHRX", "L1R", "LON ", "", "L R"])("rejects %j", (code) => {
    expect(IataCodeSchema.safeParse(code).success).toBe(false);
  });

  it("requires IATA codes in the normalized query", () => {
    const base = {
      origin: "LON",
      destination: "NYC",
      depart_date: "2026-12-01",
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: "economy",
      sources: ["duffel"],
      currency: "USD",
    };
    expect(NormalizedFlightsQuerySchema.safeParse(base).success).toBe(true);
    expect(NormalizedFlightsQuerySchema.safeParse({ ...base, origin: "London" }).success).toBe(false);
    expect(NormalizedFlightsQuerySchema.safeParse({ ...base, destination: "jfk" }).success).toBe(false);
    expect(NormalizedFlightsQuerySchema.safeParse({ ...base, currency: "usd" }).success).toBe(false);
  });
});

describe("FlightSourceSchema", () => {
  it("is exactly google_flights and duffel", () => {
    expect(FlightSourceSchema.options).toEqual(["google_flights", "duffel"]);
  });
});

describe("normalizeFlightsInput", () => {
  it("applies defaults and takes currency from config", () => {
    const q = normalizeFlightsInput({ origin: "lhr", destination: "jfk", depart_date: "2026-12-01" }, { currency: "GBP" });
    expect(q).toEqual({
      origin: "LHR",
      destination: "JFK",
      depart_date: "2026-12-01",
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: "economy",
      sources: ["google_flights", "duffel"],
      currency: "GBP",
    });
  });

  it("prefers the input currency over config and uppercases it", () => {
    const q = normalizeFlightsInput({ ...validInput, origin: "LHR", currency: "eur" }, { currency: "GBP" });
    expect(q.currency).toBe("EUR");
  });

  it("keeps explicit values, drops duplicate sources, and defaults sources to the configured ones", () => {
    const q = normalizeFlightsInput(
      {
        origin: "LHR",
        destination: "CDG",
        depart_date: "2026-12-01",
        return_date: "2026-12-05",
        passengers: { adults: 2 },
        cabin: "business",
        max_stops: 0,
        sources: ["duffel", "duffel"],
      },
      { currency: "USD" },
    );
    expect(q.sources).toEqual(["duffel"]);
    expect(q.passengers).toEqual({ adults: 2, children: 0, infants: 0 });
    expect(q.return_date).toBe("2026-12-05");
    expect(q.max_stops).toBe(0);
    expect(q.cabin).toBe("business");

    const q2 = normalizeFlightsInput(
      { origin: "LHR", destination: "CDG", depart_date: "2026-12-01" },
      { currency: "USD" },
      { defaultSources: ["duffel"] },
    );
    expect(q2.sources).toEqual(["duffel"]);
  });

  it("uses an injected resolver for city names", () => {
    const resolve = (p: string) => ({ London: "LON", "New York": "NYC" })[p];
    const q = normalizeFlightsInput(
      { origin: "London", destination: "New York", depart_date: "2026-12-01" },
      { currency: "USD" },
      { resolve },
    );
    expect([q.origin, q.destination]).toEqual(["LON", "NYC"]);
  });

  it("throws FlightsInputError for places it cannot resolve", () => {
    expect(() => normalizeFlightsInput(validInput, { currency: "USD" })).toThrow(FlightsInputError);
    expect(() =>
      normalizeFlightsInput({ ...validInput, origin: "LHR", destination: "Atlantis" }, { currency: "USD" }),
    ).toThrow(/destination "Atlantis"/);
  });

  it("works on already-parsed input", () => {
    const parsed = SearchFlightsInputSchema.parse({ ...validInput, origin: "LHR" });
    expect(normalizeFlightsInput(parsed, { currency: "USD" }).destination).toBe("JFK");
  });
});

describe("FlightOfferSchema", () => {
  it("accepts a valid offer", () => {
    expect(FlightOfferSchema.safeParse(validOffer).success).toBe(true);
  });

  it("accepts optional fields", () => {
    const r = FlightOfferSchema.safeParse({
      ...validOffer,
      booking_url: "https://www.google.com/travel/flights?q=x",
      fare_notes: ["Basic economy, no carry-on"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects bad IATA codes in segments and layovers", () => {
    const seg = validOffer.slices[0]!.segments[0]!;
    const withSeg = (patch: object) => ({
      ...validOffer,
      slices: [{ segments: [{ ...seg, ...patch }], layovers: [] }],
    });
    expect(FlightOfferSchema.safeParse(withSeg({ depart_airport: "lhr" })).success).toBe(false);
    expect(FlightOfferSchema.safeParse(withSeg({ arrive_airport: "LONDON" })).success).toBe(false);
    expect(FlightOfferSchema.safeParse(withSeg({ airline: "BAW" })).success).toBe(false);

    const twoSegs = {
      ...validOffer,
      slices: [{ segments: [seg, seg], layovers: [{ airport: "dub", duration_min: 60 }] }],
    };
    expect(FlightOfferSchema.safeParse(twoSegs).success).toBe(false);
  });

  it("requires one layover between each pair of segments", () => {
    const seg = validOffer.slices[0]!.segments[0]!;
    const bad = { ...validOffer, slices: [{ segments: [seg, seg], layovers: [] }] };
    expect(FlightOfferSchema.safeParse(bad).success).toBe(false);
    const good = { ...validOffer, slices: [{ segments: [seg, seg], layovers: [{ airport: "DUB", duration_min: 90 }] }] };
    expect(FlightOfferSchema.safeParse(good).success).toBe(true);
  });

  it("rejects bad prices, sources, times, slice counts and URLs", () => {
    expect(FlightOfferSchema.safeParse({ ...validOffer, price: { amount: -1, currency: "GBP" } }).success).toBe(false);
    expect(FlightOfferSchema.safeParse({ ...validOffer, price: { amount: 10, currency: "gbp" } }).success).toBe(false);
    expect(FlightOfferSchema.safeParse({ ...validOffer, source: "kayak" }).success).toBe(false);
    expect(FlightOfferSchema.safeParse({ ...validOffer, slices: [] }).success).toBe(false);
    expect(
      FlightOfferSchema.safeParse({ ...validOffer, slices: [validOffer.slices[0], validOffer.slices[0], validOffer.slices[0]] })
        .success,
    ).toBe(false);
    expect(FlightOfferSchema.safeParse({ ...validOffer, booking_url: "not a url" }).success).toBe(false);
    expect(FlightOfferSchema.safeParse({ ...validOffer, total_duration_min: 12.5 }).success).toBe(false);

    const seg = validOffer.slices[0]!.segments[0]!;
    const badTime = { ...validOffer, slices: [{ segments: [{ ...seg, depart_at: "tomorrow morning" }], layovers: [] }] };
    expect(FlightOfferSchema.safeParse(badTime).success).toBe(false);
  });
});

describe("SearchFlightsOutputSchema", () => {
  const output = {
    query: {
      origin: "LON",
      destination: "NYC",
      depart_date: "2026-12-01",
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: "economy",
      sources: ["duffel"],
      currency: "GBP",
    },
    offers: [validOffer],
    sources_used: ["duffel"],
    sources_failed: [{ source: "google_flights", error: "blocked" }],
    fetched_at: "2026-10-18T09:12:14.545Z",
    caveats: [],
  };

  it("accepts a valid output", () => {
    expect(SearchFlightsOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rejects more than 30 offers and a bad timestamp", () => {
    expect(SearchFlightsOutputSchema.safeParse({ ...output, offers: Array(31).fill(validOffer) }).success).toBe(false);
    expect(SearchFlightsOutputSchema.safeParse({ ...output, fetched_at: "yesterday" }).success).toBe(false);
  });
});
