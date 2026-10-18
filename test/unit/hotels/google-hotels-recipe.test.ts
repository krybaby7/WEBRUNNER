import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assembleCard,
  assembleExtracted,
  buildGoogleHotelsUrl,
  buildQueryText,
  createGoogleHotelsRecipe,
  entityUrl,
  googleHotelsRecipe,
  hotelId,
  labelPriceText,
  mergeCards,
  missingLlmClient,
  parseAmenitiesSentence,
  parseCount,
  parseMoney,
  parseRatingLabel,
  shortDate,
  verifyControls,
  type ExtractedHotel,
  type RawCard,
} from "../../../src/core/browser/recipes/google-hotels.js";
import { RecipeError, type RecipeContext } from "../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { CostMeter } from "../../../src/core/llm/cost.js";
import type { LlmClient } from "../../../src/core/llm/types.js";
import { HotelResultSchema, type HotelResult, type NormalizedHotelsQuery } from "../../../src/schemas/hotels.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../browser/helpers.js";
import {
  cannedExtraction,
  forbiddenLlm,
  makeLogger,
  PARIS,
  promptOf,
  scriptedLlm,
  startHotelsServer,
  type HotelsServer,
} from "./gh-helpers.js";

const probe = await probeChromium();

describe("URL building (verified live 2026-10-18)", () => {
  it("uses the natural-language form that sets the dates", () => {
    expect(buildGoogleHotelsUrl(PARIS)).toBe(
      "https://www.google.com/travel/search?q=hotels%20in%20Paris%20from%202026-11-20%20to%202026-11-23&hl=en&curr=USD",
    );
    expect(googleHotelsRecipe.buildUrl?.(PARIS)).toBe(buildGoogleHotelsUrl(PARIS));
  });

  it("adds the guest clause and the adults/children parameters only when guests differ from 2 adults", () => {
    expect(buildQueryText(PARIS)).toBe("hotels in Paris from 2026-11-20 to 2026-11-23");
    const q: NormalizedHotelsQuery = { ...PARIS, guests: { adults: 3, children: 1 }, currency: "EUR" };
    expect(buildQueryText(q)).toBe("hotels in Paris from 2026-11-20 to 2026-11-23 for 3 adults and 1 child");
    expect(buildGoogleHotelsUrl(q)).toBe(
      "https://www.google.com/travel/search?q=hotels%20in%20Paris%20from%202026-11-20%20to%202026-11-23%20for%203%20adults%20and%201%20child&hl=en&curr=EUR&adults=3&children=1",
    );
    expect(buildQueryText({ ...PARIS, guests: { adults: 1, children: 2 } })).toContain("for 1 adult and 2 children");
    expect(buildGoogleHotelsUrl({ ...PARIS, destination: "Shibuya, Tokyo" })).toContain("q=hotels%20in%20Shibuya%2C%20Tokyo%20from");
  });

  it("can point at another base URL", () => {
    expect(buildGoogleHotelsUrl(PARIS, "http://127.0.0.1:9/results")).toMatch(/^http:\/\/127\.0\.0\.1:9\/results\?q=/);
  });
});

