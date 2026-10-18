import { z } from "zod";

/**
 * Shared schemas for `search_flights`, PLAN.md section 3.5.
 *
 * Owned by WP12 (first flights package to land) and consumed by WP11 (Google
 * Flights recipe and the `search_flights` tool). Both flight providers return
 * `FlightOffer[]` validated by `FlightOfferSchema`.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const FLIGHT_SOURCES = ["google_flights", "duffel"] as const;
export const FlightSourceSchema = z.enum(FLIGHT_SOURCES);
export type FlightSource = z.infer<typeof FlightSourceSchema>;

export const CABIN_CLASSES = ["economy", "premium_economy", "business", "first"] as const;
export const CabinSchema = z.enum(CABIN_CLASSES);
export type Cabin = z.infer<typeof CabinSchema>;

/** Maximum offers `search_flights` returns, PLAN.md section 3.5. */
export const MAX_OFFERS = 30;

/** Maximum travellers in one search (Duffel's limit; Google Flights is similar). */
export const MAX_PASSENGERS = 9;

/** 3 uppercase letters. Airport or IATA metropolitan area code. */
export const IataCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter uppercase IATA code, for example LHR" });

/** ISO 4217 currency code, 3 uppercase letters. */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter uppercase ISO 4217 code, for example USD" });

/** True when `value` is YYYY-MM-DD and names a day that exists (rejects 2026-02-30). */
export function isRealCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps years 0..99 to 1900..1999, so reject the whole range rather than misjudge it.
  if (year < 1000) return false;
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** `YYYY-MM-DD`, validated by regex and by the real calendar. */
export const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "must be a date in YYYY-MM-DD format" })
  .refine(isRealCalendarDate, { error: "must be a real calendar date" });

/**
 * Local date-time, ISO 8601, with a UTC offset when known. Airports report
 * local time, so the offset is optional: `2026-12-01T09:30:00` and
 * `2026-12-01T09:30:00+01:00` are both valid.
 */
export const LocalDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, {
    error: "must be an ISO 8601 date-time such as 2026-12-01T09:30:00 or 2026-12-01T09:30:00+01:00",
  });

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const PassengerCount = (min: number, max: number, fallback: number) =>
  z.number().int().min(min).max(max).default(fallback);

export const PassengersSchema = z
  .object({
    adults: PassengerCount(1, MAX_PASSENGERS, 1),
    children: PassengerCount(0, MAX_PASSENGERS - 1, 0),
    infants: PassengerCount(0, MAX_PASSENGERS - 1, 0),
  })
  .refine((p) => p.adults + p.children + p.infants <= MAX_PASSENGERS, {
    error: `at most ${MAX_PASSENGERS} passengers in total`,
  })
  .refine((p) => p.infants <= p.adults, {
    error: "each infant must travel with an adult, so infants cannot exceed adults",
    path: ["infants"],
  });
export type Passengers = z.output<typeof PassengersSchema>;

const PLACE_DESCRIPTION = "IATA code (for example LHR) or city name (for example London)";

export const SearchFlightsInputSchema = z
  .object({
    origin: z.string().trim().min(1).max(100).describe(PLACE_DESCRIPTION),
    destination: z.string().trim().min(1).max(100).describe(PLACE_DESCRIPTION),
    depart_date: DateStringSchema.describe("YYYY-MM-DD"),
    return_date: DateStringSchema.optional().describe("YYYY-MM-DD; omit for one-way"),
    passengers: PassengersSchema.default({ adults: 1, children: 0, infants: 0 }).describe(
      "Defaults to one adult",
    ),
    cabin: CabinSchema.default("economy"),
    max_stops: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    sources: z
      .array(FlightSourceSchema)
      .min(1)
      .optional()
      .describe("Defaults to every configured source"),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter ISO 4217 code, for example USD" })
      .optional()
      .describe("ISO 4217; defaults to WEBRUNNER_CURRENCY (USD)"),
  })
  .refine((i) => i.return_date === undefined || i.return_date >= i.depart_date, {
    error: "return_date must not be before depart_date",
    path: ["return_date"],
  });

/** What a caller may send (defaults not yet applied). */
export type SearchFlightsInput = z.input<typeof SearchFlightsInputSchema>;
/** After `SearchFlightsInputSchema.parse` (cabin and passengers defaulted). */
export type ParsedSearchFlightsInput = z.output<typeof SearchFlightsInputSchema>;

// ---------------------------------------------------------------------------
// Normalized query (what providers receive, and what the output echoes)
// ---------------------------------------------------------------------------

export const NormalizedFlightsQuerySchema = z.object({
  origin: IataCodeSchema,
  destination: IataCodeSchema,
  depart_date: DateStringSchema,
  return_date: DateStringSchema.optional(),
  passengers: z.object({
    adults: z.number().int().min(1),
    children: z.number().int().min(0),
    infants: z.number().int().min(0),
  }),
  cabin: CabinSchema,
  max_stops: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  sources: z.array(FlightSourceSchema).min(1),
  currency: CurrencyCodeSchema,
});
export type NormalizedFlightsQuery = z.infer<typeof NormalizedFlightsQuerySchema>;

/** Thrown by `normalizeFlightsInput` for input that cannot be turned into a query. Maps to error code `invalid_input`. */
export class FlightsInputError extends Error {
  readonly code = "invalid_input" as const;
  constructor(message: string) {
    super(message);
    this.name = "FlightsInputError";
  }
}

