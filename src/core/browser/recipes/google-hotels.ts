import { createHash } from "node:crypto";
import { errors as playwrightErrors, type Page } from "playwright";
import { z } from "zod";
import {
  HotelResultSchema,
  MAX_AMENITIES,
  MAX_HOTELS_LIMIT,
  NormalizedHotelsQuerySchema,
  type HotelResult,
  type NormalizedHotelsQuery,
} from "../../../schemas/hotels.js";
import { detectBotWall } from "../../fetch/browser.js";
import { filterAndSortHotels } from "../../hotels/normalize.js";
import { LlmError, type LlmClient } from "../../llm/types.js";
import { RecipeError, type Recipe, type RecipeContext } from "./types.js";

/**
 * Google Hotels recipe (PLAN.md 14.1, 4.5, WP17).
 *
 * Personal use only: reading Google Hotels automatically is against Google's
 * terms of service (PLAN.md 14.0). No stealth, no CAPTCHA solving: a bot wall
 * is reported as `blocked`. The recipe only navigates, waits, scrolls and
 * clicks read-only controls (consent, "Next" page); it never types.
 *
 * Verified live on 2026-10-18 from a headless Chromium in the development
 * environment (8 page loads, all HTTP 200, no consent dialog, no CAPTCHA):
 *
 *   Dates are set by the natural-language query only:
 *     https://www.google.com/travel/search?q=hotels%20in%20Paris%20from%202026-11-20%20to%202026-11-23%20for%202%20adults&hl=en&curr=USD
 *   gave Check-in "Fri, Nov 20", Check-out "Mon, Nov 23" and "Paris · 3,775 results".
 *   The parameter form `checkin=2026-11-20&checkout=2026-11-23` did NOT set the
 *   dates: the page kept today's dates and showed "Set your dates to update
 *   prices / Prices shown for Oct 18 – 19" (the entity links did carry the params).
 *   Guests: neither "for 3 adults and 1 child" in the text nor `adults=3&children=1`
 *   changed the travelers control (it stayed "Current number of travelers is 2").
 *   Both are still sent; `verifyControls` reads the controls back and caveats.
 *   `curr` sets the display currency, `hl=en` forces the English labels the
 *   probes rely on.
 *
 * Page structure (verified): each organic result is a `div` holding an empty
 * `a[role=link][aria-label=<name>][href=/travel/hotels/entity/<id>?...]`, an
 * `h2` with the name, a price link
 *   `a[aria-label="Prices starting from $83, <name>[ DEAL 18% less than usual]"]`
 * whose visible text is "$83" and "Nov 20 – 23" and whose hidden tooltip
 * (`[role=dialog][aria-live=polite]`) reads "$83 nightly", "$308 total",
 * "3 nights with taxes + fees"; badges "DEAL", "GREAT DEAL", "GREAT PRICE",
 * "18% less than usual", "Eco-certified", "Excellent location" (with an svg
 * labelled "4.7 out of 5": a LOCATION score, not a guest rating); an amenities
 * sentence in `span[role=document]`:
 *   "Amenities for <name>, a 3-star tourist hotel.: Breakfast, Free Wi-Fi, ..."
 * and `a[aria-label="View prices for <name>"]`. 18 cards per page, then a
 * "Next" button and "Showing results 1 - 18 of 3,775". Clicking "Next" changed
 * nothing within 15 s in this environment (button visible and enabled); the
 * recipe tries at most twice and caveats either way.
 *
 * Guest ratings and review counts were ABSENT from every organic card in every
 * run (Paris and Lisbon, gl=ZZ and gl=us, headless and regular user agent).
 * Only the "Sponsored" list (`li` with an `/aclk` ad link) showed them, as
 * `[role=img][aria-label="4.4 out of 5 stars from 1,044 reviews"]` plus the
 * text "4.4/5 (1.0K) · 4-star hotel · Pet-friendly · Fitness center"; ad prices
 * were printed in the advertiser's currency (EUR with curr=USD). Sponsored rows
 * are returned tagged "Sponsored". No "sold out" row was seen; a card without
 * a price is reported with availability "unknown", one saying "Sold out" as
 * "sold_out". A destination Google does not know renders the filters form and
 * footer with no cards, no "N results" heading and no message.
 */

export const GOOGLE_HOTELS_SITE = "google_hotels";
export const GOOGLE_HOTELS_BASE_URL = "https://www.google.com/travel/search";
/** Origin of the hotel entity pages a card links to. */
export const GOOGLE_HOTELS_ORIGIN = "https://www.google.com";

/** Fewer deterministic records than this and the LLM fallback runs. */
export const MIN_PROBE_RECORDS = 3;
/** Most card texts sent to the model. */
export const MAX_LLM_CARDS = 60;
/** Most page text sent to the model when no card structure was found. */
const MAX_PAGE_TEXT = 30_000;

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** True when the query asks for anything other than 2 adults, Google's default. */
export function nonDefaultGuests(q: NormalizedHotelsQuery): boolean {
  return q.guests.adults !== 2 || q.guests.children !== 0;
}

function guestClause(q: NormalizedHotelsQuery): string {
  const adults = plural(q.guests.adults, "adult", "adults");
  return q.guests.children > 0 ? `${adults} and ${plural(q.guests.children, "child", "children")}` : adults;
}

/** The natural-language query Google Hotels parses (dates verified live; guests are read back). */
export function buildQueryText(q: NormalizedHotelsQuery): string {
  let text = `hotels in ${q.destination} from ${q.check_in} to ${q.check_out}`;
  if (nonDefaultGuests(q)) text += ` for ${guestClause(q)}`;
  return text;
}

export function buildGoogleHotelsUrl(q: NormalizedHotelsQuery, baseUrl: string = GOOGLE_HOTELS_BASE_URL): string {
  const params = new URLSearchParams();
  params.set("q", buildQueryText(q));
  params.set("hl", "en");
  params.set("curr", q.currency);
  if (nonDefaultGuests(q)) {
    params.set("adults", String(q.guests.adults));
    params.set("children", String(q.guests.children));
  }
  // URLSearchParams encodes spaces as "+"; Google accepts both, but %20 is what the site itself emits.
  return `${baseUrl}?${params.toString().replaceAll("+", "%20")}`;
}

// ---------------------------------------------------------------------------
// Money and label parsing (pure, exported for tests)
// ---------------------------------------------------------------------------

