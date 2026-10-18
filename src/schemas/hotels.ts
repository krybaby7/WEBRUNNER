import { z } from "zod";
import { CurrencyCodeSchema, DateStringSchema, isRealCalendarDate } from "./flights.js";

/**
 * Shared schemas for `search_hotels`, PLAN.md section 14.1.
 *
 * Owned by WP15 (contract) and consumed by WP17 (Google Hotels recipe,
 * provider and tool). Every hotel provider returns `HotelResult[]` validated by
 * `HotelResultSchema`.
 */

export const HOTEL_SOURCES = ["google_hotels"] as const;
export const HotelSourceSchema = z.enum(HOTEL_SOURCES);
export type HotelSource = z.infer<typeof HotelSourceSchema>;

export const HOTEL_SORTS = ["relevance", "price", "rating"] as const;
export const HotelSortSchema = z.enum(HOTEL_SORTS);
export type HotelSort = z.infer<typeof HotelSortSchema>;

export const HOTEL_AVAILABILITY = ["available", "sold_out", "unknown"] as const;

export const DEFAULT_MAX_HOTELS = 20;
export const MAX_HOTELS_LIMIT = 40;
export const MAX_NIGHTS = 30;
export const MAX_AMENITIES = 12;

const STAR_CLASS = z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

export const HotelGuestsSchema = z.object({
  adults: z.number().int().min(1).max(8).default(2),
  children: z.number().int().min(0).max(6).default(0),
});
export type HotelGuests = z.output<typeof HotelGuestsSchema>;

/** Whole nights between two YYYY-MM-DD dates (positive when `checkOut` is later). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  if (!isRealCalendarDate(checkIn) || !isRealCalendarDate(checkOut)) return Number.NaN;
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

export const SearchHotelsInputSchema = z
  .object({
    destination: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("City, area, landmark or hotel name, for example 'Paris', 'Shibuya, Tokyo' or 'Hotel Lutetia'."),
    check_in: DateStringSchema.describe("YYYY-MM-DD"),
    check_out: DateStringSchema.describe(`YYYY-MM-DD, after check_in, at most ${MAX_NIGHTS} nights later`),
    guests: HotelGuestsSchema.default({ adults: 2, children: 0 }).describe("Defaults to 2 adults"),
    max_price_per_night: z.number().positive().optional().describe("Upper bound on the nightly rate, in `currency`."),
    min_rating: z.number().min(0).max(5).optional().describe("Lowest acceptable guest rating, 0 to 5."),
    star_classes: z.array(STAR_CLASS).min(1).optional().describe("Only these hotel classes (2 to 5 stars)."),
    sort: HotelSortSchema.default("relevance").describe(
      "relevance keeps the page's own order; price sorts by nightly rate ascending; rating by guest rating descending.",
    ),
    sources: z.array(HotelSourceSchema).min(1).optional().describe("Defaults to every configured source"),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter ISO 4217 code, for example USD" })
      .optional()
      .describe("ISO 4217; defaults to WEBRUNNER_CURRENCY (USD)"),
    max_results: z.number().int().min(1).max(MAX_HOTELS_LIMIT).default(DEFAULT_MAX_HOTELS),
  })
  .refine((i) => nightsBetween(i.check_in, i.check_out) >= 1, {
    error: "check_out must be after check_in",
    path: ["check_out"],
  })
  .refine((i) => nightsBetween(i.check_in, i.check_out) <= MAX_NIGHTS, {
    error: `a stay can be at most ${MAX_NIGHTS} nights`,
    path: ["check_out"],
  });
export type SearchHotelsInput = z.input<typeof SearchHotelsInputSchema>;

/** The query as every provider receives it: defaults applied, nights computed, sources resolved. */
export const NormalizedHotelsQuerySchema = z.object({
  destination: z.string().min(1),
  check_in: DateStringSchema,
  check_out: DateStringSchema,
  nights: z.number().int().min(1).max(MAX_NIGHTS),
  guests: z.object({ adults: z.number().int().min(1).max(8), children: z.number().int().min(0).max(6) }),
  max_price_per_night: z.number().positive().optional(),
  min_rating: z.number().min(0).max(5).optional(),
  star_classes: z.array(STAR_CLASS).optional(),
  sort: HotelSortSchema,
  sources: z.array(HotelSourceSchema).min(1),
  currency: CurrencyCodeSchema,
  max_results: z.number().int().min(1).max(MAX_HOTELS_LIMIT),
});
export type NormalizedHotelsQuery = z.infer<typeof NormalizedHotelsQuerySchema>;

export const MoneySchema = z.object({ amount: z.number().nonnegative(), currency: CurrencyCodeSchema });

export const HotelResultSchema = z.object({
  id: z.string().min(1),
  source: HotelSourceSchema,
  name: z.string().min(1),
  price_per_night: MoneySchema.optional(),
  total_price: MoneySchema.optional(),
  rating: z.number().min(0).max(5).optional(),
  review_count: z.number().int().nonnegative().optional(),
  star_class: z.number().int().min(1).max(5).optional(),
  type: z.string().min(1).optional(),
  location_note: z.string().min(1).optional(),
  amenities: z.array(z.string().min(1)).max(MAX_AMENITIES),
  tags: z.array(z.string().min(1)),
  url: z.string().url().optional(),
  availability: z.enum(HOTEL_AVAILABILITY),
});
export type HotelResult = z.infer<typeof HotelResultSchema>;

export const SearchHotelsOutputSchema = z.object({
  query: NormalizedHotelsQuerySchema,
  hotels: z.array(HotelResultSchema).max(MAX_HOTELS_LIMIT),
  sources_used: z.array(HotelSourceSchema),
  sources_failed: z.array(z.object({ source: HotelSourceSchema, error: z.string() })),
  fetched_at: z.string(),
  caveats: z.array(z.string()),
});
export type SearchHotelsOutput = z.infer<typeof SearchHotelsOutputSchema>;