export interface NormalizeFlightsOptions {
  /**
   * Maps a free-text place ("London", "LHR") to an IATA code, or undefined when
   * it cannot. The default accepts only 3-letter codes (any case). `search_flights`
   * passes a resolver backed by `resolveIata` plus its LLM fallback.
   */
  resolve?: (place: string) => string | undefined;
  /** Sources to use when the input names none: the configured ones. */
  defaultSources?: readonly FlightSource[];
}

function defaultResolve(place: string): string | undefined {
  const p = place.trim();
  return /^[A-Za-z]{3}$/.test(p) ? p.toUpperCase() : undefined;
}

/**
 * Apply defaults (passengers, cabin, sources, currency from config) and
 * resolve places to IATA codes. Throws `FlightsInputError` when a place does
 * not resolve. Accepts raw or already-parsed input.
 */
export function normalizeFlightsInput(
  input: SearchFlightsInput,
  config: { currency: string },
  options: NormalizeFlightsOptions = {},
): NormalizedFlightsQuery {
  const resolve = options.resolve ?? defaultResolve;
  const origin = resolve(input.origin);
  if (origin === undefined) {
    throw new FlightsInputError(`Could not resolve origin "${input.origin}" to an IATA airport or city code`);
  }
  const destination = resolve(input.destination);
  if (destination === undefined) {
    throw new FlightsInputError(
      `Could not resolve destination "${input.destination}" to an IATA airport or city code`,
    );
  }
  const requested = input.sources ?? options.defaultSources ?? FLIGHT_SOURCES;
  const sources = [...new Set(requested)];

  const query: NormalizedFlightsQuery = {
    origin: origin.toUpperCase(),
    destination: destination.toUpperCase(),
    depart_date: input.depart_date,
    ...(input.return_date !== undefined && { return_date: input.return_date }),
    passengers: {
      adults: input.passengers?.adults ?? 1,
      children: input.passengers?.children ?? 0,
      infants: input.passengers?.infants ?? 0,
    },
    cabin: input.cabin ?? "economy",
    ...(input.max_stops !== undefined && { max_stops: input.max_stops }),
    sources,
    currency: (input.currency ?? config.currency).trim().toUpperCase(),
  };
  const checked = NormalizedFlightsQuerySchema.safeParse(query);
  if (!checked.success) {
    const detail = checked.error.issues.map((i) => `${i.path.join(".") || "(query)"}: ${i.message}`).join("; ");
    throw new FlightsInputError(`Invalid flight query: ${detail}`);
  }
  return checked.data;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const FlightSegmentSchema = z.object({
  /** IATA carrier code, for example "BA". */
  airline: z.string().regex(/^[A-Z0-9]{2}$/, { error: "must be a 2-character IATA carrier code" }),
  airline_name: z.string().min(1),
  /**
   * Carrier code plus number without a space, for example "BA117". Omitted
   * when the source does not show it (Google Flights result lists do not).
   */
  flight_number: z.string().min(1).optional(),
  depart_airport: IataCodeSchema,
  depart_at: LocalDateTimeSchema,
  arrive_airport: IataCodeSchema,
  arrive_at: LocalDateTimeSchema,
  duration_min: z.number().int().min(0),
  aircraft: z.string().min(1).optional(),
});
export type FlightSegment = z.infer<typeof FlightSegmentSchema>;

export const FlightLayoverSchema = z.object({
  airport: IataCodeSchema,
  duration_min: z.number().int().min(0),
});
export type FlightLayover = z.infer<typeof FlightLayoverSchema>;

export const FlightSliceSchema = z
  .object({
    segments: z.array(FlightSegmentSchema).min(1),
    layovers: z.array(FlightLayoverSchema),
  })
  .refine((s) => s.layovers.length === s.segments.length - 1, {
    error: "a slice has exactly one layover between each pair of consecutive segments",
    path: ["layovers"],
  });
export type FlightSlice = z.infer<typeof FlightSliceSchema>;

export const FlightOfferSchema = z.object({
  id: z.string().min(1),
  source: FlightSourceSchema,
  price: z.object({
    amount: z.number().finite().min(0),
    currency: CurrencyCodeSchema,
  }),
  /** Sum over all slices, layovers included. */
  total_duration_min: z.number().int().min(0),
  /** Maximum stops over the slices. */
  stops: z.number().int().min(0),
  /**
   * One slice for one-way, two for round trip. A round-trip offer from a
   * source that lists only the outbound leg (Google Flights) carries one slice
   * and `itinerary: "outbound_only"`; its price is still the round-trip total.
   */
  slices: z.array(FlightSliceSchema).min(1).max(2),
  /** Absent means the slices describe the whole priced itinerary. */
  itinerary: z.enum(["complete", "outbound_only"]).optional(),
  booking_url: z.url().optional(),
  fare_notes: z.array(z.string()).optional(),
});
export type FlightOffer = z.infer<typeof FlightOfferSchema>;

export const SearchFlightsOutputSchema = z.object({
  query: NormalizedFlightsQuerySchema,
  offers: z.array(FlightOfferSchema).max(MAX_OFFERS),
  sources_used: z.array(FlightSourceSchema),
  sources_failed: z.array(z.object({ source: FlightSourceSchema, error: z.string() })),
  fetched_at: z.iso.datetime(),
  caveats: z.array(z.string()),
});
export type SearchFlightsOutput = z.infer<typeof SearchFlightsOutputSchema>;