describe("text parsers", () => {
  it.each([
    ["$83", "USD", { amount: 83, currency: "USD" }],
    ["$1,319", "USD", { amount: 1319, currency: "USD" }],
    ["€653", "USD", { amount: 653, currency: "EUR" }],
    ["£2,573", "GBP", { amount: 2573, currency: "GBP" }],
    ["CHF 240", "CHF", { amount: 240, currency: "CHF" }],
    ["CA$120", "CAD", { amount: 120, currency: "CAD" }],
    ["$120", "CAD", { amount: 120, currency: "CAD" }],
    ["1 200 kr", "SEK", { amount: 1200, currency: "SEK" }],
    ["1.234 €", "EUR", { amount: 1234, currency: "EUR" }],
    ["¥12,000", "JPY", { amount: 12000, currency: "JPY" }],
    ["83 USD", "EUR", { amount: 83, currency: "USD" }],
    ["₹4,500", "INR", { amount: 4500, currency: "INR" }],
  ])("parseMoney(%s, %s)", (text, cur, expected) => {
    expect(parseMoney(text, cur)).toEqual(expected);
  });

  it("rejects text that is not a price", () => {
    expect(parseMoney("View prices", "USD")).toBeUndefined();
    expect(parseMoney("Nov 20 – 23", "USD")).toBeUndefined();
    expect(parseMoney("1 200 kr", "USD")).toBeUndefined();
    expect(parseMoney(null, "USD")).toBeUndefined();
    expect(parseMoney("", "USD")).toBeUndefined();
  });

  it("reads review counts and rating labels", () => {
    expect(parseCount("1,044")).toBe(1044);
    expect(parseCount("1.0K")).toBe(1000);
    expect(parseCount("2.2K")).toBe(2200);
    expect(parseCount("3M")).toBe(3_000_000);
    expect(parseCount("abc")).toBeUndefined();
    expect(parseRatingLabel("4.4 out of 5 stars from 1,044 reviews")).toEqual({ rating: 4.4, review_count: 1044 });
    expect(parseRatingLabel("5 out of 5 stars from 1 review")).toEqual({ rating: 5, review_count: 1 });
    // A bare location score has no "stars from" and is not a guest rating.
    expect(parseRatingLabel("4.7 out of 5")).toBeUndefined();
    expect(parseRatingLabel(null)).toBeUndefined();
  });

  it("splits the amenities sentence into class, type and amenities", () => {
    expect(parseAmenitiesSentence("Amenities for Oden Hôtel, a 4-star tourist hotel.: Breakfast ($), Free Wi-Fi, Parking ($), ")).toEqual({
      star_class: 4,
      type: "tourist hotel",
      amenities: ["Breakfast ($)", "Free Wi-Fi", "Parking ($)"],
    });
    expect(parseAmenitiesSentence("Amenities for The People: Breakfast ($), Free Wi-Fi, Free Wi-Fi, Bar,")).toEqual({
      amenities: ["Breakfast ($)", "Free Wi-Fi", "Bar"],
    });
    expect(parseAmenitiesSentence("Amenities for X, a 4-star tourist residence.: Kitchen in rooms,")).toMatchObject({ star_class: 4, type: "tourist residence" });
    expect(parseAmenitiesSentence(null)).toEqual({ amenities: [] });
    const many = `Amenities for X: ${Array.from({ length: 20 }, (_, i) => `A${i}`).join(", ")}`;
    expect(parseAmenitiesSentence(many).amenities).toHaveLength(12);
  });

  it("reads the price label, entity url, short dates and ids", () => {
    expect(labelPriceText("Prices starting from $83, Best Western Hôtel DEAL 18% less than usual")).toBe("$83");
    expect(labelPriceText("View prices for X")).toBeUndefined();
    expect(entityUrl("/travel/hotels/entity/ChoI7I7dwpH68_zKARoNL2cvMTFiN3J4azV6OBAB/prices?q=x&ei=y")).toBe(
      "https://www.google.com/travel/hotels/entity/ChoI7I7dwpH68_zKARoNL2cvMTFiN3J4azV6OBAB",
    );
    expect(entityUrl("http://127.0.0.1:9/travel/hotels/entity/abc?q=x")).toBe("https://www.google.com/travel/hotels/entity/abc");
    expect(entityUrl("/aclk?adurl=")).toBeUndefined();
    expect(entityUrl(null)).toBeUndefined();
    expect(shortDate("2026-11-20")).toBe("Nov 20");
    expect(shortDate("2026-02-03")).toBe("Feb 3");
    expect(hotelId("Glint Paris", "$74")).toMatch(/^google_hotels:[0-9a-f]{12}$/);
    expect(hotelId("Glint Paris", "$74")).toBe(hotelId("Glint Paris", "$74"));
    expect(hotelId("Glint Paris", "$75")).not.toBe(hotelId("Glint Paris", "$74"));
  });
});