const SYMBOL_CURRENCY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(US\$|USD)/, "USD"], [/^(CA\$|C\$|CAD)/, "CAD"], [/^(A\$|AU\$|AUD)/, "AUD"], [/^(NZ\$|NZD)/, "NZD"],
  [/^(S\$|SGD)/, "SGD"], [/^(HK\$|HKD)/, "HKD"], [/^(MX\$|MXN)/, "MXN"], [/^(R\$|BRL)/, "BRL"], [/^(NT\$|TWD)/, "TWD"],
  [/^€|^EUR/, "EUR"], [/^£|^GBP/, "GBP"], [/^¥|^JP¥|^JPY/, "JPY"], [/^CN¥|^CNY|^RMB/, "CNY"], [/^₹|^INR/, "INR"],
  [/^₩|^KRW/, "KRW"], [/^₺|^TRY/, "TRY"], [/^₽|^RUB/, "RUB"], [/^₪|^ILS/, "ILS"], [/^₱|^PHP/, "PHP"], [/^₫|^VND/, "VND"],
  [/^฿|^THB/, "THB"], [/^CHF/, "CHF"], [/^zł|^PLN/, "PLN"], [/^Kč|^CZK/, "CZK"], [/^Ft|^HUF/, "HUF"], [/^R(?=\s?\d)|^ZAR/, "ZAR"],
  [/^AED/, "AED"], [/^SAR/, "SAR"], [/^kr/, "kr"],
];
const DOLLAR_CURRENCIES = new Set(["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN", "TWD"]);
const KRONE_CURRENCIES = new Set(["SEK", "NOK", "DKK", "ISK"]);

export interface Money {
  amount: number;
  currency: string;
}

/**
 * "$83", "€1,319", "CHF 240", "1 200 kr", "US$83", "83 USD" to an amount and
 * an ISO code. A bare "$" is the query currency when that is a dollar, else USD;
 * "kr" is the query currency when that is a krone, else unusable. Undefined when
 * the text is not a price.
 */
export function parseMoney(text: string | null | undefined, queryCurrency: string): Money | undefined {
  if (text === null || text === undefined) return undefined;
  const t = text.replace(/\u00a0/g, " ").trim();
  const m = /^([^\d\s]{0,4}|[A-Z]{3}|US\$|CA\$|AU\$|NZ\$|HK\$|MX\$|NT\$|R\$|S\$|C\$|A\$|JP¥|CN¥)\s?(\d[\d,.\s]*\d|\d)\s?([^\d\s]{0,4}|[A-Z]{3})?$/.exec(t);
  if (m === null) return undefined;
  const [, prefix, number, suffix] = m;
  const digits = (number as string).replace(/[\s,]/g, "");
  // "1.234" with exactly three trailing digits after a dot is a thousands separator in many locales.
  const amount = /^\d{1,3}\.\d{3}$/.test(digits) ? Number(digits.replace(".", "")) : Number(digits);
  if (!Number.isFinite(amount)) return undefined;
  const code = currencyOf(prefix ?? "", queryCurrency) ?? currencyOf(suffix ?? "", queryCurrency);
  if (code === undefined) return undefined;
  return { amount, currency: code };
}

function currencyOf(mark: string, queryCurrency: string): string | undefined {
  const s = mark.trim();
  if (s === "") return undefined;
  if (/^[A-Z]{3}$/.test(s)) return s;
  for (const [re, code] of SYMBOL_CURRENCY) {
    if (!re.test(s)) continue;
    if (code === "kr") return KRONE_CURRENCIES.has(queryCurrency) ? queryCurrency : undefined;
    return code;
  }
  if (s === "$") return DOLLAR_CURRENCIES.has(queryCurrency) ? queryCurrency : "USD";
  return undefined;
}

