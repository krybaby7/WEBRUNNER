import {
  HOTEL_SOURCES,
  MAX_HOTELS_LIMIT,
  NormalizedHotelsQuerySchema,
  nightsBetween,
  SearchHotelsInputSchema,
  type HotelResult,
  type HotelSource,
  type NormalizedHotelsQuery,
} from "../../schemas/hotels.js";

/**
 * Input normalisation and the code-side filters and sort of `search_hotels`,
 * PLAN.md 14.1. Pure functions: no page, no model.
 */

/** Thrown by `normalizeHotelsInput` for input that cannot be turned into a query. Maps to error code `invalid_input`. */
export class HotelsInputError extends Error {
  readonly code = "invalid_input" as const;
  constructor(message: string) {
    super(message);
    this.name = "HotelsInputError";
  }
}

export interface NormalizeHotelsOptions {
  /** Sources to use when the input names none: the configured ones. */
  defaultSources?: readonly HotelSource[];
}

/** The parsed tool input (defaults applied by the schema) or the raw shape a caller may hand in. */
export type HotelsInputLike = Parameters<typeof SearchHotelsInputSchema.safeParse>[0];

/**
 * Apply defaults (guests, sort, max_results, sources, currency from config),
 * compute the nights and validate the result. Accepts raw or already-parsed input.
 */
export function normalizeHotelsInput(
  input: HotelsInputLike,
  config: { currency: string },
  options: NormalizeHotelsOptions = {},
): NormalizedHotelsQuery {
  const parsed = SearchHotelsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new HotelsInputError(parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; "));
  }
  const i = parsed.data;
  const requested = i.sources ?? options.defaultSources ?? HOTEL_SOURCES;
  const query: NormalizedHotelsQuery = {
    destination: i.destination,
    check_in: i.check_in,
    check_out: i.check_out,
    nights: nightsBetween(i.check_in, i.check_out),
    guests: { adults: i.guests.adults, children: i.guests.children },
    ...(i.max_price_per_night !== undefined && { max_price_per_night: i.max_price_per_night }),
    ...(i.min_rating !== undefined && { min_rating: i.min_rating }),
    ...(i.star_classes !== undefined && { star_classes: [...new Set(i.star_classes)].sort((a, b) => a - b) }),
    sort: i.sort,
    sources: [...new Set(requested)],
    currency: (i.currency ?? config.currency).trim().toUpperCase(),
    max_results: i.max_results,
  };
  const checked = NormalizedHotelsQuerySchema.safeParse(query);
  if (!checked.success) {
    const detail = checked.error.issues.map((x) => `${x.path.join(".") || "(query)"}: ${x.message}`).join("; ");
    throw new HotelsInputError(`Invalid hotel query: ${detail}`);
  }
  return checked.data;
}

export interface FilterOutcome {
  hotels: HotelResult[];
  /** Hotels removed by `max_price_per_night`. */
  hiddenByPrice: number;
  /** Hotels removed by `max_price_per_night` because their price is in another currency than the query's. */
  hiddenByCurrency: number;
  /** Hotels removed by `min_rating` (an unrated hotel cannot prove it meets the floor, so it is removed too). */
  hiddenByRating: number;
  /** Hotels removed by `star_classes` (a hotel without a printed class is removed too). */
  hiddenByStars: number;
  /** Hotels left out to stay within `max_results`. */
  omitted: number;
}

/**
 * The code-side filters and sort of PLAN.md 14.1, then the `max_results` cap.
 *
 * Filters are strict: a hotel that does not show the field a filter needs is
 * removed, because the contract guarantees that what remains satisfies the
 * filter. `price` sorts by nightly rate ascending with unpriced rows last;
 * `rating` sorts by guest rating descending with unrated rows last; `relevance`
 * keeps the page's order. Ties keep the page's order (the sort is stable).
 */
export function filterAndSortHotels(hotels: readonly HotelResult[], q: NormalizedHotelsQuery): FilterOutcome {
  let hiddenByPrice = 0;
  let hiddenByCurrency = 0;
  let hiddenByRating = 0;
  let hiddenByStars = 0;
  const kept: HotelResult[] = [];
  for (const h of hotels) {
    if (q.max_price_per_night !== undefined) {
      if (h.price_per_night === undefined) {
        hiddenByPrice++;
        continue;
      }
      if (h.price_per_night.currency !== q.currency) {
        hiddenByCurrency++;
        continue;
      }
      if (h.price_per_night.amount > q.max_price_per_night) {
        hiddenByPrice++;
        continue;
      }
    }
    if (q.min_rating !== undefined && (h.rating === undefined || h.rating < q.min_rating)) {
      hiddenByRating++;
      continue;
    }
    if (q.star_classes !== undefined && (h.star_class === undefined || !(q.star_classes as number[]).includes(h.star_class))) {
      hiddenByStars++;
      continue;
    }
    kept.push(h);
  }

  if (q.sort === "price") {
    kept.sort((a, b) => (a.price_per_night?.amount ?? Number.POSITIVE_INFINITY) - (b.price_per_night?.amount ?? Number.POSITIVE_INFINITY));
  } else if (q.sort === "rating") {
    kept.sort((a, b) => (b.rating ?? Number.NEGATIVE_INFINITY) - (a.rating ?? Number.NEGATIVE_INFINITY));
  }

  const cap = Math.min(q.max_results, MAX_HOTELS_LIMIT);
  return {
    hotels: kept.slice(0, cap),
    hiddenByPrice,
    hiddenByCurrency,
    hiddenByRating,
    hiddenByStars,
    omitted: Math.max(0, kept.length - cap),
  };
}