describe("verifyControls", () => {
  const caveats = (): { list: string[]; push: (m: string) => void } => {
    const list: string[] = [];
    return { list, push: (m) => list.push(m) };
  };

  it("is silent when the page shows the requested dates and guests", () => {
    const c = caveats();
    verifyControls({ checkin: "Fri, Nov 20", checkout: "Mon, Nov 23", travelers: "Number of travelers. Current number of travelers is 2.", setDates: false }, PARIS, c.push);
    expect(c.list).toEqual([]);
  });

  it("caveats dates that did not take (the live checkin= parameter form)", () => {
    const c = caveats();
    verifyControls({ checkin: "Sun, Oct 18", checkout: "Mon, Oct 19", travelers: "Number of travelers. Current number of travelers is 2.", setDates: true }, PARIS, c.push);
    expect(c.list).toHaveLength(1);
    expect(c.list[0]).toMatch(/Dates were not applied .*wanted Nov 20 to Nov 23, page shows Sun, Oct 18 to Mon, Oct 19/);
  });

  it("caveats a guest count that did not take (as seen live for 3 adults and 1 child)", () => {
    const c = caveats();
    verifyControls(
      { checkin: "Fri, Nov 20", checkout: "Mon, Nov 23", travelers: "Number of travelers. Current number of travelers is 2.", setDates: false },
      { ...PARIS, guests: { adults: 3, children: 1 } },
      c.push,
    );
    expect(c.list).toEqual([expect.stringMatching(/Guest count was not applied .*wanted 4, page shows 2/)]);
    const missing = caveats();
    verifyControls({ checkin: null, checkout: null, travelers: null, setDates: false }, PARIS, missing.push);
    expect(missing.list).toEqual([expect.stringMatching(/unknown dates/), expect.stringMatching(/page shows unknown/)]);
  });
});

const ORGANIC: RawCard = {
  kind: "organic",
  name: "Les Patios du Marais",
  priceLabel: "Prices starting from $150, Les Patios du Marais DEAL 20% less than usual",
  href: "/travel/hotels/entity/ChkIy5q-tZ-KsLYZGg0vZy8xMWd5MXR3Y2d6EAE?q=hotels+in+Paris&hl=en&curr=USD",
  ratingLabel: null,
  amenities: "Amenities for Les Patios du Marais: Free Wi-Fi, Kitchen in rooms, Airport shuttle, Accessible, Kid-friendly, Smoke-free property, ",
  text: 'Les Patios du Marais | DEAL | $150 | 20% less than usual | Excellent location | Free Wi-Fi | Kitchen in rooms | Airport shuttle | Accessible | Kid-friendly | Smoke-free property | "Ok prices good rooms for their small sizes." | View prices',
  fullText:
    "Les Patios du MaraisDEAL$150$150 nightly$505 total3 nights with taxes + fees$15020% less than usual·Excellent location4.8 Excellent location overall for sightseeing, recreation, dining, and getting aroundAmenities for Les Patios du Marais: Free Wi-Fi, Kitchen in rooms, Airport shuttle, Accessible, Kid-friendly, Smoke-free property, Free Wi-FiKitchen in roomsAirport shuttleAccessibleKid-friendlySmoke-free propertyView prices",
};

const SPONSORED: RawCard = {
  kind: "sponsored",
  name: "Miiro Le Grand Hôtel Cayré",
  priceLabel: null,
  href: null,
  ratingLabel: "4.4 out of 5 stars from 1,044 reviews",
  amenities: null,
  text: "Miiro Le Grand Hôtel Cayré | €653 | Miiro Le Grand Hôtel Cayré | 4.4/5 | (1.0K) | · 4-star hotel | Pet-friendly · Fitness center",
  fullText: "Miiro Le Grand Hôtel Cayré€653 Miiro Le Grand Hôtel Cayré4.4/5 (1.0K) · 4-star hotelPet-friendly · Fitness center",
};

