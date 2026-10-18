import { describe, expect, it } from "vitest";
import { filterAndSortHotels, HotelsInputError, normalizeHotelsInput } from "../../../src/core/hotels/normalize.js";
import type { HotelResult } from "../../../src/schemas/hotels.js";
import { PARIS } from "./gh-helpers.js";

const config = { currency: "usd" };
const ARGS = { destination: " Paris ", check_in: "2026-11-20", check_out: "2026-11-23" };

describe("normalizeHotelsInput", () => {
  it("applies the defaults, trims, computes nights and uses the config currency", () => {
    expect(normalizeHotelsInput(ARGS, config)).toEqual({
      destination: "Paris",
      check_in: "2026-11-20",
      check_out: "2026-11-23",
      nights: 3,
      guests: { adults: 2, children: 0 },
      sort: "relevance",
      sources: ["google_hotels"],
      currency: "USD",
      max_results: 20,
    });
  });

  it("keeps filters, guests, sort, currency and sources from the input", () => {
    const q = normalizeHotelsInput(
      {
        ...ARGS,
        guests: { adults: 3, children: 1 },
        max_price_per_night: 150,
        min_rating: 4,
        star_classes: [5, 3, 3],
        sort: "price",
        currency: "eur",
        max_results: 5,
        sources: ["google_hotels", "google_hotels"],
      },
      config,
    );
    expect(q).toMatchObject({
      guests: { adults: 3, children: 1 },
      max_price_per_night: 150,
      min_rating: 4,
      star_classes: [3, 5],
      sort: "price",
      currency: "EUR",
      max_results: 5,
      sources: ["google_hotels"],
    });
  });

  it("uses the configured sources as the default", () => {
    expect(normalizeHotelsInput(ARGS, config, { defaultSources: ["google_hotels"] }).sources).toEqual(["google_hotels"]);
  });

  it.each([
    ["check_out before check_in", { ...ARGS, check_out: "2026-11-19" }, /after check_in/],
    ["the same day", { ...ARGS, check_out: "2026-11-20" }, /after check_in/],
    ["more than 30 nights", { ...ARGS, check_out: "2026-12-21" }, /30 nights/],
    ["a fake date", { ...ARGS, check_in: "2026-02-30" }, /real calendar date/],
    ["an empty destination", { ...ARGS, destination: "  " }, /destination/],
    ["a bad currency", { ...ARGS, currency: "dollars" }, /ISO 4217/],
    ["too many adults", { ...ARGS, guests: { adults: 9 } }, /adults/],
    ["a bad star class", { ...ARGS, star_classes: [1] }, /star_classes/],
  ])("rejects %s as invalid_input", (_name, input, reason) => {
    expect(() => normalizeHotelsInput(input, config)).toThrow(HotelsInputError);
    expect(() => normalizeHotelsInput(input, config)).toThrow(reason);
  });
});

function hotel(name: string, over: Partial<HotelResult> = {}): HotelResult {
  return {
    id: `google_hotels:${name}`,
    source: "google_hotels",
    name,
    amenities: [],
    tags: [],
    availability: "available",
    ...over,
  };
}
const usd = (amount: number) => ({ amount, currency: "USD" });

const HOTELS: HotelResult[] = [
  hotel("a", { price_per_night: usd(120), rating: 4.2, star_class: 4 }),
  hotel("b", { price_per_night: usd(80), rating: 4.6, star_class: 3 }),
  hotel("c", { price_per_night: { amount: 50, currency: "EUR" }, rating: 4.9, star_class: 5 }),
  hotel("d", { rating: 3.9, star_class: 2, availability: "unknown" }),
  hotel("e", { price_per_night: usd(95) }),
  hotel("f", { price_per_night: usd(95), rating: 4.6, star_class: 4 }),
];

describe("filterAndSortHotels", () => {
  it("keeps the page order and everything with no filters", () => {
    const r = filterAndSortHotels(HOTELS, PARIS);
    expect(r.hotels.map((h) => h.name)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(r).toMatchObject({ hiddenByPrice: 0, hiddenByCurrency: 0, hiddenByRating: 0, hiddenByStars: 0, omitted: 0 });
  });

  it.each([
    ["max_price_per_night", { max_price_per_night: 100 }, ["b", "e", "f"], { hiddenByPrice: 2, hiddenByCurrency: 1 }],
    ["min_rating (unrated removed)", { min_rating: 4.5 }, ["b", "c", "f"], { hiddenByRating: 3 }],
    ["star_classes (unclassed removed)", { star_classes: [4, 5] as (4 | 5)[] }, ["a", "c", "f"], { hiddenByStars: 3 }],
    ["all three", { max_price_per_night: 100, min_rating: 4.5, star_classes: [3, 4] as (3 | 4)[] }, ["b", "f"], { hiddenByPrice: 2, hiddenByCurrency: 1, hiddenByRating: 1 }],
  ])("filters by %s", (_name, filters, expected, counts) => {
    const r = filterAndSortHotels(HOTELS, { ...PARIS, ...filters });
    expect(r.hotels.map((h) => h.name)).toEqual(expected);
    expect(r).toMatchObject(counts);
  });

  it("sorts by price ascending with unpriced rows last, ties in page order", () => {
    const r = filterAndSortHotels(HOTELS, { ...PARIS, sort: "price" });
    expect(r.hotels.map((h) => h.name)).toEqual(["c", "b", "e", "f", "a", "d"]);
  });

  it("sorts by rating descending with unrated rows last, ties in page order", () => {
    const r = filterAndSortHotels(HOTELS, { ...PARIS, sort: "rating" });
    expect(r.hotels.map((h) => h.name)).toEqual(["c", "b", "f", "a", "d", "e"]);
  });

  it("caps at max_results and counts what was left out", () => {
    const r = filterAndSortHotels(HOTELS, { ...PARIS, sort: "price", max_results: 2 });
    expect(r.hotels.map((h) => h.name)).toEqual(["c", "b"]);
    expect(r.omitted).toBe(4);
  });
});