/** "1,044" to 1044, "1.0K" to 1000, "2.2K" to 2200, "1M" to 1000000. */
export function parseCount(text: string): number | undefined {
  const m = /^([\d,.]+)\s*([KkMm])?$/.exec(text.trim());
  if (m === null) return undefined;
  const base = Number((m[1] as string).replace(/,/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const mult = m[2] === undefined ? 1 : /k/i.test(m[2]) ? 1000 : 1_000_000;
  return Math.round(base * mult);
}

/** The guest rating and review count a "4.4 out of 5 stars from 1,044 reviews" label states. */
export function parseRatingLabel(label: string | null | undefined): { rating: number; review_count?: number } | undefined {
  if (label === null || label === undefined) return undefined;
  const m = /\b([0-5](?:[.,]\d)?) out of 5 stars?(?: from ([\d,.]+\s*[KkMm]?) reviews?)?/i.exec(label);
  if (m === null) return undefined;
  const rating = Number((m[1] as string).replace(",", "."));
  const count = m[2] !== undefined ? parseCount(m[2]) : undefined;
  return { rating, ...(count !== undefined && { review_count: count }) };
}

/** "Amenities for X, a 3-star tourist hotel.: Breakfast, Free Wi-Fi, " to its parts. */
export function parseAmenitiesSentence(text: string | null | undefined): {
  star_class?: number;
  type?: string;
  amenities: string[];
} {
  if (text === null || text === undefined) return { amenities: [] };
  const clause = /,\s*an?\s+(?:(\d)-star\s+)?([^.:]+?)\.?\s*:/i.exec(text);
  const after = text.includes(":") ? text.slice(text.indexOf(":") + 1) : "";
  const amenities = dedupe(after.split(",").map((a) => a.trim()).filter((a) => a !== ""));
  const star = clause?.[1] !== undefined ? Number(clause[1]) : undefined;
  const type = clause?.[2]?.trim().toLowerCase();
  return {
    ...(star !== undefined && star >= 1 && star <= 5 && { star_class: star }),
    ...(type !== undefined && type !== "" && { type }),
    amenities: amenities.slice(0, MAX_AMENITIES),
  };
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const key = i.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/** The price a "Prices starting from $83, Name DEAL 18% less than usual" label states, as printed. */
export function labelPriceText(label: string | null | undefined): string | undefined {
  if (label === null || label === undefined) return undefined;
  const m = /^Prices starting from\s+(\S+?),/i.exec(label);
  return m?.[1];
}

const STAR_TYPE_RE = /\b([1-5])-star\s+([a-z][a-z &-]*?)(?=[\s,.·|]|$)/i;
/** A printed amount with its currency mark, e.g. "$83", "€1,319", "CHF 240", "83 USD", "1 200 kr". */
const MONEY_TOKEN = String.raw`(?:US\$|CA\$|AU\$|NZ\$|HK\$|MX\$|NT\$|R\$|S\$|C\$|A\$|JP¥|CN¥|[$€£¥₹₩₺₽₪₱₫฿]|(?:CHF|kr|zł|Kč|Ft|[A-Z]{3})\s?)?\d[\d,.]*(?:\s?\d{3})*(?:\s?(?:€|£|kr|zł|Kč|Ft|CHF|[A-Z]{3}))?`;
const NIGHTLY_RE = new RegExp(`(${MONEY_TOKEN})\\s+nightly(?![a-z])`, "i");
const TOTAL_RE = new RegExp(`(${MONEY_TOKEN})\\s+total(?![a-z])`, "i");
const LOCATION_RE = /\blocation\b|\b\d+(?:\.\d+)?\s?(?:mi|km|miles|kilometers)\b/i;
const MONEY_LINE_RE = /^(?:[^\d\s]{0,4}|[A-Z]{3}|US\$|CA\$|AU\$)\s?\d[\d,.\s]*\d?\s?(?:[^\d\s]{0,4}|[A-Z]{3})?$/;

/** Hash of name plus price text, as PLAN.md 14.1 defines the id. */
export function hotelId(name: string, priceText: string | undefined): string {
  return `google_hotels:${createHash("sha1").update(`${name}|${priceText ?? ""}`).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Deterministic records (what the page probe returns) and their assembly
// ---------------------------------------------------------------------------

/** One result card as the in-page probe reads it. Strings are whitespace-collapsed. */
export interface RawCard {
  kind: "organic" | "sponsored";
  name: string;
  /** aria-label of the "Prices starting from" link, when the card has one. */
  priceLabel: string | null;
  /** The entity link's href (relative or absolute), when the card has one. */
  href: string | null;
  /** First aria-label mentioning "out of 5 stars", when any. */
  ratingLabel: string | null;
  /** The "Amenities for ..." sentence, when the card has one. */
  amenities: string | null;
  /** Visible text, lines joined by " | ". */
  text: string;
  /** All text including hidden tooltips ("$83 nightly $308 total ..."). */
  fullText: string;
}

export interface AssembleContext {
  query: NormalizedHotelsQuery;
}

/** Turn one probed card into a validated `HotelResult`, or say why not. Pure. */
export function assembleCard(raw: RawCard, c: AssembleContext): { hotel: HotelResult } | { drop: string } {
  const name = raw.name.trim();
  if (name === "") return { drop: "no name" };
  // Visible lines, separator bullets trimmed; a line with no letter or digit is decoration.
  const lines = raw.text
    .split(" | ")
    .map((l) => l.replace(/^[\s·•|]+|[\s·•|]+$/g, "").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l));

  let priceText = labelPriceText(raw.priceLabel);
  const nightly = NIGHTLY_RE.exec(raw.fullText)?.[1]?.trim();
  const totalText = TOTAL_RE.exec(raw.fullText)?.[1]?.trim();
  if (priceText === undefined && raw.kind === "sponsored") priceText = lines.find((l) => MONEY_LINE_RE.test(l) && /\d/.test(l));
  const soldOut = /\bsold out\b/i.test(raw.fullText);
  const price = parseMoney(nightly ?? priceText, c.query.currency) ?? parseMoney(priceText, c.query.currency);
  const total = parseMoney(totalText, c.query.currency);
  if (price === undefined && priceText !== undefined && !soldOut) return { drop: `unreadable price "${priceText}"` };

  const guest = parseRatingLabel(raw.ratingLabel) ?? ratingFromText(raw.fullText);
  const parsedAmenities = parseAmenitiesSentence(raw.amenities);
  let amenities = parsedAmenities.amenities;
  let starClass = parsedAmenities.star_class;
  let type = parsedAmenities.type;
  if (starClass === undefined) {
    const m = STAR_TYPE_RE.exec(raw.text) ?? STAR_TYPE_RE.exec(raw.fullText);
    if (m !== null) {
      starClass = Number(m[1]);
      type ??= (m[2] as string).trim().toLowerCase();
    }
  }
  if (raw.kind === "sponsored" && amenities.length === 0) {
    // "Pet-friendly · Fitness center" is the last line of an ad.
    const last = lines.at(-1);
    if (last !== undefined && last.includes("·") && !/\d/.test(last)) amenities = dedupe(last.split("·").map((a) => a.trim()).filter(Boolean));
  }

  const amenitySet = new Set(amenities.map((a) => a.toLowerCase()));
  const tags: string[] = [];
  let locationNote: string | undefined;
  for (const line of lines) {
    if (line === name || line.length > 60) continue;
    if (priceText !== undefined && line.includes(priceText)) continue;
    if (MONEY_LINE_RE.test(line) && /\d/.test(line)) continue;
    if (/^(view prices|photos for|back|next|amenities for)/i.test(line)) continue;
    if (/^[A-Z][a-z]{2} \d{1,2}\s*[–-]/.test(line)) continue; // "Nov 20 – 23"
    if (/^["“”']/.test(line)) continue; // a review quote
    if (/\bout of 5\b|\/5\b/.test(line)) continue;
    if (amenitySet.has(line.toLowerCase()) || STAR_TYPE_RE.test(line) || /^sold out$/i.test(line)) continue;
    if (line.includes("·") && line.split("·").every((p) => amenitySet.has(p.trim().toLowerCase()) || STAR_TYPE_RE.test(p))) continue;
    if (LOCATION_RE.test(line)) {
      locationNote ??= line;
      continue;
    }
    tags.push(line);
  }
  if (raw.kind === "sponsored") tags.unshift("Sponsored");

  const url = entityUrl(raw.href);
  const candidate: HotelResult = {
    id: hotelId(name, priceText),
    source: "google_hotels",
    name,
    ...(price !== undefined && { price_per_night: price }),
    ...(total !== undefined && price !== undefined && total.currency === price.currency && { total_price: total }),
    ...(guest !== undefined && { rating: Math.round(guest.rating * 10) / 10 }),
    ...(guest?.review_count !== undefined && { review_count: guest.review_count }),
    ...(starClass !== undefined && { star_class: starClass }),
    ...(type !== undefined && { type }),
    ...(locationNote !== undefined && { location_note: locationNote }),
    amenities,
    tags: dedupe(tags),
    ...(url !== undefined && { url }),
    availability: soldOut ? "sold_out" : price !== undefined ? "available" : "unknown",
  };
  const checked = HotelResultSchema.safeParse(candidate);
  if (!checked.success) {
    return { drop: `schema: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return { hotel: checked.data };
}

function ratingFromText(text: string): { rating: number; review_count?: number } | undefined {
  const m = /\b([0-5]\.\d)\/5\b\s*(?:\(([\d,.]+\s*[KkMm]?)\))?/.exec(text);
  if (m === null) return undefined;
  const count = m[2] !== undefined ? parseCount(m[2]) : undefined;
  return { rating: Number(m[1]), ...(count !== undefined && { review_count: count }) };
}

/** `https://www.google.com/travel/hotels/entity/<id>` for a card that links to an entity page, else undefined. */
export function entityUrl(href: string | null | undefined): string | undefined {
  if (href === null || href === undefined || href === "") return undefined;
  let path: string;
  try {
    path = new URL(href, GOOGLE_HOTELS_ORIGIN).pathname;
  } catch {
    return undefined;
  }
  const m = /^\/travel\/hotels\/entity\/([A-Za-z0-9_-]+)/.exec(path);
  return m === null ? undefined : `${GOOGLE_HOTELS_ORIGIN}/travel/hotels/entity/${m[1] as string}`;
}

// ---------------------------------------------------------------------------
// LLM fallback: extraction schema and assembly
// ---------------------------------------------------------------------------

export const ExtractedHotelSchema = z.object({
  item: z.number().describe("Index [n] of the card this hotel was read from, or -1 when the text was not split into cards"),
  name: z.string().describe("Hotel name exactly as printed"),
  price_text: z.string().nullable().describe("The nightly price exactly as printed, e.g. '$83' or '€1,319'; null when the card shows no price"),
  total_text: z.string().nullable().describe("The stay total exactly as printed, e.g. '$308', only when the card prints a total; else null"),
  rating: z.number().nullable().describe("Guest rating out of 5 when printed (e.g. '4.4/5' or '4.4 out of 5 stars'); null otherwise. A location score is not a guest rating"),
  review_count: z.number().nullable().describe("Number of reviews when printed ('1,044 reviews', '(1.0K)' is 1000); else null"),
  star_class: z.number().nullable().describe("Hotel class 1-5 when printed ('4-star hotel'); else null"),
  type: z.string().nullable().describe("Property type as printed, lower-case: 'hotel', 'tourist hotel', 'apartment', 'hostel', ...; null when not printed"),
  location_note: z.string().nullable().describe("A location statement as printed ('Excellent location', '0.3 mi from Louvre'); else null"),
  amenities: z.array(z.string()).describe("Amenities as printed, in order"),
  tags: z.array(z.string()).describe("Badges as printed: 'DEAL', '18% less than usual', 'Eco-certified', 'Free cancellation', ..."),
  sold_out: z.boolean().describe("True when the card says the hotel is sold out"),
});
export type ExtractedHotel = z.infer<typeof ExtractedHotelSchema>;

export const ExtractionSchema = z.object({ hotels: z.array(ExtractedHotelSchema) });

export interface AssembleExtractedContext {
  query: NormalizedHotelsQuery;
  /** Card texts the model saw, by index. Empty when the model saw the page text. */
  cards: readonly RawCard[];
  /** The page text the model saw when there were no cards. */
  pageText: string;
}

/** Turn one extracted hotel into a validated `HotelResult`, or say why not. Pure. */
export function assembleExtracted(raw: ExtractedHotel, c: AssembleExtractedContext): { hotel: HotelResult } | { drop: string } {
  const name = raw.name.trim();
  if (name === "") return { drop: "no name" };
  const card = raw.item >= 0 ? c.cards[raw.item] : undefined;
  if (raw.item >= 0 && card === undefined && c.cards.length > 0) return { drop: `item ${raw.item} does not match any card` };
  const haystack = card !== undefined ? `${card.fullText} ${card.text}` : c.pageText;
  if (!haystack.toLowerCase().includes(name.toLowerCase().slice(0, 40))) return { drop: `name "${name}" does not appear in the page text` };

  const priceText = raw.price_text?.trim() || undefined;
  if (priceText !== undefined && !haystack.includes(priceText)) return { drop: `price "${priceText}" does not appear in the card text` };
  const price = parseMoney(priceText, c.query.currency);
  if (priceText !== undefined && price === undefined) return { drop: `unreadable price "${priceText}"` };
  const totalText = raw.total_text?.trim() || undefined;
  const total = totalText !== undefined && haystack.includes(totalText) ? parseMoney(totalText, c.query.currency) : undefined;

  const rating = raw.rating !== null && raw.rating >= 0 && raw.rating <= 5 ? Math.round(raw.rating * 10) / 10 : undefined;
  const reviews = raw.review_count !== null && raw.review_count >= 0 ? Math.round(raw.review_count) : undefined;
  const star = raw.star_class !== null && Number.isInteger(raw.star_class) && raw.star_class >= 1 && raw.star_class <= 5 ? raw.star_class : undefined;
  const type = raw.type?.trim().toLowerCase() || undefined;
  const location = raw.location_note?.trim() || undefined;

  const candidate: HotelResult = {
    id: hotelId(name, priceText),
    source: "google_hotels",
    name,
    ...(price !== undefined && { price_per_night: price }),
    ...(total !== undefined && price !== undefined && total.currency === price.currency && { total_price: total }),
    ...(rating !== undefined && { rating }),
    ...(rating !== undefined && reviews !== undefined && { review_count: reviews }),
    ...(star !== undefined && { star_class: star }),
    ...(type !== undefined && { type }),
    ...(location !== undefined && { location_note: location }),
    amenities: dedupe(raw.amenities.map((a) => a.trim()).filter(Boolean)).slice(0, MAX_AMENITIES),
    tags: dedupe([...(card?.kind === "sponsored" ? ["Sponsored"] : []), ...raw.tags.map((t) => t.trim()).filter(Boolean)]),
    ...(card !== undefined && entityUrl(card.href) !== undefined && { url: entityUrl(card.href) as string }),
    availability: raw.sold_out ? "sold_out" : price !== undefined ? "available" : "unknown",
  };
  const checked = HotelResultSchema.safeParse(candidate);
  if (!checked.success) {
    return { drop: `schema: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return { hotel: checked.data };
}

// ---------------------------------------------------------------------------
// Page probes (strings: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

/**
 * One record per result card, sponsored first (as on the page), organic cards in
 * document order. Organic cards are found from their h2: the highest ancestor
 * that still holds exactly one h2 and a price, "View prices" or amenities node.
 * Sponsored cards are list items linking to an /aclk ad URL.
 */
const COLLECT_CARDS_JS = `(() => {
  const norm = (s) => (s || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
  const lines = (el) => (el.innerText || "").split("\\n").map((l) => norm(l)).filter((l) => l).join(" | ");
  const rendered = (el) => el.getClientRects().length > 0;
  const ratingOf = (el) => {
    for (const n of el.querySelectorAll("[aria-label]")) {
      const l = n.getAttribute("aria-label") || "";
      if (/out of 5 stars?/i.test(l)) return norm(l);
    }
    return null;
  };
  const out = [];
  const seen = new Set();
  for (const li of document.querySelectorAll("li")) {
    const ad = li.querySelector('a[href*="/aclk"]');
    if (!ad || !rendered(li)) continue;
    const text = lines(li);
    const name = text.split(" | ")[0] || "";
    if (!name || seen.has("s:" + text)) continue;
    seen.add("s:" + text);
    out.push({ kind: "sponsored", name, priceLabel: null, href: null, ratingLabel: ratingOf(li), amenities: null, text, fullText: norm(li.textContent) });
  }
  const SEL = '[aria-label^="Prices starting from"], [aria-label^="View prices for"], [role="document"]';
  for (const h2 of document.querySelectorAll("h2")) {
    const name = norm(h2.textContent);
    if (!name) continue;
    let el = h2.parentElement;
    let card = null;
    for (let i = 0; i < 12 && el && el !== document.body; i++) {
      if (el.querySelectorAll("h2").length > 1) break;
      if (el.querySelector(SEL)) card = el;
      el = el.parentElement;
    }
    if (!card || !rendered(card)) continue;
    const priceLink = card.querySelector('[aria-label^="Prices starting from"]');
    const priceLabel = priceLink ? norm(priceLink.getAttribute("aria-label")) : null;
    const key = "o:" + name + "|" + (priceLabel || "");
    if (seen.has(key)) continue;
    seen.add(key);
    const entity = card.querySelector('a[href*="/travel/hotels/entity/"]');
    const doc = card.querySelector('[role="document"]');
    out.push({
      kind: "organic",
      name,
      priceLabel,
      href: entity ? entity.getAttribute("href") : null,
      ratingLabel: ratingOf(card),
      amenities: doc ? norm(doc.textContent) : null,
      text: lines(card),
      fullText: norm(card.textContent),
    });
  }
  return out;
})()`;

const PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const cards = ${COLLECT_CARDS_JS};
  const value = (label) => { const i = document.querySelector('input[aria-label="' + label + '"]'); return i ? (i.value || "") : null; };
  const trav = document.querySelector('[aria-label^="Number of travelers"]');
  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 4000),
    textLength: text.length,
    itemCount: cards.length,
    recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha'),
    hasFilters: !!document.querySelector('[role="form"][aria-label="Filters"], form[aria-label="Filters"]') || (/\\bAll filters\\b/.test(text) && /\\bSort by\\b/.test(text)),
    resultsCount: (text.match(/\\b\\d[\\d,.]*\\s+results\\b/) || [null])[0],
    showing: (text.match(/Showing results \\d[\\d,]* ?[-–] ?\\d[\\d,]* of \\d[\\d,]*/) || [null])[0],
    setDates: /Set your dates to update prices/i.test(text),
    checkin: value("Check-in"),
    checkout: value("Check-out"),
    travelers: trav ? (trav.getAttribute("aria-label") || "") : null,
  };
})()`;

const PAGE_TEXT_JS = `(() => {
  const main = document.querySelector("main") || document.body;
  return (main ? (main.innerText || "") : "").slice(0, ${MAX_PAGE_TEXT});
})()`;

interface Probe {
  url: string;
  title: string;
  text: string;
  textLength: number;
  itemCount: number;
  recaptcha: boolean;
  hasFilters: boolean;
  resultsCount: string | null;
  showing: string | null;
  setDates: boolean;
  checkin: string | null;
  checkout: string | null;
  travelers: string | null;
}

const REJECT_NAMES = [
  "reject all", "alle ablehnen", "tout refuser", "rechazar todo", "rifiuta tutto", "alles afwijzen",
  "odrzuć wszystko", "recusar tudo", "rejeitar tudo", "avvisa alla", "afvis alle", "avslå alle",
  "hylkää kaikki", "απόρριψη όλων", "отклонить все", "tümünü reddet", "odmítnout vše",
  "mindent elutasítok", "respinge tot", "respingeți tot", "refuser tout", "全部拒绝", "すべて拒否", "모두 거부",
];
const ACCEPT_NAMES = [
  "accept all", "alle akzeptieren", "tout accepter", "aceptar todo", "accetta tutto", "alles accepteren",
  "zaakceptuj wszystko", "aceitar tudo", "godkänn alla", "accepter alle", "godta alle", "hyväksy kaikki",
  "αποδοχή όλων", "принять все", "tümünü kabul et", "přijmout vše", "mindent elfogadok", "acceptați tot",
  "全部接受", "すべて同意", "모두 수락", "i agree", "ich stimme zu", "j'accepte",
];

function namesRegex(names: readonly string[]): RegExp {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^\\s*(${escaped.join("|")})\\s*$`, "i");
}
const REJECT_RE = namesRegex(REJECT_NAMES);
const ACCEPT_RE = namesRegex(ACCEPT_NAMES);

const NO_RESULTS_RE = /\b(no (hotels|results|properties|options)( found| available| match)?|couldn.t find any|we couldn.t find|didn.t find any)/i;

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export interface GoogleHotelsRecipeOptions {
  /** Search page. Tests point it at a local fixture server. Default: Google Hotels. */
  baseUrl?: string;
  /** Longest wait for the results list, in ms. Also capped at 60% of the time left. Default 30000. */
  maxResultsWaitMs?: number;
  /** How long a page with no cards must stand before it counts as "no hotels" (or as unstructured results). Default 8000. */
  noResultsGraceMs?: number;
  /** Poll interval while waiting. Default 300. */
  pollMs?: number;
  /** How long to wait for the next page after clicking "Next". Default 5000. */
  nextPageWaitMs?: number;
}

const SYSTEM_PROMPT = [
  "You read Google Hotels search results and return structured hotel records.",
  "The text is the only source of truth. Never use outside knowledge for names, prices, ratings or amenities.",
  "Rules:",
  "- Return one entry per hotel card. When the text is split into numbered cards, set item to the card's [n]; otherwise set item to -1.",
  "- price_text is the nightly price exactly as printed (for example '$83', '€1,319'), copied character for character. A card that prints '$83 nightly' and '$308 total' has price_text '$83' and total_text '$308'. Null when no price is printed (for example 'View prices' only, or sold out).",
  "- rating is the guest rating out of 5 only when printed ('4.4/5', '4.4 out of 5 stars from 1,044 reviews'); review_count is that count as a number ('1.0K' is 1000). A location score such as 'Excellent location 4.7 out of 5' is NOT a guest rating.",
  "- star_class is the digit in '4-star hotel'; type is the property type as printed in lower case ('hotel', 'tourist hotel', 'tourist residence', 'apartment', 'hostel').",
  "- amenities are the items listed for the card, as printed. tags are the badges ('DEAL', 'GREAT DEAL', '18% less than usual', 'Eco-certified', 'Free cancellation'); do not put amenities, prices or the name in tags.",
  "- location_note is a location statement as printed ('Excellent location', '0.3 mi from Louvre'), else null.",
  "- sold_out is true only when the card says so.",
  "- Do not invent anything the text does not state.",
].join("\n");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The LLM client a provider passes when it has none: the recipe then fails
 * with code `config` only if the deterministic path did not produce results.
 */
export function missingLlmClient(): LlmClient {
  return {
    complete: () =>
      Promise.reject(
        new RecipeError(
          "config",
          "Google Hotels could not be read deterministically and no LLM is available for the fallback extraction; set ANTHROPIC_API_KEY",
          { retryable: false },
        ),
      ),
  };
}

export function createGoogleHotelsRecipe(options: GoogleHotelsRecipeOptions = {}): Recipe<NormalizedHotelsQuery, HotelResult[]> {
  const baseUrl = options.baseUrl ?? GOOGLE_HOTELS_BASE_URL;
  const maxResultsWaitMs = options.maxResultsWaitMs ?? 30_000;
  const noResultsGraceMs = options.noResultsGraceMs ?? 8_000;
  const pollMs = options.pollMs ?? 300;
  const nextPageWaitMs = options.nextPageWaitMs ?? 5_000;

  const buildUrl = (params: NormalizedHotelsQuery): string => buildGoogleHotelsUrl(params, baseUrl);

  async function run(page: Page, params: NormalizedHotelsQuery, ctx: RecipeContext): Promise<HotelResult[]> {
    const query = NormalizedHotelsQuerySchema.safeParse(params);
    if (!query.success) {
      throw new RecipeError("invalid_input", `invalid hotel query: ${query.error.issues.map((i) => i.message).join("; ")}`);
    }
    const q = query.data;
    const caveat = (msg: string): void => {
      if (ctx.caveats !== undefined && !ctx.caveats.includes(msg)) ctx.caveats.push(msg);
    };
    const remaining = (): number => ctx.deadline - Date.now();
    const checkTime = (what: string): void => {
      if (ctx.signal?.aborted === true) throw new RecipeError("timeout", `Google Hotels search aborted ${what}`);
      if (remaining() <= 0) throw new RecipeError("timeout", `Google Hotels search ran out of time ${what}`);
    };

    try {
      checkTime("before navigating");
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      await navigate(page, buildUrl(q), ctx, checkTime);
      const wait = await waitForResults(page, ctx, { maxResultsWaitMs, noResultsGraceMs, pollMs, caveat, checkTime });
      if (wait.kind === "empty") {
        caveat(`Google Hotels showed no results for "${q.destination}" on these dates.`);
        return [];
      }
      verifyControls(wait.probe, q, caveat);

      const pages: RawCard[][] = [await page.evaluate<RawCard[]>(COLLECT_CARDS_JS)];
      await expandMore(page, ctx, pages, { pollMs, nextPageWaitMs, caveat, checkTime });
      const cards = mergeCards(pages);

      checkTime("before extraction");
      return await extract(page, q, ctx, cards, caveat);
    } catch (err) {
      throw toRecipeError(err, ctx);
    }
  }

  async function navigate(page: Page, url: string, ctx: RecipeContext, checkTime: (w: string) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      checkTime("while loading the page");
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1000, Math.min(ctx.deadline - Date.now(), 30_000)),
        });
        const status = response?.status();
        if (status === 429 || status === 403) {
          throw new RecipeError("blocked", `Google Hotels answered HTTP ${status}; it is blocking this browser or network`, { retryable: false });
        }
        if (status !== undefined && status >= 500) {
          throw new RecipeError("provider", `Google Hotels answered HTTP ${status}`, { retryable: true });
        }
        return;
      } catch (err) {
        if (err instanceof RecipeError && err.code === "blocked") throw err;
        // One retry, only when there is time for it; a timeout is not retried (it would eat the whole budget).
        const retryable = !(err instanceof playwrightErrors.TimeoutError) && ctx.signal?.aborted !== true;
        if (attempt >= 1 || !retryable || ctx.deadline - Date.now() < 8000) throw err;
        ctx.log.warn("google hotels navigation failed, retrying once", { error: errMsg(err) });
        await sleep(1000);
      }
    }
  }

  async function waitForResults(
    page: Page,
    ctx: RecipeContext,
    o: {
      maxResultsWaitMs: number;
      noResultsGraceMs: number;
      pollMs: number;
      caveat: (m: string) => void;
      checkTime: (w: string) => void;
    },
  ): Promise<{ kind: "results" | "empty"; probe: Probe }> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(o.maxResultsWaitMs, (ctx.deadline - start) * 0.6));
    const until = start + budget;
    let consentHandled = false;
    for (;;) {
      o.checkTime("while waiting for results");
      let probe: Probe | undefined;
      try {
        probe = await page.evaluate<Probe>(PROBE_JS);
      } catch {
        // Navigation (consent redirect, challenge) destroyed the execution context; probe again.
      }
      if (probe !== undefined) {
        if (probe.itemCount > 0) return { kind: "results", probe };
        const wall = blockedReason(probe);
        if (wall !== undefined) {
          throw new RecipeError("blocked", `Google Hotels served a bot check (${wall}) at ${probe.url}; no results were returned`, {
            retryable: false,
          });
        }
        if (NO_RESULTS_RE.test(probe.text) && probe.resultsCount === null) return { kind: "empty", probe };
      }
      if (!consentHandled && (await dismissConsent(page))) {
        consentHandled = true;
        o.caveat("A cookie consent dialog was shown and dismissed (reject preferred) before reading results.");
        continue;
      }
      const elapsed = Date.now() - start;
      if (probe !== undefined && elapsed >= Math.min(o.noResultsGraceMs, Math.max(0, budget - 1000))) {
        // Results exist but not in the structure the probe knows: the LLM reads the page text.
        if (probe.resultsCount !== null || probe.showing !== null) return { kind: "results", probe };
        if (probe.hasFilters) return { kind: "empty", probe };
      }
      if (Date.now() >= until) {
        throw new RecipeError(
          "timeout",
          `no Google Hotels results appeared within ${Math.round(budget / 1000)}s (page: ${probe?.title ?? "unknown"})`,
        );
      }
      await sleep(o.pollMs);
    }
  }

  /**
   * Click the pagination "Next" button at most twice, collecting each new page.
   * Live (2026-10-18) the button was visible and enabled but the list did not
   * change after a click; the caveat says what happened either way.
   */
  async function expandMore(
    page: Page,
    ctx: RecipeContext,
    pages: RawCard[][],
    o: { pollMs: number; nextPageWaitMs: number; caveat: (m: string) => void; checkTime: (w: string) => void },
  ): Promise<void> {
    const next = page.getByRole("button", { name: /^\s*Next\s*$/i }).filter({ hasText: /Next/ }).last();
    const signature = (cards: RawCard[]): string => cards.map((c) => c.name).join("\n");
    let clicks = 0;
    let moved = 0;
    for (; clicks < 2; clicks++) {
      o.checkTime("while loading more results");
      try {
        if ((await next.count()) === 0) break;
        const before = signature(pages[pages.length - 1] as RawCard[]);
        await next.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
        await next.click({ timeout: 3000 });
        const until = Math.min(Date.now() + o.nextPageWaitMs, ctx.deadline - 1000);
        let changed = false;
        for (;;) {
          await sleep(o.pollMs);
          const now = await page.evaluate<RawCard[]>(COLLECT_CARDS_JS);
          if (now.length > 0 && signature(now) !== before) {
            pages.push(now);
            changed = true;
            break;
          }
          if (Date.now() >= until) break;
        }
        if (!changed) {
          clicks++;
          break;
        }
        moved++;
      } catch (err) {
        ctx.log.debug("could not load the next page of hotels", { error: errMsg(err) });
        break;
      }
    }
    let showing: string | null = null;
    let nextPresent = false;
    try {
      showing = await page.evaluate<string | null>(
        `((document.body ? document.body.innerText : "").match(/Showing results \\d[\\d,]* ?[-–] ?\\d[\\d,]* of \\d[\\d,]*/) || [null])[0]`,
      );
      nextPresent = (await next.count()) > 0;
    } catch {
      // ignore
    }
    const seen = showing !== null ? ` (page says "${showing}")` : "";
    if (clicks > 0 && moved === 0) {
      o.caveat(`Google Hotels' "Next" page button did not load more results when clicked, so only the first page of results was read${seen}.`);
    } else if (nextPresent) {
      o.caveat(`Google Hotels still offers a "Next" page after ${moved + 1} page(s) were read, so the list is incomplete and further hotels exist${seen}.`);
    }
  }

  return {
    site: GOOGLE_HOTELS_SITE,
    paramsSchema: NormalizedHotelsQuerySchema,
    resultSchema: z.array(HotelResultSchema),
    buildUrl,
    run,
  };
}

function blockedReason(probe: Probe): string | undefined {
  if (/\/sorry\//.test(probe.url)) return "sorry/index";
  if (probe.recaptcha) return "recaptcha";
  if (/unusual traffic/i.test(probe.text)) return "unusual traffic";
  return detectBotWall({ title: probe.title, text: probe.text, textLength: probe.textLength });
}

/** Click the first matching consent button in any frame: reject preferred, then accept. True when one was clicked. */
async function dismissConsent(page: Page): Promise<boolean> {
  for (const re of [REJECT_RE, ACCEPT_RE]) {
    for (const frame of page.frames()) {
      try {
        const button = frame.getByRole("button", { name: re }).first();
        if ((await button.count()) === 0) continue;
        await button.click({ timeout: 3000 });
        return true;
      } catch {
        // Not clickable (detached, covered): try the next candidate.
      }
    }
  }
  return false;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-20" to "Nov 20", the way the Check-in textbox prints it ("Fri, Nov 20"). */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1] as string} ${Number(d)}`;
}

/** Compare the page's date and traveler controls with the query and caveat anything that did not take. */
export function verifyControls(probe: Pick<Probe, "checkin" | "checkout" | "travelers" | "setDates">, q: NormalizedHotelsQuery, caveat: (m: string) => void): void {
  const wantIn = shortDate(q.check_in);
  const wantOut = shortDate(q.check_out);
  const datesOk =
    probe.checkin !== null && probe.checkout !== null && probe.checkin.includes(wantIn) && probe.checkout.includes(wantOut) && !probe.setDates;
  if (!datesOk) {
    const shown = probe.checkin !== null && probe.checkout !== null ? `${probe.checkin} to ${probe.checkout}` : "unknown dates";
    caveat(
      `Dates were not applied on Google Hotels (wanted ${wantIn} to ${wantOut}, page shows ${shown}); prices are for the page's dates, not the requested stay.`,
    );
  }
  const want = q.guests.adults + q.guests.children;
  const m = probe.travelers !== null ? /(\d+)\s*\.?\s*$/.exec(probe.travelers) : null;
  const shown = m !== null ? Number(m[1]) : undefined;
  if (shown !== want) {
    caveat(
      `Guest count was not applied on Google Hotels (wanted ${want}, page shows ${shown ?? "unknown"}); prices may be for a different party size.`,
    );
  }
}

/** Cards of every page read, in page order, deduplicated by name and price label. */
export function mergeCards(pages: readonly RawCard[][]): RawCard[] {
  const seen = new Set<string>();
  const out: RawCard[] = [];
  for (const page of pages) {
    for (const c of page) {
      const key = `${c.kind}:${c.name}|${c.priceLabel ?? ""}|${c.kind === "sponsored" ? c.text : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

async function extract(
  page: Page,
  q: NormalizedHotelsQuery,
  ctx: RecipeContext,
  cards: RawCard[],
  caveat: (m: string) => void,
): Promise<HotelResult[]> {
  const deterministic: HotelResult[] = [];
  const drops: string[] = [];
  for (const raw of cards) {
    const r = assembleCard(raw, { query: q });
    if ("hotel" in r) deterministic.push(r.hotel);
    else drops.push(`${raw.name}: ${r.drop}`);
  }
  if (drops.length > 0) ctx.log.debug("google hotels: cards the probe could not read", { count: drops.length, first: drops.slice(0, 3) });

  let hotels: HotelResult[];
  if (deterministic.length >= MIN_PROBE_RECORDS) {
    ctx.log.info("google hotels: read deterministically", { cards: cards.length, hotels: deterministic.length });
    hotels = deterministic;
  } else {
    ctx.log.info("google hotels: deterministic probe insufficient, using the extractor", { cards: cards.length, valid: deterministic.length });
    hotels = await extractWithLlm(page, q, ctx, cards);
    caveat("Google Hotels' result layout was not recognised, so the hotels were read by the extraction model from the page text; fields may be incomplete.");
  }
  if (cards.some((c) => c.kind === "sponsored") && hotels.some((h) => h.tags.includes("Sponsored"))) {
    caveat('Rows tagged "Sponsored" are ads shown above the results; their prices may be in the advertiser\'s currency.');
  }
  if (hotels.length === 0) {
    throw new RecipeError("provider", `Google Hotels showed ${cards.length} results but none could be turned into a valid hotel`, {
      retryable: true,
    });
  }

  // The contract's filters, in code, keeping the page's order. The tool applies them again (idempotent) and sorts.
  const filtered = filterAndSortHotels(hotels, { ...q, sort: "relevance", max_results: MAX_HOTELS_LIMIT });
  const hidden = filtered.hiddenByPrice + filtered.hiddenByCurrency + filtered.hiddenByRating + filtered.hiddenByStars;
  if (hidden > 0) {
    const parts: string[] = [];
    if (filtered.hiddenByPrice > 0) parts.push(`${filtered.hiddenByPrice} over max_price_per_night or without a price`);
    if (filtered.hiddenByCurrency > 0) parts.push(`${filtered.hiddenByCurrency} priced in another currency than ${q.currency}`);
    if (filtered.hiddenByRating > 0) parts.push(`${filtered.hiddenByRating} below min_rating or without a guest rating`);
    if (filtered.hiddenByStars > 0) parts.push(`${filtered.hiddenByStars} outside star_classes or without a printed class`);
    caveat(`${hidden} of ${hotels.length} hotels on Google Hotels did not match the filters (${parts.join("; ")}).`);
  }
  if (q.min_rating !== undefined && hotels.every((h) => h.rating === undefined)) {
    caveat("Google Hotels showed no guest ratings on this results page, so min_rating removed every hotel.");
  } else if (hotels.some((h) => h.rating === undefined)) {
    caveat(`Google Hotels showed no guest rating for ${hotels.filter((h) => h.rating === undefined).length} of ${hotels.length} hotels; rating and review_count are absent for those.`);
  }
  return filtered.hotels;
}

async function extractWithLlm(page: Page, q: NormalizedHotelsQuery, ctx: RecipeContext, cards: RawCard[]): Promise<HotelResult[]> {
  const shown = cards.slice(0, MAX_LLM_CARDS);
  let pageText = "";
  if (shown.length === 0) {
    try {
      pageText = await page.evaluate<string>(PAGE_TEXT_JS);
    } catch (err) {
      throw new RecipeError("provider", `could not read the Google Hotels page text: ${errMsg(err)}`, { cause: err, retryable: true });
    }
  }
  const content = [
    `Search: hotels in ${q.destination}, ${q.check_in} to ${q.check_out} (${q.nights} night(s)); ${q.guests.adults} adult(s), ${q.guests.children} child(ren); display currency ${q.currency}.`,
    `Page: ${page.url()}`,
    "",
    ...(shown.length > 0
      ? ["Result cards (visible text, then the full text with hidden tooltips):", ...shown.map((c, i) => `[${i}] ${c.text}\n    full: ${c.fullText.slice(0, 800)}`)]
      : ["Page text (not split into cards; use item -1):", pageText]),
  ].join("\n");

  const remainingMs = Math.max(1000, ctx.deadline - Date.now());
  const timeoutSignal = AbortSignal.timeout(remainingMs);
  const signal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
  const response = await ctx.llm.complete({
    role: "extractor",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    schema: ExtractionSchema,
    effort: "medium",
    maxTokens: 16_000,
    ...(ctx.meter !== undefined && { meter: ctx.meter }),
    signal,
  });
  const parsed = ExtractionSchema.safeParse(response.parsed);
  if (!parsed.success) {
    throw new RecipeError("provider", "the extractor did not return the expected structure", { retryable: true });
  }
  const seen = new Set<string>();
  const hotels: HotelResult[] = [];
  for (const raw of parsed.data.hotels) {
    const r = assembleExtracted(raw, { query: q, cards: shown, pageText });
    if ("drop" in r) {
      ctx.log.warn("google hotels: dropped an extracted hotel", { item: raw.item, name: raw.name, reason: r.drop });
      continue;
    }
    if (seen.has(r.hotel.id)) continue;
    seen.add(r.hotel.id);
    hotels.push(r.hotel);
  }
  return hotels;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

function toRecipeError(err: unknown, ctx: RecipeContext): unknown {
  if (err instanceof RecipeError) return err;
  // LlmError carries its own code (config, budget_exceeded, ...): the caller maps it.
  if (err instanceof LlmError) return err;
  const aborted = ctx.signal?.aborted === true;
  if (err instanceof playwrightErrors.TimeoutError || aborted) {
    return new RecipeError("timeout", `Google Hotels search timed out: ${errMsg(err)}`, { cause: err });
  }
  if (ctx.deadline - Date.now() <= 0 && /closed|Target/.test(errMsg(err))) {
    return new RecipeError("timeout", "Google Hotels search ran out of time", { cause: err });
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(errMsg(err))?.[1];
  if (net !== undefined) {
    return new RecipeError("provider", `navigation to Google Hotels failed: ${net}`, { cause: err, retryable: true });
  }
  return new RecipeError("provider", `Google Hotels recipe failed: ${errMsg(err)}`, { cause: err, retryable: false });
}

/** The recipe against live Google Hotels. */
export const googleHotelsRecipe: Recipe<NormalizedHotelsQuery, HotelResult[]> = createGoogleHotelsRecipe();