describe("assembleCard (deterministic path)", () => {
  it("reads an organic card as recorded live", () => {
    const r = assembleCard(ORGANIC, { query: PARIS });
    expect("hotel" in r).toBe(true);
    if (!("hotel" in r)) return;
    expect(r.hotel).toEqual({
      id: hotelId("Les Patios du Marais", "$150"),
      source: "google_hotels",
      name: "Les Patios du Marais",
      price_per_night: { amount: 150, currency: "USD" },
      total_price: { amount: 505, currency: "USD" },
      location_note: "Excellent location",
      amenities: ["Free Wi-Fi", "Kitchen in rooms", "Airport shuttle", "Accessible", "Kid-friendly", "Smoke-free property"],
      tags: ["DEAL", "20% less than usual"],
      url: "https://www.google.com/travel/hotels/entity/ChkIy5q-tZ-KsLYZGg0vZy8xMWd5MXR3Y2d6EAE",
      availability: "available",
    });
    expect(HotelResultSchema.safeParse(r.hotel).success).toBe(true);
  });

  it("reads a sponsored card with its rating, review count, class and the advertiser's currency", () => {
    const r = assembleCard(SPONSORED, { query: PARIS });
    expect("hotel" in r && r.hotel).toMatchObject({
      name: "Miiro Le Grand Hôtel Cayré",
      price_per_night: { amount: 653, currency: "EUR" },
      rating: 4.4,
      review_count: 1044,
      star_class: 4,
      type: "hotel",
      amenities: ["Pet-friendly", "Fitness center"],
      tags: ["Sponsored"],
      availability: "available",
    });
    expect("hotel" in r && r.hotel.url).toBeUndefined();
    expect("hotel" in r && r.hotel.total_price).toBeUndefined();
  });

  it("marks a card without a price as unknown and a sold-out card as sold_out", () => {
    const noPrice = assembleCard({ ...ORGANIC, priceLabel: null, fullText: "Les Patios du Marais View prices", text: "Les Patios du Marais | View prices" }, { query: PARIS });
    expect("hotel" in noPrice && noPrice.hotel).toMatchObject({ availability: "unknown" });
    expect("hotel" in noPrice && noPrice.hotel.price_per_night).toBeUndefined();
    const sold = assembleCard({ ...ORGANIC, priceLabel: null, fullText: "Les Patios du Marais Sold out", text: "Les Patios du Marais | Sold out" }, { query: PARIS });
    expect("hotel" in sold && sold.hotel).toMatchObject({ availability: "sold_out", tags: [] });
  });

  it("drops a card with no name or an unreadable price", () => {
    expect(assembleCard({ ...ORGANIC, name: " " }, { query: PARIS })).toEqual({ drop: "no name" });
    const bad = assembleCard({ ...ORGANIC, priceLabel: "Prices starting from blah, X", fullText: "X" }, { query: PARIS });
    expect("drop" in bad && bad.drop).toMatch(/unreadable price/);
  });

  it("merges pages without duplicates", () => {
    const merged = mergeCards([[SPONSORED, ORGANIC], [ORGANIC, { ...ORGANIC, name: "Other" }]]);
    expect(merged.map((c) => c.name)).toEqual(["Miiro Le Grand Hôtel Cayré", "Les Patios du Marais", "Other"]);
  });
});

