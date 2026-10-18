import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  airlineCodeForName,
  assembleOffer,
  buildGoogleFlightsUrl,
  buildQueryText,
  createGoogleFlightsRecipe,
  googleFlightsRecipe,
  labelPrice,
  labelStops,
  resolveAirport,
  selectLabels,
  type ExtractedItinerary,
} from "../../../src/core/browser/recipes/google-flights.js";
import { RecipeError, type RecipeContext } from "../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { CostMeter } from "../../../src/core/llm/cost.js";
import type { LlmClient } from "../../../src/core/llm/types.js";
import { FlightOfferSchema, MAX_OFFERS, type FlightOffer, type NormalizedFlightsQuery } from "../../../src/schemas/flights.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../browser/helpers.js";
import {
  labelReadingLlm,
  makeLogger,
  ONE_WAY,
  promptLabels,
  promptOf,
  readFixture,
  readLabel,
  ROUND_TRIP,
  scriptedLlm,
  startFlightsServer,
  type FlightsServer,
} from "./gf-helpers.js";


const probe = await probeChromium();
const canned = JSON.parse(readFixture("google-flights-extraction.json")) as { offers: ExtractedItinerary[] };

describe("URL building (verified live 2026-10-18)", () => {
  it("round trip", () => {
    expect(buildGoogleFlightsUrl(ROUND_TRIP)).toBe(
      "https://www.google.com/travel/flights?q=Flights%20from%20LHR%20to%20JFK%20on%202026-12-01%20returning%202026-12-08&curr=USD&hl=en",
    );
    expect(googleFlightsRecipe.buildUrl?.(ROUND_TRIP)).toBe(buildGoogleFlightsUrl(ROUND_TRIP));
  });

  it("one way appends the literal words one way", () => {
    expect(buildGoogleFlightsUrl(ONE_WAY)).toBe(
      "https://www.google.com/travel/flights?q=Flights%20from%20LHR%20to%20JFK%20on%202026-12-01%20one%20way&curr=USD&hl=en",
    );
  });

  it("adds cabin and passengers only when they differ from the defaults", () => {
    expect(buildQueryText(ONE_WAY)).toBe("Flights from LHR to JFK on 2026-12-01 one way");
    const q: NormalizedFlightsQuery = {
      ...ONE_WAY,
      cabin: "business",
      passengers: { adults: 2, children: 1, infants: 0 },
      currency: "EUR",
    };
    expect(buildQueryText(q)).toBe("Flights from LHR to JFK on 2026-12-01 one way in business class for 2 adults and 1 child");
    expect(buildGoogleFlightsUrl(q)).toContain("curr=EUR");
    expect(buildQueryText({ ...ONE_WAY, passengers: { adults: 2, children: 1, infants: 1 } })).toContain(
      "for 2 adults, 1 child and 1 infant",
    );
    expect(buildQueryText({ ...ONE_WAY, cabin: "premium_economy" })).toContain("in premium economy class");
  });

  it("can point at another base URL", () => {
    expect(buildGoogleFlightsUrl(ONE_WAY, "http://127.0.0.1:9/results")).toMatch(/^http:\/\/127\.0\.0\.1:9\/results\?q=/);
  });
});

describe("label helpers", () => {
  const labels = readFixture("google-flights-aria-labels.txt").split("\n").filter(Boolean);

  it("reads price and stops from real labels", () => {
    expect(labelPrice(labels[0] as string)).toBe(661);
    expect(labelPrice("From 1,428 US dollars round trip total. x")).toBe(1428);
    expect(labelPrice("Flight details. Leaves")).toBeUndefined();
    expect(labelStops(labels[0] as string)).toBe(0);
    expect(labelStops("From 5 euros. 2 stops flight with X.")).toBe(2);
    expect(labelStops("something else")).toBeUndefined();
  });

  it("orders by stated price, filters by max_stops and caps the count", () => {
    const sorted = selectLabels(labels, ROUND_TRIP);
    const prices = sorted.map((l) => labelPrice(l) as number);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const nonstop = selectLabels(labels, { ...ROUND_TRIP, max_stops: 0 });
    expect(nonstop.length).toBeGreaterThan(0);
    expect(nonstop.every((l) => labelStops(l) === 0)).toBe(true);
    const many = Array.from({ length: 100 }, (_, i) => `From ${i + 1} US dollars. Nonstop flight with X ${i}. Leaves A`);
    expect(selectLabels(many, ROUND_TRIP)).toHaveLength(40);
  });

  it("maps airline names and airport names in code", () => {
    expect(airlineCodeForName("Virgin Atlantic")).toBe("VS");
    expect(airlineCodeForName("SWISS")).toBe("LX");
    expect(airlineCodeForName("Delta Air Lines")).toBe("DL");
    expect(airlineCodeForName("Zorblax Air")).toBeUndefined();
    expect(resolveAirport("Heathrow Airport", null)).toBe("LHR");
    expect(resolveAirport("Zurich Airport in Zürich", null)).toBe("ZRH");
    expect(resolveAirport("Vienna International Airport in Vienna", null)).toBe("VIE");
    expect(resolveAirport("Aéroport de Paris-Charles de Gaulle in Paris", null)).toBe("CDG");
    expect(resolveAirport("Nowhere Airfield", null)).toBeUndefined();
    expect(resolveAirport("Nowhere Airfield", "zzz")).toBe("ZZZ");
    expect(resolveAirport("Nowhere Airfield", "ZZ")).toBeUndefined();
  });
});

