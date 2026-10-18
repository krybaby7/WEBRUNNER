import { z } from "zod";
import { log } from "../../../log.js";
import {
  FlightOfferSchema,
  MAX_OFFERS,
  type FlightLayover,
  type FlightOffer,
  type FlightSegment,
  type FlightSlice,
  type NormalizedFlightsQuery,
} from "../../../schemas/flights.js";
import { FlightProviderError, type FlightProvider } from "../types.js";

/**
 * Duffel flight offers over the REST API.
 *
 * API facts used here, from https://duffel.com/docs/api (checked 2026-10-18):
 *   - POST {base}/air/offer_requests?return_offers=true&supplier_timeout=<ms>
 *     (supplier_timeout: 2000..60000, default 20000; keep it below our own
 *     HTTP timeout so Duffel answers with the offers it has).
 *   - Headers: Authorization: Bearer <token>, Duffel-Version: v2,
 *     Content-Type: application/json, Accept: application/json.
 *   - Body: { data: { slices: [{origin, destination, departure_date}],
 *     passengers: [{type:"adult"} | {age}], cabin_class, max_connections } }.
 *     A passenger carries `type` or `age`, never both, and ages under 18 must be
 *     given, so children and infants are sent by age.
 *   - Response: { data: { id, offers: [...] } }. Offer: id, total_amount,
 *     total_currency, slices[{duration (ISO 8601), fare_brand_name, segments[]}],
 *     conditions{refund_before_departure, change_before_departure},
 *     segments[].passengers[].baggages[{type, quantity}].
 *   - Errors: { errors: [{type, code, title, message}], meta: {status, request_id} }.
 *     401 authentication_error, 422 validation_error, 429 rate_limit_error.
 */