describe("assembleExtracted (LLM path)", () => {
  const canned = cannedExtraction().hotels;
  const pageText = [
    "Best Western Hôtel Rives de Paris La Défense\n$83\nEco-certified",
    "Hôtel Trianon Saint Ouen\nSold out\n2-star tourist hotel · Free Wi-Fi · Parking",
  ].join("\n");
  const ctx = { query: PARIS, cards: [] as RawCard[], pageText };

  it("validates a hotel the model read from the page text", () => {
    const r = assembleExtracted(canned[0] as ExtractedHotel, ctx);
    expect("hotel" in r && r.hotel).toMatchObject({
      name: "Best Western Hôtel Rives de Paris La Défense",
      price_per_night: { amount: 83, currency: "USD" },
      star_class: 3,
      type: "tourist hotel",
      tags: ["Eco-certified"],
      availability: "available",
    });
    const sold = assembleExtracted(canned[8] as ExtractedHotel, ctx);
    expect("hotel" in sold && sold.hotel).toMatchObject({ availability: "sold_out", star_class: 2 });
    expect("hotel" in sold && sold.hotel.price_per_night).toBeUndefined();
  });

  it.each([
    ["a price that is not in the text", { ...(canned[0] as ExtractedHotel), price_text: "$99" }, /does not appear/],
    ["a name that is not in the text", { ...(canned[0] as ExtractedHotel), name: "Hotel Nowhere" }, /does not appear/],
    ["an unreadable price", { ...(canned[0] as ExtractedHotel), price_text: "$83", name: "Best Western Hôtel Rives de Paris La Défense" }, undefined],
  ])("handles %s", (_name, raw, reason) => {
    const r = assembleExtracted(raw, ctx);
    if (reason === undefined) expect("hotel" in r).toBe(true);
    else expect("drop" in r && r.drop).toMatch(reason);
  });

  it("cross-checks against the card the item names and inherits its url and Sponsored tag", () => {
    const cards = [ORGANIC, SPONSORED];
    const r = assembleExtracted(
      { ...(canned[1] as ExtractedHotel), item: 0, price_text: "$150", total_text: "$505", rating: 4.9, review_count: 12 },
      { query: PARIS, cards, pageText: "" },
    );
    expect("hotel" in r && r.hotel).toMatchObject({
      url: "https://www.google.com/travel/hotels/entity/ChkIy5q-tZ-KsLYZGg0vZy8xMWd5MXR3Y2d6EAE",
      total_price: { amount: 505, currency: "USD" },
      rating: 4.9,
      review_count: 12,
    });
    const ad = assembleExtracted(
      { ...(canned[1] as ExtractedHotel), item: 1, name: "Miiro Le Grand Hôtel Cayré", price_text: "€653", tags: ["Ad"] },
      { query: PARIS, cards, pageText: "" },
    );
    expect("hotel" in ad && ad.hotel.tags).toEqual(["Sponsored", "Ad"]);
    const outside = assembleExtracted({ ...(canned[1] as ExtractedHotel), item: 7 }, { query: PARIS, cards, pageText: "" });
    expect("drop" in outside && outside.drop).toMatch(/does not match any card/);
  });
});