describe("assembleOffer", () => {
  const labels = [
    "From 616 US dollars round trip total. 1 stop flight with Austrian. Leaves Heathrow Airport at 6:00 AM on Tuesday, December 1 and arrives at John F. Kennedy International Airport at 2:15 PM on Tuesday, December 1. Total duration 13 hr 15 min. Layover (1 of 1) is a 1 hr 40 min layover at Vienna International Airport in Vienna. Select flight",
    "From 500 US dollars. 2 stops flight with Delta. Leaves Heathrow Airport at 6:00 AM on Tuesday, December 1 and arrives at John F. Kennedy International Airport at 6:00 PM on Tuesday, December 1. Total duration 17 hr 0 min. Select flight",
  ];
  const ctx = { query: ROUND_TRIP, pageUrl: "https://www.google.com/travel/flights?q=x", labels };
  const base = readLabel(0, labels[0] as string);

  it("splits at the layover airport and keeps the strict layover rule", () => {
    const r = assembleOffer(base, ctx);
    expect("offer" in r).toBe(true);
    if (!("offer" in r)) return;
    const slice = r.offer.slices[0];
    expect(slice?.segments.map((s) => [s.depart_airport, s.arrive_airport, s.airline])).toEqual([
      ["LHR", "VIE", "OS"],
      ["VIE", "JFK", "OS"],
    ]);
    expect(slice?.layovers).toEqual([{ airport: "VIE", duration_min: 100 }]);
    expect(slice?.segments.reduce((a, s) => a + s.duration_min, 0)).toBe(795 - 100);
    expect(slice?.segments[0]?.depart_at).toBe("2026-12-01T06:00:00");
    expect(slice?.segments[1]?.arrive_at).toBe("2026-12-01T14:15:00");
    // The middle times are consistent: arrival, then the layover, then departure.
    const arrive = Date.parse(`${slice?.segments[0]?.arrive_at}Z`);
    const depart = Date.parse(`${slice?.segments[1]?.depart_at}Z`);
    expect((depart - arrive) / 60_000).toBe(100);
    expect(r.offer.stops).toBe(1);
    expect(r.offer.total_duration_min).toBe(795);
    expect(r.offer.itinerary).toBe("outbound_only");
    expect(r.offer.slices[0]?.segments[0]?.flight_number).toBeUndefined();
    expect(r.offer.fare_notes).toEqual(
      expect.arrayContaining([
        "flight numbers not shown by source",
        "segment times approximated from layover data",
        "Round-trip total; return flight is chosen in a second step on Google Flights",
      ]),
    );
    expect(r.offer.booking_url).toBe("https://www.google.com/travel/flights?q=x");
    expect(FlightOfferSchema.safeParse(r.offer).success).toBe(true);
  });

  it("emits one segment and no layovers when a multi-stop label has no layover detail, and says so", () => {
    const r = assembleOffer(readLabel(1, labels[1] as string), ctx);
    expect("offer" in r).toBe(true);
    if (!("offer" in r)) return;
    expect(r.offer.stops).toBe(2);
    expect(r.offer.slices[0]?.segments).toHaveLength(1);
    expect(r.offer.slices[0]?.layovers).toEqual([]);
    expect(r.offer.fare_notes).toContain("layover details not shown by source; segments not itemized");
  });

  it("one-way offers are complete and carry no round-trip note", () => {
    const r = assembleOffer(base, { ...ctx, query: ONE_WAY });
    expect("offer" in r && r.offer.itinerary).toBe("complete");
    expect("offer" in r && r.offer.fare_notes?.some((n) => n.startsWith("Round-trip"))).toBe(false);
  });

  it.each([
    ["an unknown airport", { ...base, depart_airport: { name: "Nowhere Airfield", iata: null } }, /no IATA code/],
    ["an unknown airline", { ...base, airlines: [{ name: "Zorblax Air", code: null }] }, /no carrier code/],
    ["a price that contradicts the label", { ...base, price_amount: 99 }, /differs from the label/],
    ["a different departure date", { ...base, depart_at: "2026-12-02T06:00", arrive_at: "2026-12-02T14:15" }, /query asked for/],
    ["an arrival that contradicts the duration", { ...base, arrive_at: "2026-12-03T14:15" }, /inconsistent/],
    ["an item outside the labels", { ...base, item: 9 }, /does not match/],
    ["a bad currency", { ...base, currency: "dollars" }, /currency/],
    ["a missing duration", { ...base, total_duration_min: 0 }, /duration/],
  ])("drops an offer with %s", (_name, raw, reason) => {
    const r = assembleOffer(raw as ExtractedItinerary, ctx);
    expect("drop" in r && r.drop).toMatch(reason);
  });

  it("accepts the model's certain codes when the table has none", () => {
    const raw = {
      ...base,
      airlines: [{ name: "Zorblax Air", code: "ZX" }],
      depart_airport: { name: "Nowhere Airfield", iata: "NWF" },
    };
    const r = assembleOffer(raw, ctx);
    expect("offer" in r && r.offer.slices[0]?.segments[0]?.airline).toBe("ZX");
    expect("offer" in r && r.offer.slices[0]?.segments[0]?.depart_airport).toBe("NWF");
  });
});

