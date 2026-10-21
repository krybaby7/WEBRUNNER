import { z } from "zod";
import type { Logger } from "../../log.js";
import { EARLIEST_RATE_DATE, ExchangeRateOutputSchema, type ExchangeRateOutput } from "../../schemas/fx.js";
import type { Cache } from "../cache/index.js";

/**
 * Exchange rates from Frankfurter (ECB reference rates), PLAN.md 14.4.
 * Keyless. Endpoints verified live on 2026-10-18 from the development environment:
 *   https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP
 *     -> {"amount":1.0,"base":"USD","date":"2026-10-16","rates":{"EUR":0.88865,"GBP":0.74989}}
 *   https://api.frankfurter.dev/v1/2024-03-15?base=EUR&symbols=USD,JPY
 *     -> {"amount":1.0,"base":"EUR","date":"2024-03-15","rates":{"JPY":162.03,"USD":1.0892}}
 *   https://api.frankfurter.dev/v1/currencies   -> {"AUD":"Australian Dollar", ...} (31 codes)
 * The `date` in the answer is the reference date actually used (the previous
 * working day on weekends and holidays).
 */

export const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev";
export const FX_DEFAULT_TIMEOUT_MS = 10_000;
export const FX_TTL_MS = {
  latest: 60 * 60_000,
  historical: 30 * 24 * 60 * 60_000,
  currencies: 7 * 24 * 60 * 60_000,
} as const;

export const FX_CAVEAT =
  "Rates are ECB reference rates served by Frankfurter, published once per working day around 16:00 CET; they are not a trading quote. Crypto is not covered.";

export type FxErrorCode = "invalid_input" | "provider" | "timeout";

export class FxError extends Error {
  readonly code: FxErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: FxErrorCode, message: string, options: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FxError";
    this.code = code;
    this.retryable = options.retryable ?? code === "timeout";
    if (options.details !== undefined) this.details = options.details;
  }
}

/** The parsed `exchange_rate` input (codes upper-cased by the schema). */
export interface FxQuery {
  from: string;
  to: string[];
  amount: number;
  date?: string;
}

export interface FxService {
  convert(query: FxQuery, signal: AbortSignal): Promise<ExchangeRateOutput>;
  /** Supported ISO codes, from `/v1/currencies` (cached 7 days). */
  currencies(signal: AbortSignal): Promise<Record<string, string>>;
}

export interface FxServiceDeps {
  log: Logger;
  cache?: Cache;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  /** Clock in epoch milliseconds, for the "date in the future" check and fetched_at. Default Date.now. */
  now?: () => number;
}

const RatesResponse = z.object({
  amount: z.number(),
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});
const CurrenciesResponse = z.record(z.string(), z.string());

/** UTC calendar date of an epoch, YYYY-MM-DD. */
export function utcDateOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** `amount * rate` rounded to 6 decimals. */
export function convertAmount(amount: number, rate: number): number {
  return Math.round(amount * rate * 1e6) / 1e6;
}

