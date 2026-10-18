import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSUMED_CHILD_AGE,
  ASSUMED_INFANT_AGE,
  DUFFEL_BASE_URL,
  DuffelProvider,
  buildRequestBody,
  mapDuffelOffer,
  minutesBetween,
  parseIsoDurationMinutes,
} from "../../../src/core/flights/providers/duffel.js";
import { FlightProviderError } from "../../../src/core/flights/types.js";
import { log } from "../../../src/log.js";
import {
  FlightOfferSchema,
  type NormalizedFlightsQuery,
} from "../../../src/schemas/flights.js";

/**
 * Fixtures are offer-request responses in the shape of Duffel's API reference
 * (https://duffel.com/docs/api/offers/schema), with ids and the client key
 * redacted. They were composed from the documented payload structure, not
 * recorded from a live call, so no secret or real passenger data is present.
 */
function fixture(name: string): { data: { offers: Array<Record<string, unknown>> } } {
  return JSON.parse(readFileSync(new URL(`../../fixtures/flights/${name}`, import.meta.url), "utf8"));
}

const ONEWAY_QUERY: NormalizedFlightsQuery = {
  origin: "LHR",
  destination: "JFK",
  depart_date: "2026-12-01",
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: "economy",
  sources: ["duffel"],
  currency: "GBP",
};

const ROUNDTRIP_QUERY: NormalizedFlightsQuery = { ...ONEWAY_QUERY, return_date: "2026-12-08" };

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function provider(fetchImpl: typeof fetch, extra: { timeoutMs?: number } = {}) {
  // Retries are covered in duffel-retry.test.ts; here each call is one attempt.
  return new DuffelProvider({ apiKey: "duffel_test_REDACTED", fetchImpl, retry: { retries: 0 }, ...extra });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function rejection(p: Promise<unknown>): Promise<FlightProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FlightProviderError);
    return err as FlightProviderError;
  }
  throw new Error("expected the promise to reject");
}

describe("parseIsoDurationMinutes", () => {
  it.each([
    ["PT2H26M", 146],
    ["PT02H26M", 146],
    ["PT8H", 480],
    ["PT45M", 45],
    ["PT90M", 90],
    ["P1DT3H", 27 * 60],
    ["P1DT2H5M", 26 * 60 + 5],
    ["PT0S", 0],
    ["PT1H30S", 61],
    ["PT1H29S", 60],
    ["P1W", 7 * 24 * 60],
    [" PT3H ", 180],
  ])("%j -> %d", (input, expected) => {
    expect(parseIsoDurationMinutes(input)).toBe(expected);
  });

  it.each(["", "P", "PT", "P1DT", "2H26M", "1:30", "PT-5M", "P1Y", "P2M", "PT1.5H", "garbage"])(
    "%j is undefined",
    (input) => {
      expect(parseIsoDurationMinutes(input)).toBeUndefined();
    },
  );
});

describe("minutesBetween", () => {
  it("diffs local times at the same airport, with or without seconds", () => {
    expect(minutesBetween("2026-12-01T08:35:00", "2026-12-01T11:05:00")).toBe(150);
    expect(minutesBetween("2026-12-01T08:35", "2026-12-01T11:05")).toBe(150);
    expect(minutesBetween("2026-12-01T23:30:00", "2026-12-02T01:00:00")).toBe(90);
  });

  it("honors offsets when present", () => {
    expect(minutesBetween("2026-12-01T08:35:00+00:00", "2026-12-01T11:05:00+01:00")).toBe(90);
    expect(minutesBetween("2026-12-01T08:35:00Z", "2026-12-01T11:05:00Z")).toBe(150);
  });

  it("returns undefined for junk", () => {
    expect(minutesBetween("soon", "2026-12-01T11:05:00")).toBeUndefined();
  });
});