describe.skipIf(!probe.available)(`google-flights recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: FlightsServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startFlightsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  async function runRecipe(
    path: string,
    query: NormalizedFlightsQuery,
    llm: LlmClient = scriptedLlm(() => canned),
    over: Partial<RecipeContext> & { grace?: number } = {},
  ) {
    const recipe = createGoogleFlightsRecipe({
      baseUrl: `${server.url}${path}`,
      pollMs: 50,
      ...(over.grace !== undefined && { noResultsGraceMs: over.grace }),
    });
    const log = makeLogger();
    const caveats: string[] = [];
    const page = await session.acquire();
    try {
      const ctx: RecipeContext = { llm, log, deadline: Date.now() + 30_000, caveats, ...over };
      const settled: { offers?: FlightOffer[]; error?: unknown } = await recipe.run(page, query, ctx).then(
        (offers) => ({ offers }),
        (error: unknown) => ({ error }),
      );
      const consent = await page.evaluate<string | null>(`document.documentElement.getAttribute("data-consent")`).catch(() => null);
      return { ...settled, log, caveats, llm, consent };
    } finally {
      await session.release(page);
    }
  }

  it("dismisses the consent dialog (reject preferred), waits for results, expands twice and extracts", async () => {
    const llm = scriptedLlm(() => canned);
    const meter = new CostMeter();
    const r = await runRecipe("/results", ROUND_TRIP, llm, { meter });
    expect(r.error).toBeUndefined();
    expect(r.consent).toBe("rejected");
    expect(r.caveats.some((c) => /cookie consent dialog/i.test(c))).toBe(true);

    // The prompt carries the aria-labels: all 8 rows, so the expander was clicked twice, cheapest first.
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    const labels = promptLabels(req);
    expect(labels.size).toBe(8);
    expect(promptOf(req)).toContain(
      "From 661 US dollars round trip total. Nonstop flight with Virgin Atlantic. Leaves Heathrow Airport at 3:50 PM on Tuesday, December 1 and arrives at John F. Kennedy International Airport at 7:10 PM on Tuesday, December 1. Total duration 8 hr 20 min.",
    );
    expect(labels.get(0)).toContain("From 611 US dollars");
    expect(labels.get(0)).toContain("6:00 AM");
    expect(labels.get(7)).toContain("British Airways");
    expect(promptOf(req)).toContain("Page outline");
    expect(req.role).toBe("extractor");
    expect(req.effort).toBe("medium");
    expect(req.maxTokens).toBe(16_000);
    expect(req.meter).toBe(meter);
    expect(req.schema).toBeDefined();
    expect(req.system).toMatch(/never use outside knowledge/i);

    // Offers validate, are sorted by price and carry the decided shape.
    const offers = r.offers!;
    expect(offers).toHaveLength(8);
    for (const o of offers) expect(FlightOfferSchema.safeParse(o).success).toBe(true);
    const prices = offers.map((o) => o.price.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices[0]).toBe(611);
    expect(offers.every((o) => o.source === "google_flights" && o.itinerary === "outbound_only" && o.slices.length === 1)).toBe(true);
    expect(offers.every((o) => o.price.currency === "USD")).toBe(true);
    expect(offers.every((o) => o.booking_url?.startsWith(server.url))).toBe(true);
    expect(new Set(offers.map((o) => o.id)).size).toBe(8);

    const nonstop = offers.find((o) => o.slices[0]?.segments[0]?.airline === "VS")!;
    expect(nonstop.stops).toBe(0);
    expect(nonstop.slices[0]?.segments).toHaveLength(1);
    expect(nonstop.slices[0]?.segments[0]).toMatchObject({
      airline: "VS",
      airline_name: "Virgin Atlantic",
      depart_airport: "LHR",
      arrive_airport: "JFK",
      depart_at: "2026-12-01T15:50:00",
      arrive_at: "2026-12-01T19:10:00",
      duration_min: 500,
    });
    const oneStop = offers.find((o) => o.slices[0]?.segments[0]?.airline === "OS")!;
    expect(oneStop.stops).toBe(1);
    expect(oneStop.slices[0]?.layovers).toEqual([{ airport: "VIE", duration_min: 100 }]);
    const nextDay = offers.find((o) => o.total_duration_min === 1330)!;
    expect(nextDay.slices[0]?.segments.at(-1)?.arrive_at).toBe("2026-12-02T13:15:00");
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  it("returns one-way offers as complete itineraries", async () => {
    const r = await runRecipe("/oneway", ONE_WAY, labelReadingLlm());
    expect(r.error).toBeUndefined();
    expect(r.offers).toHaveLength(8);
    expect(r.offers!.every((o) => o.itinerary === "complete")).toBe(true);
  });

  it("handles every real label captured live", async () => {
    const llm = labelReadingLlm();
    const r = await runRecipe("/live", ROUND_TRIP, llm);
    expect(r.error).toBeUndefined();
    const live = readFixture("google-flights-aria-labels.txt").split("\n").filter(Boolean);
    expect(promptLabels(llm.calls[0]!).size).toBe(live.length);
    expect(r.offers).toHaveLength(live.length);
    expect(r.log.warn).not.toHaveBeenCalled();
    const offers = r.offers!;
    expect(offers.map((o) => o.price.amount)).toEqual([...offers.map((o) => o.price.amount)].sort((a, b) => a - b));
    expect(offers.length).toBeLessThanOrEqual(MAX_OFFERS);
    const airports = new Set(offers.flatMap((o) => o.slices[0]!.segments.flatMap((s) => [s.depart_airport, s.arrive_airport])));
    expect([...airports].sort()).toEqual(["AMS", "CDG", "HEL", "JFK", "LHR", "VIE", "ZRH"]);
    const redEye = offers.find((o) => o.total_duration_min === 22 * 60 + 10)!;
    expect(redEye.slices[0]?.segments.at(-1)?.arrive_at).toBe("2026-12-02T13:15:00");
    expect(redEye.slices[0]?.layovers).toEqual([{ airport: "ZRH", duration_min: 670 }]);
    // The model never saw flight numbers because the page has none.
    expect(offers.every((o) => o.slices.every((s) => s.segments.every((seg) => seg.flight_number === undefined)))).toBe(true);
  });

  it("filters by max_stops before and after extraction", async () => {
    const llm = labelReadingLlm();
    const r = await runRecipe("/live", { ...ROUND_TRIP, max_stops: 0 }, llm);
    expect(r.error).toBeUndefined();
    expect([...promptLabels(llm.calls[0]!).values()].every((l) => labelStops(l) === 0)).toBe(true);
    expect(r.offers!.every((o) => o.stops === 0)).toBe(true);
  });

  it("drops invalid extractions with a warning and keeps the rest", async () => {
    const bad = structuredClone(canned);
    bad.offers[4]!.depart_airport = { name: "Nowhere Airfield", iata: null };
    bad.offers[5]!.airlines = [{ name: "Zorblax Air", code: null }];
    const r = await runRecipe("/results", ROUND_TRIP, scriptedLlm(() => bad));
    expect(r.offers).toHaveLength(6);
    expect(r.log.warn).toHaveBeenCalledTimes(2);
  });

  it("fails with a provider error when nothing extracted is valid", async () => {
    const r = await runRecipe("/results", ROUND_TRIP, scriptedLlm(() => ({ offers: [] })));
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("provider");
  });

  it("throws blocked for the unusual-traffic page and never calls the model", async () => {
    const llm = scriptedLlm(() => canned);
    const r = await runRecipe("/blocked", ROUND_TRIP, llm);
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("blocked");
    expect((r.error as RecipeError).message).toMatch(/unusual traffic|bot/i);
    expect((r.error as RecipeError).retryable).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it("throws blocked for HTTP 429", async () => {
    const r = await runRecipe("/status/429", ROUND_TRIP);
    expect((r.error as RecipeError).code).toBe("blocked");
  });

  it("returns an empty list, with a caveat, when Google shows no flights", async () => {
    const llm = scriptedLlm(() => canned);
    const r = await runRecipe("/empty", ROUND_TRIP, llm, { grace: 600 });
    expect(r.error).toBeUndefined();
    expect(r.offers).toEqual([]);
    expect(r.caveats.some((c) => /no results/i.test(c))).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("throws timeout when results never arrive within the deadline", async () => {
    const t0 = Date.now();
    const r = await runRecipe("/stalled", ROUND_TRIP, scriptedLlm(() => canned), { deadline: Date.now() + 2500 });
    expect((r.error as RecipeError).code).toBe("timeout");
    expect((r.error as RecipeError).retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("throws timeout at once when the deadline has passed", async () => {
    const llm = scriptedLlm(() => canned);
    const r = await runRecipe("/results", ROUND_TRIP, llm, { deadline: Date.now() - 1 });
    expect((r.error as RecipeError).code).toBe("timeout");
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a malformed query", async () => {
    const r = await runRecipe("/results", { ...ROUND_TRIP, origin: "London" });
    expect((r.error as RecipeError).code).toBe("invalid_input");
  });

  it("says when the page does not show the requested passengers or cabin", async () => {
    const r = await runRecipe("/results", {
      ...ROUND_TRIP,
      cabin: "business",
      passengers: { adults: 2, children: 0, infants: 0 },
    });
    expect(r.error).toBeUndefined();
    expect(r.caveats.some((c) => /Passenger counts were not applied/.test(c))).toBe(true);
    expect(r.caveats.some((c) => /Cabin class was not applied/.test(c))).toBe(true);
    const plain = await runRecipe("/results", ROUND_TRIP);
    expect(plain.caveats.some((c) => /not applied/.test(c))).toBe(false);
  });

  it("caveats a more-flights button that is still there after two clicks", async () => {
    const sticky = await runRecipe("/sticky", ROUND_TRIP);
    expect(sticky.error).toBeUndefined();
    expect(sticky.offers).toHaveLength(8);
    expect(sticky.caveats.some((c) => /more flights/i.test(c))).toBe(true);
    // The fixture removes its button on the second click, so nothing is left to caveat.
    const done = await runRecipe("/results", ROUND_TRIP);
    expect(done.caveats.some((c) => /more flights/i.test(c))).toBe(false);
  });

  it("propagates an LLM failure as is", async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new Error("boom")) };
    const r = await runRecipe("/results", ROUND_TRIP, llm);
    expect((r.error as RecipeError).code).toBe("provider");
  });
});

describe("recipe definition", () => {
  it("declares its site, schemas and url builder", () => {
    expect(googleFlightsRecipe.site).toBe("google_flights");
    expect(googleFlightsRecipe.paramsSchema.safeParse(ROUND_TRIP).success).toBe(true);
    expect(googleFlightsRecipe.resultSchema.safeParse([]).success).toBe(true);
    expect(JSON.parse(readFileSync(new URL("../../fixtures/flights/google-flights-extraction.json", import.meta.url), "utf8")).offers).toHaveLength(8);
  });
});