export function createFxService(deps: FxServiceDeps): FxService {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const baseUrl = (deps.baseUrl ?? FRANKFURTER_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? FX_DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function getJson<S extends z.ZodType>(path: string, schema: S, signal: AbortSignal): Promise<z.infer<S>> {
    const url = `${baseUrl}${path}`;
    const perRequest = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    let text: string;
    try {
      res = await raceAbort(fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: perRequest }), perRequest);
      text = await raceAbort(res.text(), perRequest);
    } catch (err) {
      if (err instanceof FxError) throw err;
      if (perRequest.aborted) throw timeoutError(err);
      throw new FxError("provider", `frankfurter network error: ${message(err)}`, { retryable: true, cause: err });
    }
    if (res.status < 200 || res.status > 299) {
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new FxError("provider", `frankfurter returned HTTP ${res.status}${preview !== "" ? `: ${preview}` : ""}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (err) {
      throw new FxError("provider", "frankfurter returned a body that is not valid JSON", { cause: err });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new FxError("provider", `frankfurter returned an unexpected response shape (${parsed.error.issues[0]?.message ?? "invalid"})`);
    }
    return parsed.data;
  }

  async function cached<T>(key: unknown, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = deps.cache !== undefined ? await deps.cache.get<T>(key) : undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    await deps.cache?.set(key, value, ttlMs);
    return value;
  }

  async function currencies(signal: AbortSignal): Promise<Record<string, string>> {
    return cached({ source: "frankfurter", kind: "currencies" }, FX_TTL_MS.currencies, () =>
      getJson("/v1/currencies", CurrenciesResponse, signal),
    );
  }

  async function convert(query: FxQuery, signal: AbortSignal): Promise<ExchangeRateOutput> {
    const targets = [...new Set(query.to)];
    const today = utcDateOf(now());
    if (query.date !== undefined) {
      if (query.date < EARLIEST_RATE_DATE) {
        throw new FxError("invalid_input", `date must be ${EARLIEST_RATE_DATE} or later (Frankfurter's history starts there); got ${query.date}`);
      }
      if (query.date > today) throw new FxError("invalid_input", `date ${query.date} is in the future; the latest reference date is at most ${today}`);
    }

    const supported = await currencies(signal);
    const codes = Object.keys(supported).sort();
    const unsupported = [query.from, ...targets].filter((c) => !(c in supported));
    if (unsupported.length > 0) {
      throw new FxError(
        "invalid_input",
        `unsupported currency code${unsupported.length > 1 ? "s" : ""} ${[...new Set(unsupported)].join(", ")}; Frankfurter covers ${codes.join(", ")}`,
        { details: { unsupported: [...new Set(unsupported)], supported: codes } },
      );
    }

    const wanted = targets.filter((c) => c !== query.from);
    const fetchedAt = new Date(now()).toISOString();
    const caveats = [FX_CAVEAT];

    let date = query.date ?? today;
    const rateOf = new Map<string, number>([[query.from, 1]]);
    if (wanted.length > 0) {
      const path = `/v1/${query.date ?? "latest"}?base=${encodeURIComponent(query.from)}&symbols=${wanted.map(encodeURIComponent).join(",")}`;
      const key = { source: "frankfurter", kind: query.date !== undefined ? "historical" : "latest", base: query.from, symbols: [...wanted].sort(), date: query.date ?? null };
      const ttl = query.date !== undefined ? FX_TTL_MS.historical : FX_TTL_MS.latest;
      const body = await cached(key, ttl, () => getJson(path, RatesResponse, signal));
      date = body.date;
      for (const [code, rate] of Object.entries(body.rates)) rateOf.set(code, rate);
      const missing = wanted.filter((c) => !rateOf.has(c));
      if (missing.length > 0) {
        throw new FxError("provider", `frankfurter returned no rate for ${missing.join(", ")} on ${date}`);
      }
    }
    if (query.date !== undefined && date !== query.date) {
      caveats.push(`${query.date} is not an ECB working day; the rates are for ${date}, the previous working day.`);
    } else if (query.date === undefined && date !== today) {
      caveats.push(`The latest ECB reference date is ${date}.`);
    }
    if (wanted.length < targets.length) caveats.push(`${query.from} to ${query.from} is reported with rate 1.`);

    const output: ExchangeRateOutput = {
      base: query.from,
      date,
      amount: query.amount,
      rates: targets.map((currency) => {
        const rate = rateOf.get(currency) as number;
        return { currency, rate, converted: convertAmount(query.amount, rate) };
      }),
      source: "frankfurter",
      fetched_at: fetchedAt,
      caveats,
    };
    const checked = ExchangeRateOutputSchema.safeParse(output);
    if (!checked.success) {
      throw new FxError("provider", `frankfurter data did not fit the exchange_rate schema (${checked.error.issues[0]?.message ?? "invalid"})`);
    }
    return checked.data;
  }

  return { convert, currencies };
}

function timeoutError(cause: unknown): FxError {
  return new FxError("timeout", "frankfurter did not answer in time (timed out or cancelled)", { retryable: true, cause });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reject when `signal` aborts, even if the underlying promise never settles. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(timeoutError(signal.reason));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