describe("buildRequestBody", () => {
  it("builds a one-way request", () => {
    expect(buildRequestBody(ONEWAY_QUERY)).toEqual({
      data: {
        slices: [{ origin: "LHR", destination: "JFK", departure_date: "2026-12-01" }],
        passengers: [{ type: "adult" }],
        cabin_class: "economy",
      },
    });
  });

  it("builds a round-trip request with a reversed second slice", () => {
    const body = buildRequestBody({ ...ROUNDTRIP_QUERY, cabin: "premium_economy", max_stops: 0 }) as {
      data: Record<string, unknown>;
    };
    expect(body.data["slices"]).toEqual([
      { origin: "LHR", destination: "JFK", departure_date: "2026-12-01" },
      { origin: "JFK", destination: "LHR", departure_date: "2026-12-08" },
    ]);
    expect(body.data["cabin_class"]).toBe("premium_economy");
    expect(body.data["max_connections"]).toBe(0);
  });

  it("sends passengers by type for adults and by age for children and infants, never both", () => {
    const body = buildRequestBody({ ...ONEWAY_QUERY, passengers: { adults: 2, children: 1, infants: 1 } }) as {
      data: { passengers: Array<Record<string, unknown>> };
    };
    expect(body.data.passengers).toEqual([
      { type: "adult" },
      { type: "adult" },
      { age: ASSUMED_CHILD_AGE },
      { age: ASSUMED_INFANT_AGE },
    ]);
  });

  it("omits max_connections when no limit was requested", () => {
    const body = buildRequestBody(ONEWAY_QUERY) as { data: Record<string, unknown> };
    expect("max_connections" in body.data).toBe(false);
  });
});