export const DUFFEL_BASE_URL = "https://api.duffel.com";
export const DUFFEL_VERSION = "v2";
/** Default HTTP timeout. Duffel's own supplier timeout is set 5 s below it. */
export const DUFFEL_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Duffel needs an age for travellers under 18 and PLAN.md 3.5 carries only
 * counts. These ages are an assumption: a child is priced as 8, an infant as 1
 * (infants under 2 travel on a lap, which is Duffel's "infant without seat").
 */
export const ASSUMED_CHILD_AGE = 8;
export const ASSUMED_INFANT_AGE = 1;

export interface DuffelProviderOptions {
  /** Duffel access token. Without it the provider is not configured. */
  apiKey?: string;
  /** For tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to https://api.duffel.com. */
  baseUrl?: string;
  /** Defaults to 30 s. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Response shape (only the fields we read; everything else is ignored)
// ---------------------------------------------------------------------------

const CarrierSchema = z.object({
  iata_code: z.string().nullish(),
  name: z.string().nullish(),
});

const PlaceSchema = z.object({ iata_code: z.string().min(1) });

const BaggageSchema = z.object({ type: z.string(), quantity: z.number() });

const DuffelSegmentSchema = z.object({
  operating_carrier: CarrierSchema.nullish(),
  marketing_carrier: CarrierSchema.nullish(),
  operating_carrier_flight_number: z.string().nullish(),
  marketing_carrier_flight_number: z.string().nullish(),
  origin: PlaceSchema,
  destination: PlaceSchema,
  departing_at: z.string(),
  arriving_at: z.string(),
  duration: z.string().nullish(),
  aircraft: z.object({ name: z.string().nullish() }).nullish(),
  passengers: z
    .array(z.object({ baggages: z.array(BaggageSchema).nullish() }))
    .nullish(),
});

const ConditionSchema = z
  .object({
    allowed: z.boolean(),
    penalty_amount: z.string().nullish(),
    penalty_currency: z.string().nullish(),
  })
  .nullish();

const DuffelOfferSchema = z.object({
  id: z.string().min(1),
  total_amount: z.string(),
  total_currency: z.string(),
  partial: z.boolean().nullish(),
  slices: z
    .array(
      z.object({
        duration: z.string().nullish(),
        fare_brand_name: z.string().nullish(),
        segments: z.array(DuffelSegmentSchema).min(1),
      }),
    )
    .min(1),
  conditions: z
    .object({
      refund_before_departure: ConditionSchema,
      change_before_departure: ConditionSchema,
    })
    .nullish(),
});

const DuffelResponseSchema = z.object({
  data: z.object({ offers: z.array(z.unknown()) }),
});

type DuffelOffer = z.infer<typeof DuffelOfferSchema>;
type DuffelSegment = z.infer<typeof DuffelSegmentSchema>;

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Minutes in an ISO 8601 duration such as "PT2H26M", "PT02H26M", "P1DT3H" or
 * "PT90M". Seconds round to the nearest minute. Years and months are rejected
 * (their length is not fixed); Duffel does not emit them. Undefined when unparseable.
 */
export function parseIsoDurationMinutes(value: string): number | undefined {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (m === null || value.trim() === "P" || value.trim().endsWith("T")) return undefined;
  const [, w, d, h, min, s] = m;
  if (w === undefined && d === undefined && h === undefined && min === undefined && s === undefined) {
    return undefined;
  }
  const total =
    Number(w ?? 0) * 7 * 24 * 60 +
    Number(d ?? 0) * 24 * 60 +
    Number(h ?? 0) * 60 +
    Number(min ?? 0) +
    Number(s ?? 0) / 60;
  return Math.round(total);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Epoch milliseconds for an ISO 8601 date-time. A value without an offset is
 * a local wall-clock time and is read as UTC, which is correct for the only
 * use here: the difference of two times at the same airport.
 */
export function wallClockMs(value: string): number | undefined {
  const m = LOCAL_DATE_TIME.exec(value);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s, off] = m;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (Number.isNaN(base)) return undefined;
  if (off === undefined || off === "Z") return base;
  const sign = off.startsWith("-") ? -1 : 1;
  const digits = off.slice(1).replace(":", "");
  const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
  return base - sign * offsetMin * 60_000;
}

/** Whole minutes from `a` to `b` (both ISO 8601), or undefined if either is unparseable. */
export function minutesBetween(a: string, b: string): number | undefined {
  const from = wallClockMs(a);
  const to = wallClockMs(b);
  if (from === undefined || to === undefined) return undefined;
  return Math.round((to - from) / 60_000);
}

class OfferMappingError extends Error {}

function carrierOf(seg: DuffelSegment): { code: string; name: string; number: string } {
  const operating = seg.operating_carrier?.iata_code ? seg.operating_carrier : undefined;
  const carrier = operating ?? seg.marketing_carrier;
  const code = carrier?.iata_code?.toUpperCase();
  if (!code) throw new OfferMappingError("segment has no carrier IATA code");
  const number =
    (operating !== undefined ? seg.operating_carrier_flight_number : undefined) ??
    seg.marketing_carrier_flight_number ??
    seg.operating_carrier_flight_number;
  if (!number) throw new OfferMappingError("segment has no flight number");
  return { code, name: carrier?.name ?? code, number: `${code}${number.trim()}` };
}

function mapSegment(seg: DuffelSegment, sliceDurationIfOnly: number | undefined): FlightSegment {
  const carrier = carrierOf(seg);
  const duration =
    seg.duration != null ? parseIsoDurationMinutes(seg.duration) : sliceDurationIfOnly;
  if (duration === undefined) throw new OfferMappingError("segment has no usable duration");
  const aircraft = seg.aircraft?.name ?? undefined;
  return {
    airline: carrier.code,
    airline_name: carrier.name,
    flight_number: carrier.number,
    depart_airport: seg.origin.iata_code.toUpperCase(),
    depart_at: seg.departing_at,
    arrive_airport: seg.destination.iata_code.toUpperCase(),
    arrive_at: seg.arriving_at,
    duration_min: duration,
    ...(aircraft ? { aircraft } : {}),
  };
}

function mapSlice(slice: DuffelOffer["slices"][number]): { slice: FlightSlice; durationMin: number } {
  const onlyDuration =
    slice.segments.length === 1 && slice.duration != null ? parseIsoDurationMinutes(slice.duration) : undefined;
  const segments = slice.segments.map((s) => mapSegment(s, onlyDuration));

  const layovers: FlightLayover[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const next = segments[i];
    if (prev === undefined || next === undefined) continue;
    const gap = minutesBetween(prev.arrive_at, next.depart_at);
    if (gap === undefined || gap < 0) {
      throw new OfferMappingError(`inconsistent connection times at ${prev.arrive_airport}`);
    }
    layovers.push({ airport: prev.arrive_airport, duration_min: gap });
  }

  let durationMin = slice.duration != null ? parseIsoDurationMinutes(slice.duration) : undefined;
  if (durationMin === undefined) {
    // Duffel always sends a slice duration; if it is missing, rebuild it from the parts.
    durationMin =
      segments.reduce((sum, s) => sum + s.duration_min, 0) + layovers.reduce((sum, l) => sum + l.duration_min, 0);
  }
  return { slice: { segments, layovers }, durationMin };
}

function describeFee(c: NonNullable<z.infer<typeof ConditionSchema>>): string {
  if (c.penalty_amount && c.penalty_currency) return ` (fee ${c.penalty_amount} ${c.penalty_currency})`;
  return "";
}

function bagCount(entries: Array<{ baggages?: Array<{ type: string; quantity: number }> | null }>, type: string): number {
  // Smallest quantity across all segments and travellers: the offer only
  // "includes" a bag if every leg does.
  return Math.min(
    ...entries.map((e) =>
      (e.baggages ?? []).filter((b) => b.type === type).reduce((sum, b) => sum + b.quantity, 0),
    ),
  );
}

function buildFareNotes(offer: DuffelOffer): string[] {
  const notes: string[] = [];

  const brands = [...new Set(offer.slices.map((s) => s.fare_brand_name).filter((b): b is string => !!b))];
  if (brands.length > 0) notes.push(`Fare: ${brands.join(" / ")}`);

  const refund = offer.conditions?.refund_before_departure;
  if (refund) {
    notes.push(refund.allowed ? `Refundable before departure${describeFee(refund)}` : "Non-refundable");
  }
  const change = offer.conditions?.change_before_departure;
  if (change) {
    notes.push(change.allowed ? `Changeable before departure${describeFee(change)}` : "Not changeable");
  }

  const entries = offer.slices.flatMap((s) => s.segments.flatMap((seg) => seg.passengers ?? []));
  if (entries.some((e) => e.baggages != null)) {
    const checked = bagCount(entries, "checked");
    const carryOn = bagCount(entries, "carry_on");
    notes.push(checked > 0 ? `Checked bags included: ${checked}` : "No checked bag included");
    notes.push(carryOn > 0 ? `Carry-on bags included: ${carryOn}` : "No carry-on bag included");
  }
  return notes;
}

/** Map one Duffel offer to the shared schema. Throws OfferMappingError when it cannot. */
export function mapDuffelOffer(raw: unknown): FlightOffer | undefined {
  const parsed = DuffelOfferSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OfferMappingError(parsed.error.issues[0]?.message ?? "offer does not match the expected shape");
  }
  const offer = parsed.data;
  if (offer.partial === true) {
    // Partial offers must be combined with others to be bookable; not a complete itinerary.
    return undefined;
  }
  const amount = Number(offer.total_amount);
  if (!Number.isFinite(amount) || amount < 0) throw new OfferMappingError("total_amount is not a number");

  const mapped = offer.slices.map(mapSlice);
  const stops = Math.max(...mapped.map((m) => m.slice.segments.length - 1));
  const fareNotes = buildFareNotes(offer);

  const result: FlightOffer = {
    id: offer.id,
    source: "duffel",
    price: { amount, currency: offer.total_currency.toUpperCase() },
    total_duration_min: mapped.reduce((sum, m) => sum + m.durationMin, 0),
    stops,
    slices: mapped.map((m) => m.slice),
    ...(fareNotes.length > 0 ? { fare_notes: fareNotes } : {}),
  };
  return FlightOfferSchema.parse(result);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function errorDetail(bodyText: string): string {
  try {
    const body: unknown = JSON.parse(bodyText);
    const parsed = z
      .object({
        errors: z.array(z.object({ message: z.string().optional(), title: z.string().optional(), code: z.string().optional() })),
        meta: z.object({ request_id: z.string().optional() }).optional(),
      })
      .safeParse(body);
    if (parsed.success) {
      const first = parsed.data.errors[0];
      const text = first?.message ?? first?.title ?? first?.code;
      const rid = parsed.data.meta?.request_id;
      if (text) return rid ? `${text} (request ${rid})` : text;
    }
  } catch {
    // not JSON; fall through
  }
  return bodyText.slice(0, 200).replace(/\s+/g, " ").trim();
}

export class DuffelProvider implements FlightProvider {
  readonly name = "duffel" as const;

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DuffelProviderOptions = {}) {
    const key = options.apiKey?.trim();
    this.apiKey = key ? key : undefined;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? DUFFEL_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DUFFEL_DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  async search(query: NormalizedFlightsQuery, signal: AbortSignal): Promise<FlightOffer[]> {
    if (this.apiKey === undefined) {
      throw new FlightProviderError("DUFFEL_API_KEY is not set", {
        provider: "duffel",
        code: "config",
        retryable: false,
      });
    }
    if (signal.aborted) throw this.abortError();

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    const supplierTimeout = Math.min(60_000, Math.max(2_000, this.timeoutMs - 5_000));
    const url = `${this.baseUrl}/air/offer_requests?return_offers=true&supplier_timeout=${supplierTimeout}`;

    let bodyText: string;
    let status: number;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Duffel-Version": DUFFEL_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildRequestBody(query)),
        signal: combined,
      });
      status = res.status;
      bodyText = await res.text();
    } catch (err) {
      throw this.transportError(err, signal, timeoutSignal);
    }

    if (status < 200 || status >= 300) {
      throw this.httpError(status, bodyText);
    }

    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch (err) {
      throw this.malformed("response body is not valid JSON", err);
    }
    const envelope = DuffelResponseSchema.safeParse(json);
    if (!envelope.success) {
      throw this.malformed("response has no data.offers array");
    }

    const offers: FlightOffer[] = [];
    let failures = 0;
    let firstFailure = "";
    for (const raw of envelope.data.data.offers) {
      try {
        const mapped = mapDuffelOffer(raw);
        if (mapped !== undefined) offers.push(mapped);
      } catch (err) {
        failures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        firstFailure ||= reason;
        log.warn("duffel: skipped an offer that could not be mapped", { reason });
      }
    }
    if (failures > 0 && offers.length === 0 && failures === envelope.data.data.offers.length) {
      throw this.malformed(`none of the ${failures} offers could be mapped (first problem: ${firstFailure})`);
    }

    const currencies = new Set(offers.map((o) => o.price.currency));
    if (currencies.size > 1) {
      log.warn("duffel: offers are in several currencies; sorting by raw amount", {
        currencies: [...currencies],
      });
    }
    offers.sort(
      (a, b) =>
        a.price.amount - b.price.amount || a.total_duration_min - b.total_duration_min || a.id.localeCompare(b.id),
    );
    return offers.slice(0, MAX_OFFERS);
  }

  private abortError(): FlightProviderError {
    return new FlightProviderError("Duffel request was aborted", {
      provider: "duffel",
      code: "timeout",
      retryable: false,
    });
  }

  private transportError(err: unknown, caller: AbortSignal, timeout: AbortSignal): FlightProviderError {
    if (caller.aborted) return this.abortError();
    if (timeout.aborted) {
      return new FlightProviderError(`Duffel request timed out after ${this.timeoutMs} ms`, {
        provider: "duffel",
        code: "timeout",
        retryable: true,
        cause: err,
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    return new FlightProviderError(`Duffel request failed: ${reason}`, {
      provider: "duffel",
      code: "provider",
      retryable: true,
      cause: err,
    });
  }

  private httpError(status: number, bodyText: string): FlightProviderError {
    const detail = errorDetail(bodyText);
    const suffix = detail ? `: ${detail}` : "";
    if (status === 401 || status === 403) {
      return new FlightProviderError(`Duffel rejected the API key (HTTP ${status})${suffix}`, {
        provider: "duffel",
        code: "config",
        retryable: false,
        status,
      });
    }
    if (status === 400 || status === 422) {
      return new FlightProviderError(`Duffel rejected the search (HTTP ${status})${suffix}`, {
        provider: "duffel",
        code: "invalid_input",
        retryable: false,
        status,
      });
    }
    return new FlightProviderError(`Duffel returned HTTP ${status}${suffix}`, {
      provider: "duffel",
      code: "provider",
      retryable: status === 429 || status >= 500,
      status,
    });
  }

  private malformed(message: string, cause?: unknown): FlightProviderError {
    return new FlightProviderError(`Duffel sent a malformed response: ${message}`, {
      provider: "duffel",
      code: "provider",
      retryable: false,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** Request body for POST /air/offer_requests. Exported for tests. */
export function buildRequestBody(query: NormalizedFlightsQuery): Record<string, unknown> {
  const slices = [
    { origin: query.origin, destination: query.destination, departure_date: query.depart_date },
  ];
  if (query.return_date !== undefined) {
    slices.push({ origin: query.destination, destination: query.origin, departure_date: query.return_date });
  }
  const passengers: Array<{ type: "adult" } | { age: number }> = [];
  for (let i = 0; i < query.passengers.adults; i++) passengers.push({ type: "adult" });
  for (let i = 0; i < query.passengers.children; i++) passengers.push({ age: ASSUMED_CHILD_AGE });
  for (let i = 0; i < query.passengers.infants; i++) passengers.push({ age: ASSUMED_INFANT_AGE });

  return {
    data: {
      slices,
      passengers,
      cabin_class: query.cabin,
      // Duffel defaults to 1 connection when omitted, so only send it when the caller set a limit.
      ...(query.max_stops !== undefined ? { max_connections: query.max_stops } : {}),
    },
  };
}