describe.skipIf(!probe.available)(`google-hotels recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: HotelsServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startHotelsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  /** Methods a read-only recipe must never call. */
  function spyOnTyping(page: Page): Array<{ name: string; spy: ReturnType<typeof vi.spyOn> }> {
    return [
      { name: "page.fill", spy: vi.spyOn(page, "fill") },
      { name: "page.type", spy: vi.spyOn(page, "type") },
      { name: "page.press", spy: vi.spyOn(page, "press") },
      { name: "keyboard.type", spy: vi.spyOn(page.keyboard, "type") },
      { name: "keyboard.press", spy: vi.spyOn(page.keyboard, "press") },
      { name: "keyboard.insertText", spy: vi.spyOn(page.keyboard, "insertText") },
    ];
  }

  async function runRecipe(
    path: string,
    query: NormalizedHotelsQuery,
    llm: LlmClient = forbiddenLlm(),
    over: Partial<RecipeContext> & { grace?: number } = {},
  ) {
    const recipe = createGoogleHotelsRecipe({
      baseUrl: `${server.url}${path}`,
      pollMs: 50,
      nextPageWaitMs: 1500,
      ...(over.grace !== undefined && { noResultsGraceMs: over.grace }),
    });
    const log = makeLogger();
    const caveats: string[] = [];
    const page = await session.acquire();
    const spies = spyOnTyping(page);
    try {
      const ctx: RecipeContext = { llm, log, deadline: Date.now() + 30_000, caveats, ...over };
      const settled: { hotels?: HotelResult[]; error?: unknown } = await recipe.run(page, query, ctx).then(
        (hotels) => ({ hotels }),
        (error: unknown) => ({ error }),
      );
      const consent = await page.evaluate<string | null>(`document.documentElement.getAttribute("data-consent")`).catch(() => null);
      const pageNo = await page.evaluate<string | null>(`document.documentElement.getAttribute("data-page")`).catch(() => null);
      for (const s of spies) expect(s.spy, `${s.name} must never be called by the recipe`).not.toHaveBeenCalled();
      return { ...settled, log, caveats, llm, consent, pageNo };
    } finally {
      for (const s of spies) s.spy.mockRestore();
      await session.release(page);
    }
  }

  it("reads the live-DOM fixture deterministically: no model call, 10+ hotels with name and nightly price, 3 pages", async () => {
    const llm = forbiddenLlm();
    const meter = new CostMeter();
    const r = await runRecipe("/results", PARIS, llm, { meter });
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
    expect(r.consent).toBe("rejected");
    expect(r.pageNo).toBe("3");
    expect(r.caveats.some((c) => /cookie consent dialog/i.test(c))).toBe(true);

    const hotels = r.hotels!;
    for (const h of hotels) expect(HotelResultSchema.safeParse(h).success).toBe(true);
    expect(new Set(hotels.map((h) => h.id)).size).toBe(hotels.length);
    expect(hotels.every((h) => h.source === "google_hotels")).toBe(true);

    const organic = hotels.filter((h) => !h.tags.includes("Sponsored"));
    const sponsored = hotels.filter((h) => h.tags.includes("Sponsored"));
    // 9 ads first (as on the page), then 12 + 6 + 7 organic cards over the three pages.
    expect(sponsored).toHaveLength(9);
    expect(organic).toHaveLength(25);
    expect(hotels.slice(0, 9)).toEqual(sponsored);
    expect(organic.length).toBeGreaterThanOrEqual(10);
    expect(organic.every((h) => h.name.length > 0 && h.price_per_night !== undefined && h.price_per_night.currency === "USD")).toBe(true);
    expect(organic.every((h) => h.url?.startsWith("https://www.google.com/travel/hotels/entity/"))).toBe(true);
    expect(organic.every((h) => h.availability === "available")).toBe(true);
    // The hidden tooltip gives the stay total with taxes and fees.
    expect(organic.every((h) => h.total_price !== undefined && h.total_price.amount > h.price_per_night!.amount)).toBe(true);
    // Guest ratings: present on every sponsored card (the only place the live page printed them), absent on the organic cards.
    expect(sponsored.every((h) => h.rating !== undefined && h.review_count !== undefined && h.review_count > 0)).toBe(true);
    expect(sponsored.every((h) => h.price_per_night?.currency === "EUR")).toBe(true);
    expect(organic.every((h) => h.rating === undefined && h.review_count === undefined)).toBe(true);

    const first = organic[0]!;
    expect(first).toMatchObject({
      name: "Best Western Hôtel Rives de Paris La Défense",
      price_per_night: { amount: 83, currency: "USD" },
      total_price: { amount: 308, currency: "USD" },
      star_class: 3,
      type: "tourist hotel",
      tags: ["Eco-certified"],
      url: "https://www.google.com/travel/hotels/entity/ChoI7I7dwpH68_zKARoNL2cvMTFiN3J4azV6OBAB",
    });
    expect(first.amenities).toEqual(["Breakfast", "Free Wi-Fi", "Air conditioning", "Pet-friendly", "Restaurant", "Airport shuttle", "Kid-friendly", "Smoke-free property"]);
    const patios = organic.find((h) => h.name === "Les Patios du Marais")!;
    expect(patios).toMatchObject({
      price_per_night: { amount: 150, currency: "USD" },
      total_price: { amount: 505, currency: "USD" },
      location_note: "Excellent location",
    });
    // The DEAL badge overlays the photo and comes last in the DOM.
    expect([...patios.tags].sort()).toEqual(["20% less than usual", "DEAL"]);
    expect(patios.star_class).toBeUndefined();
    const ad = sponsored[0]!;
    expect(ad).toMatchObject({
      name: "Miiro Le Grand Hôtel Cayré",
      price_per_night: { amount: 653, currency: "EUR" },
      rating: 4.4,
      review_count: 1044,
      star_class: 4,
      type: "hotel",
      amenities: ["Pet-friendly", "Fitness center"],
      tags: ["Sponsored"],
    });
    expect(ad.url).toBeUndefined();
    // Classes and types from the amenities sentence, as printed.
    expect(organic.filter((h) => h.star_class !== undefined).length).toBeGreaterThanOrEqual(8);
    expect(new Set(organic.map((h) => h.type).filter(Boolean))).toEqual(new Set(["tourist hotel", "tourist residence"]));

    expect(r.caveats.some((c) => /"Next" page after 3 page\(s\)/.test(c) && /Showing results 37 - 54 of 3,775/.test(c))).toBe(true);
    expect(r.caveats.some((c) => /Sponsored/.test(c))).toBe(true);
    expect(r.caveats.some((c) => /no guest rating for 25 of 34 hotels/.test(c))).toBe(true);
    expect(r.caveats.some((c) => /not applied/.test(c))).toBe(false);
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  it("applies the contract's filters in code and says what they hid", async () => {
    const r = await runRecipe("/results", { ...PARIS, max_price_per_night: 100, star_classes: [3, 4] });
    expect(r.error).toBeUndefined();
    const hotels = r.hotels!;
    expect(hotels.length).toBeGreaterThan(0);
    expect(hotels.every((h) => h.price_per_night!.amount <= 100 && h.price_per_night!.currency === "USD" && [3, 4].includes(h.star_class!))).toBe(true);
    expect(r.caveats.some((c) => /did not match the filters/.test(c) && /priced in another currency than USD/.test(c))).toBe(true);
    // Ratings are absent on organic cards, so min_rating removes them and says so.
    const rated = await runRecipe("/results", { ...PARIS, min_rating: 4.5 });
    expect(rated.hotels!.every((h) => h.rating !== undefined && h.rating >= 4.5 && h.tags.includes("Sponsored"))).toBe(true);
    expect(rated.caveats.some((c) => /below min_rating or without a guest rating/.test(c))).toBe(true);
  });

  it("caveats dates and guests the page did not apply", async () => {
    const r = await runRecipe("/results", { ...PARIS, check_in: "2026-12-01", check_out: "2026-12-04", guests: { adults: 3, children: 1 } });
    expect(r.error).toBeUndefined();
    expect(r.caveats.some((c) => /Dates were not applied .*wanted Dec 1 to Dec 4, page shows Fri, Nov 20 to Mon, Nov 23/.test(c))).toBe(true);
    expect(r.caveats.some((c) => /Guest count was not applied .*wanted 4, page shows 2/.test(c))).toBe(true);
  });

  it("falls back to the extractor when the page has no card structure, and validates its answer", async () => {
    const llm = scriptedLlm(() => cannedExtraction());
    const meter = new CostMeter();
    const r = await runRecipe("/unstructured", PARIS, llm, { meter, grace: 500 });
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    expect(req.role).toBe("extractor");
    expect(req.effort).toBe("medium");
    expect(req.maxTokens).toBe(16_000);
    expect(req.meter).toBe(meter);
    expect(req.schema).toBeDefined();
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.system).toMatch(/never use outside knowledge/i);
    expect(promptOf(req)).toContain("Page text (not split into cards; use item -1)");
    expect(promptOf(req)).toContain("Glint Paris");
    expect(promptOf(req)).toContain("Showing results 1 - 9 of 3,775");

    const hotels = r.hotels!;
    expect(hotels).toHaveLength(9);
    for (const h of hotels) expect(HotelResultSchema.safeParse(h).success).toBe(true);
    expect(hotels.map((h) => h.name)).toContain("Glint Paris");
    expect(hotels.find((h) => h.name === "Glint Paris")).toMatchObject({ price_per_night: { amount: 74, currency: "USD" }, tags: ["GREAT DEAL", "33% less than usual"] });
    expect(hotels.find((h) => h.name === "Hôtel Trianon Saint Ouen")).toMatchObject({ availability: "sold_out", star_class: 2 });
    expect(hotels.every((h) => h.url === undefined)).toBe(true);
    expect(r.caveats.some((c) => /read by the extraction model/.test(c))).toBe(true);
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  it("drops extracted hotels that contradict the page and warns, keeping the rest", async () => {
    const bad = cannedExtraction();
    bad.hotels[2]!.price_text = "$999";
    bad.hotels[3]!.name = "Hotel Nowhere";
    const r = await runRecipe("/unstructured", PARIS, scriptedLlm(() => bad), { grace: 500 });
    expect(r.hotels).toHaveLength(7);
    expect(r.log.warn).toHaveBeenCalledTimes(2);
  });

  it("fails with a provider error when nothing extracted is valid", async () => {
    const r = await runRecipe("/unstructured", PARIS, scriptedLlm(() => ({ hotels: [] })), { grace: 500 });
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("provider");
  });

  it("fails with config, naming ANTHROPIC_API_KEY, when the probe fails and no LLM is available", async () => {
    const r = await runRecipe("/unstructured", PARIS, missingLlmClient(), { grace: 500 });
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("config");
    expect((r.error as RecipeError).message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("throws blocked for the unusual-traffic page and never calls the model", async () => {
    const llm = forbiddenLlm();
    const r = await runRecipe("/blocked", PARIS, llm);
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("blocked");
    expect((r.error as RecipeError).message).toMatch(/unusual traffic|bot/i);
    expect((r.error as RecipeError).retryable).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it("throws blocked for HTTP 429 and 403", async () => {
    expect(((await runRecipe("/status/429", PARIS)).error as RecipeError).code).toBe("blocked");
    expect(((await runRecipe("/status/403", PARIS)).error as RecipeError).code).toBe("blocked");
  });

  it("returns an empty list, with a caveat, when Google shows no hotels", async () => {
    const llm = forbiddenLlm();
    const r = await runRecipe("/empty", PARIS, llm, { grace: 600 });
    expect(r.error).toBeUndefined();
    expect(r.hotels).toEqual([]);
    expect(r.caveats.some((c) => /no results/i.test(c))).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("throws timeout when results never arrive within the deadline", async () => {
    const t0 = Date.now();
    const r = await runRecipe("/stalled", PARIS, forbiddenLlm(), { deadline: Date.now() + 2500 });
    expect((r.error as RecipeError).code).toBe("timeout");
    expect((r.error as RecipeError).retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("throws timeout at once when the deadline has passed", async () => {
    const llm = forbiddenLlm();
    const r = await runRecipe("/results", PARIS, llm, { deadline: Date.now() - 1 });
    expect((r.error as RecipeError).code).toBe("timeout");
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a malformed query", async () => {
    const r = await runRecipe("/results", { ...PARIS, nights: 0 });
    expect((r.error as RecipeError).code).toBe("invalid_input");
  });

  it("propagates an LLM failure as a provider error", async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new Error("boom")) };
    const r = await runRecipe("/unstructured", PARIS, llm, { grace: 500 });
    expect((r.error as RecipeError).code).toBe("provider");
  });
});

describe("recipe definition", () => {
  it("declares its site, schemas and url builder", () => {
    expect(googleHotelsRecipe.site).toBe("google_hotels");
    expect(googleHotelsRecipe.paramsSchema.safeParse(PARIS).success).toBe(true);
    expect(googleHotelsRecipe.resultSchema.safeParse([]).success).toBe(true);
    expect(cannedExtraction().hotels).toHaveLength(9);
  });
});