describe("DuffelProvider configuration", () => {
  it("is configured only with a non-empty key", () => {
    expect(new DuffelProvider({}).isConfigured()).toBe(false);
    expect(new DuffelProvider({ apiKey: "" }).isConfigured()).toBe(false);
    expect(new DuffelProvider({ apiKey: "   " }).isConfigured()).toBe(false);
    expect(new DuffelProvider({ apiKey: "duffel_test_x" }).isConfigured()).toBe(true);
    expect(new DuffelProvider({ apiKey: "k" }).name).toBe("duffel");
  });

  it("throws a non-retryable config error when searching without a key", async () => {
    const fetchImpl = respond({});
    const err = await rejection(new DuffelProvider({ fetchImpl }).search(ONEWAY_QUERY, new AbortController().signal));
    expect(err.code).toBe("config");
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe("duffel");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DuffelProvider request", () => {
  it("POSTs an offer request with the documented headers, path and query", async () => {
    const fetchImpl = respond(fixture("duffel-offer-request-oneway.json"));
    await provider(fetchImpl).search(ONEWAY_QUERY, new AbortController().signal);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}`).toBe(DUFFEL_BASE_URL);
    expect(u.pathname).toBe("/air/offer_requests");
    expect(u.searchParams.get("return_offers")).toBe("true");
    expect(u.searchParams.get("supplier_timeout")).toBe("25000");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer duffel_test_REDACTED");
    expect(headers["Duffel-Version"]).toBe("v2");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(buildRequestBody(ONEWAY_QUERY));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honors a custom base URL and keeps supplier_timeout below the HTTP timeout", async () => {
    const fetchImpl = respond({ data: { offers: [] } });
    const p = new DuffelProvider({ apiKey: "k", fetchImpl, baseUrl: "http://localhost:9999/", timeoutMs: 10_000 });
    await p.search(ONEWAY_QUERY, new AbortController().signal);
    const url = new URL(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string])[0]);
    expect(url.origin).toBe("http://localhost:9999");
    expect(url.searchParams.get("supplier_timeout")).toBe("5000");
  });
});

describe("DuffelProvider mapping: one-way fixture", () => {
  it("maps to valid offers sorted by price ascending", async () => {
    const offers = await provider(respond(fixture("duffel-offer-request-oneway.json"))).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    expect(offers.map((o) => o.price.amount)).toEqual([389.2, 512, 538.4]);
    for (const o of offers) {
      expect(FlightOfferSchema.safeParse(o).success).toBe(true);
      expect(o.source).toBe("duffel");
      expect(o.id).toMatch(/^off_/);
      expect(o.price.currency).toBe("GBP");
      expect(o.booking_url).toBeUndefined();
      expect(o.slices).toHaveLength(1);
    }
  });

  it("maps the nonstop with durations, aircraft and fare notes", async () => {
    const offers = await provider(respond(fixture("duffel-offer-request-oneway.json"))).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    const ba = offers.find((o) => o.slices[0]?.segments[0]?.airline === "BA");
    expect(ba).toBeDefined();
    expect(ba?.stops).toBe(0);
    expect(ba?.total_duration_min).toBe(480);
    expect(ba?.slices[0]?.layovers).toEqual([]);
    expect(ba?.slices[0]?.segments).toEqual([
      {
        airline: "BA",
        airline_name: "British Airways",
        flight_number: "BA117",
        depart_airport: "LHR",
        depart_at: "2026-12-01T09:30:00",
        arrive_airport: "JFK",
        arrive_at: "2026-12-01T12:30:00",
        duration_min: 480,
        aircraft: "Boeing 787-9",
      },
    ]);
    expect(ba?.fare_notes).toEqual([
      "Fare: Economy Basic",
      "Non-refundable",
      "Changeable before departure (fee 75.00 GBP)",
      "No checked bag included",
      "Carry-on bags included: 1",
    ]);
  });

  it("maps the one-stop with a computed layover and per-leg segments", async () => {
    const offers = await provider(respond(fixture("duffel-offer-request-oneway.json"))).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    const ei = offers[0];
    expect(ei?.price.amount).toBe(389.2);
    expect(ei?.stops).toBe(1);
    expect(ei?.total_duration_min).toBe(12 * 60 + 10);
    const slice = ei?.slices[0];
    expect(slice?.segments.map((s) => `${s.flight_number} ${s.depart_airport}-${s.arrive_airport} ${s.duration_min}`)).toEqual([
      "EI155 LHR-DUB 85",
      "EI105 DUB-JFK 495",
    ]);
    expect(slice?.layovers).toEqual([{ airport: "DUB", duration_min: 150 }]);
    // Refund conditions were null in the response, so no refund note; change had no fee.
    expect(ei?.fare_notes).toEqual([
      "Fare: Saver",
      "Changeable before departure",
      "No checked bag included",
      "Carry-on bags included: 1",
    ]);
  });

  it("reports the operating carrier for a codeshare", async () => {
    const offers = await provider(respond(fixture("duffel-offer-request-oneway.json"))).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    const vs = offers.find((o) => o.price.amount === 512);
    const seg = vs?.slices[0]?.segments[0];
    expect(seg?.airline).toBe("VS");
    expect(seg?.airline_name).toBe("Virgin Atlantic Airways");
    expect(seg?.flight_number).toBe("VS3");
    expect(vs?.fare_notes).toContain("Checked bags included: 1");
    expect(vs?.fare_notes).toContain("Refundable before departure (fee 150.00 GBP)");
  });
});

describe("DuffelProvider mapping: round-trip fixture", () => {
  it("maps both slices, sums durations and takes the maximum stops", async () => {
    const offers = await provider(respond(fixture("duffel-offer-request-roundtrip.json"))).search(
      ROUNDTRIP_QUERY,
      new AbortController().signal,
    );
    expect(offers.map((o) => o.price.amount)).toEqual([741.9, 1015, 1102.6]);
    for (const o of offers) {
      expect(FlightOfferSchema.safeParse(o).success).toBe(true);
      expect(o.slices).toHaveLength(2);
    }

    const [ei, vs, ba] = offers;
    // EI: out 12h10 (1 stop), back 10h25 (1 stop).
    expect(ei?.total_duration_min).toBe(730 + 625);
    expect(ei?.stops).toBe(1);
    expect(ei?.slices[0]?.layovers).toEqual([{ airport: "DUB", duration_min: 150 }]);
    expect(ei?.slices[1]?.layovers).toEqual([{ airport: "DUB", duration_min: 120 }]);
    expect(ei?.slices[1]?.segments.map((s) => `${s.depart_airport}-${s.arrive_airport}`)).toEqual(["JFK-DUB", "DUB-LHR"]);
    // Both nonstop round trips.
    expect(vs?.total_duration_min).toBe(485 + 425);
    expect(vs?.stops).toBe(0);
    expect(ba?.total_duration_min).toBe(480 + 425);
    expect(ba?.stops).toBe(0);
    expect(ba?.slices[1]?.segments[0]).toMatchObject({
      flight_number: "BA178",
      depart_airport: "JFK",
      arrive_airport: "LHR",
      depart_at: "2026-12-08T19:00:00",
      arrive_at: "2026-12-09T07:05:00",
      duration_min: 425,
    });
    expect(ba?.fare_notes).toContain("Checked bags included: 1");
    expect(vs?.fare_notes).toContain("Checked bags included: 2");
  });

  it("reports the maximum stops across slices when only one slice has a connection", () => {
    const f = fixture("duffel-offer-request-roundtrip.json");
    const mixed = structuredClone(f.data.offers[1]) as Record<string, unknown>;
    const slices = mixed["slices"] as Array<Record<string, unknown>>;
    const ba = f.data.offers[0] as Record<string, unknown>;
    slices[1] = (ba["slices"] as Array<Record<string, unknown>>)[1] as Record<string, unknown>;
    const o = mapDuffelOffer(mixed);
    expect(o?.stops).toBe(1);
    expect(o?.slices.map((s) => s.segments.length)).toEqual([2, 1]);
  });
});

describe("DuffelProvider result shaping", () => {
  const template = fixture("duffel-offer-request-oneway.json").data.offers[0] as Record<string, unknown>;
  const withPrice = (i: number, price: string): Record<string, unknown> => ({
    ...structuredClone(template),
    id: `off_clone_${String(i).padStart(3, "0")}`,
    total_amount: price,
  });

  it("caps at 30 offers keeping the cheapest", async () => {
    const offers = Array.from({ length: 45 }, (_, i) => withPrice(i, String(1000 - i)));
    const result = await provider(respond({ data: { offers } })).search(ONEWAY_QUERY, new AbortController().signal);
    expect(result).toHaveLength(30);
    expect(result[0]?.price.amount).toBe(956);
    expect(result[29]?.price.amount).toBe(985);
    const prices = result.map((o) => o.price.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("breaks price ties by shorter duration then id", async () => {
    const f = fixture("duffel-offer-request-oneway.json");
    const eiOffer = structuredClone(f.data.offers[1]) as Record<string, unknown>;
    const baOffer = structuredClone(f.data.offers[0]) as Record<string, unknown>;
    eiOffer["total_amount"] = "500.00";
    baOffer["total_amount"] = "500.00";
    const result = await provider(respond({ data: { offers: [eiOffer, baOffer] } })).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    expect(result.map((o) => o.total_duration_min)).toEqual([480, 730]);
  });

  it("returns an empty list when Duffel has no offers", async () => {
    expect(await provider(respond({ data: { offers: [] } })).search(ONEWAY_QUERY, new AbortController().signal)).toEqual([]);
  });

  it("skips partial offers", async () => {
    const partial = { ...structuredClone(template), id: "off_partial", partial: true };
    const result = await provider(respond({ data: { offers: [partial, withPrice(1, "600.00")] } })).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    expect(result.map((o) => o.id)).toEqual(["off_clone_001"]);
  });

  it("skips one broken offer but keeps the rest, and logs it", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const broken = { ...structuredClone(template), id: "off_broken", total_amount: "free" };
    const result = await provider(respond({ data: { offers: [broken, withPrice(1, "600.00")] } })).search(
      ONEWAY_QUERY,
      new AbortController().signal,
    );
    expect(result.map((o) => o.id)).toEqual(["off_clone_001"]);
    expect(warn).toHaveBeenCalled();
  });

  it("throws malformed when every offer is broken", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const broken = { ...structuredClone(template), total_amount: "free" };
    const err = await rejection(
      provider(respond({ data: { offers: [broken, structuredClone(broken)] } })).search(ONEWAY_QUERY, new AbortController().signal),
    );
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/malformed/);
  });

  it("rejects an offer whose connection times run backwards", () => {
    const bad = structuredClone(fixture("duffel-offer-request-oneway.json").data.offers[1]) as {
      slices: Array<{ segments: Array<Record<string, unknown>> }>;
    };
    bad.slices[0]!.segments[1]!["departing_at"] = "2026-12-01T08:00:00";
    expect(() => mapDuffelOffer(bad)).toThrow(/connection/);
  });

  it("falls back to the marketing carrier when there is no operating carrier", () => {
    const o = structuredClone(fixture("duffel-offer-request-oneway.json").data.offers[2]) as {
      slices: Array<{ segments: Array<Record<string, unknown>> }>;
    };
    o.slices[0]!.segments[0]!["operating_carrier"] = null;
    o.slices[0]!.segments[0]!["operating_carrier_flight_number"] = null;
    const seg = mapDuffelOffer(o)?.slices[0]?.segments[0];
    expect(seg?.airline).toBe("DL");
    expect(seg?.flight_number).toBe("DL7003");
  });

  it("omits aircraft when Duffel does not send one", () => {
    const o = structuredClone(fixture("duffel-offer-request-oneway.json").data.offers[0]) as {
      slices: Array<{ segments: Array<Record<string, unknown>> }>;
    };
    o.slices[0]!.segments[0]!["aircraft"] = null;
    const seg = mapDuffelOffer(o)?.slices[0]?.segments[0];
    expect(seg).toBeDefined();
    expect("aircraft" in (seg ?? {})).toBe(false);
  });

  it("uses the slice duration for a single segment without its own duration", () => {
    const o = structuredClone(fixture("duffel-offer-request-oneway.json").data.offers[0]) as {
      slices: Array<{ segments: Array<Record<string, unknown>> }>;
    };
    o.slices[0]!.segments[0]!["duration"] = null;
    expect(mapDuffelOffer(o)?.slices[0]?.segments[0]?.duration_min).toBe(480);
  });
});

describe("DuffelProvider errors", () => {
  const body = (message: string) => ({
    errors: [{ type: "x", code: "c", title: "T", message }],
    meta: { status: 0, request_id: "req_123" },
  });

  it.each([429, 500, 502, 503, 504])("HTTP %d is retryable and carries its status", async (status) => {
    const err = await rejection(provider(respond(body("slow down"), status)).search(ONEWAY_QUERY, new AbortController().signal));
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(status);
    expect(err.code).toBe("provider");
    expect(err.provider).toBe("duffel");
    expect(err.message).toContain("slow down");
    expect(err.message).toContain("req_123");
  });

  it.each([401, 403])("HTTP %d is a non-retryable config error and never echoes the key", async (status) => {
    const err = await rejection(
      provider(respond(body("Invalid token"), status)).search(ONEWAY_QUERY, new AbortController().signal),
    );
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(status);
    expect(err.code).toBe("config");
    expect(err.message).not.toContain("duffel_test_REDACTED");
  });

  it.each([400, 422])("HTTP %d is non-retryable invalid_input", async (status) => {
    const err = await rejection(
      provider(respond(body("airport code is invalid"), status)).search(ONEWAY_QUERY, new AbortController().signal),
    );
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("airport code is invalid");
  });

  it("treats other 4xx as non-retryable provider errors, even with a non-JSON body", async () => {
    const err = await rejection(provider(respond("<html>Not found</html>", 404)).search(ONEWAY_QUERY, new AbortController().signal));
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(404);
    expect(err.code).toBe("provider");
    expect(err.message).toContain("Not found");
  });

  it("maps a network failure to a retryable provider error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await rejection(provider(fetchImpl).search(ONEWAY_QUERY, new AbortController().signal));
    expect(err.retryable).toBe(true);
    expect(err.code).toBe("provider");
    expect(err.message).toContain("fetch failed");
    expect(err.status).toBeUndefined();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["empty body", ""],
    ["a JSON array", "[]"],
    ["no data", { meta: {} }],
    ["offers is not an array", { data: { offers: "nope" } }],
    ["data is null", { data: null }],
  ])("a 200 with a malformed body (%s) throws a non-retryable provider error", async (_label, payload) => {
    const err = await rejection(provider(respond(payload)).search(ONEWAY_QUERY, new AbortController().signal));
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/malformed/);
  });
});

describe("DuffelProvider abort and timeout", () => {
  /** A fetch that never answers until its signal aborts, like a hung connection. */
  function hangingFetch(): typeof fetch {
    return vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
  }

  it("rejects when the caller aborts mid-flight", async () => {
    const ac = new AbortController();
    const pending = rejection(provider(hangingFetch()).search(ONEWAY_QUERY, ac.signal));
    setTimeout(() => ac.abort(), 10);
    const err = await pending;
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/abort/i);
  });

  it("rejects immediately, without calling fetch, when already aborted", async () => {
    const fetchImpl = hangingFetch();
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(provider(fetchImpl).search(ONEWAY_QUERY, ac.signal));
    expect(err.code).toBe("timeout");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("times out with a retryable timeout error", async () => {
    const err = await rejection(
      provider(hangingFetch(), { timeoutMs: 30 }).search(ONEWAY_QUERY, new AbortController().signal),
    );
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("30 ms");
  });

  it("rejects when the body read is aborted after the headers arrived", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const pending = rejection(provider(fetchImpl).search(ONEWAY_QUERY, ac.signal));
    setTimeout(() => ac.abort(), 10);
    expect((await pending).code).toBe("timeout");
  });
});
