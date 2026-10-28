import { z } from "zod";
import type { Logger } from "../../log.js";
import { EARLIEST_RATE_DATE, ExchangeRateOutputSchema, type ExchangeRateOutput } from "../../schemas/fx.js";
import type { Cache } from "../cache/index.js";

/**
 * Exchange rates, PLAN.md 14.4: Frankfurter (ECB reference rates) first, fawazahmed0's
 * currency-api for the currencies the ECB lacks and when Frankfurter fails. Both keyless.
 *
 * Frankfurter, verified live on 2026-10-18 from the development environment:
 *   https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP
 *     -> {"amount":1.0,"base":"USD","date":"2026-10-16","rates":{"EUR":0.88865,"GBP":0.74989}}
 *   https://api.frankfurter.dev/v1/2024-03-15?base=EUR&symbols=USD,JPY
 *     -> {"amount":1.0,"base":"EUR","date":"2024-03-15","rates":{"JPY":162.03,"USD":1.0892}}
 *   https://api.frankfurter.dev/v1/currencies   -> {"AUD":"Australian Dollar", ...} (31 codes)
 * The `date` in the answer is the reference date actually used (the previous
 * working day on weekends and holidays).
 *
 * currency-api, verified live on 2026-10-28 from the owner's machine:
 *   https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json
 *     -> {"date":"2026-10-28","usd":{"1inch":11.23,"aed":3.6725,...,"egp":56.11961073,...}}
 *   ...@2026-01-01/v1/currencies/usd.json -> {"date":"2026-01-01","usd":{...,"egp":47.70320713,...}}
 *   ...@2024-03-01/... -> 404 "Couldn't find the requested release version" (history starts 2024-03-02)
 *   ...@latest/v1/currencies.json -> {"1inch":"1inch",...,"egp":"Egyptian Pound",...} (340 codes)
 *   https://latest.currency-api.pages.dev/v1/currencies/usd.json, the documented mirror, same shape.
 * Codes are lower case and include crypto and withdrawn currencies; only current ISO 4217 codes are used.
 */

export const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev";
/** jsDelivr first, then the Cloudflare Pages mirror. `{date}` is `latest` or YYYY-MM-DD. */
export const CURRENCY_API_URLS: readonly string[] = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1",
  "https://{date}.currency-api.pages.dev/v1",
];
/** currency-api's first daily file. */
export const CURRENCY_API_EARLIEST_DATE = "2024-03-02";
export const FX_DEFAULT_TIMEOUT_MS = 10_000;
export const FX_TTL_MS = {
  latest: 60 * 60_000,
  historical: 30 * 24 * 60 * 60_000,
  currencies: 7 * 24 * 60 * 60_000,
} as const;

/** Current ISO 4217 codes, from the SIX list published 2026-09-17 (178 codes). */
export const ISO_4217_CODES: ReadonlySet<string> = new Set(
  [
    "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD",
    "CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP",
    "GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR",
    "KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN",
    "MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD",
    "SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX",
    "USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD",
    "XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG",
  ]
    .join(" ")
    .split(" "),
);

export const FX_CAVEAT =
  "Rates are ECB reference rates served by Frankfurter, published once per working day around 16:00 CET; they are not a trading quote. Crypto is not covered.";
export const CURRENCY_API_CAVEAT =
  "Rates come from fawazahmed0's currency-api, a free daily aggregate of public mid-market rates published once a day; they are not an official central-bank rate, a bank's buy or sell price, or a trading quote. Crypto is not covered.";

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

/** An FxError from a non-2xx answer, carrying the status. */
class FxHttpError extends FxError {
  readonly status: number;

  constructor(status: number, message: string) {
    super("provider", message, { retryable: status === 429 || status >= 500 });
    this.status = status;
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
  /** Supported ISO codes: Frankfurter's `/v1/currencies` plus the current ISO 4217 codes in currency-api (each cached 7 days). */
  currencies(signal: AbortSignal): Promise<Record<string, string>>;
}

export interface FxServiceDeps {
  log: Logger;
  cache?: Cache;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** currency-api hosts in the order tried, each with a `{date}` placeholder. Default CURRENCY_API_URLS. */
  currencyApiUrls?: readonly string[];
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
const CurrencyApiRatesResponse = z.record(z.string(), z.unknown());

/** One currency-api file for one base: its date and every current ISO rate in it, upper-case. */
interface CurrencyApiRates {
  date: string;
  rates: Record<string, number>;
}

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
  const currencyApiUrls = (deps.currencyApiUrls ?? CURRENCY_API_URLS).map((u) => u.replace(/\/+$/, ""));
  const timeoutMs = deps.timeoutMs ?? FX_DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function getJson<S extends z.ZodType>(source: string, url: string, schema: S, signal: AbortSignal): Promise<z.infer<S>> {
    const perRequest = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    let text: string;
    try {
      res = await raceAbort(fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: perRequest }), perRequest, source);
      text = await raceAbort(res.text(), perRequest, source);
    } catch (err) {
      if (err instanceof FxError) throw err;
      if (perRequest.aborted) throw timeoutError(source, err);
      throw new FxError("provider", `${source} network error: ${message(err)}`, { retryable: true, cause: err });
    }
    if (res.status < 200 || res.status > 299) {
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new FxHttpError(res.status, `${source} returned HTTP ${res.status}${preview !== "" ? `: ${preview}` : ""}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (err) {
      throw new FxError("provider", `${source} returned a body that is not valid JSON`, { cause: err });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new FxError("provider", `${source} returned an unexpected response shape (${parsed.error.issues[0]?.message ?? "invalid"})`);
    }
    return parsed.data;
  }

  /** `path` from each currency-api host in turn; the first host's error when all fail. */
  async function currencyApiJson<S extends z.ZodType>(date: string, path: string, schema: S, signal: AbortSignal): Promise<z.infer<S>> {
    let first: unknown;
    for (const template of currencyApiUrls) {
      try {
        return await getJson("currency-api", `${template.replaceAll("{date}", date)}${path}`, schema, signal);
      } catch (err) {
        if (!(err instanceof FxError) || signal.aborted) throw err;
        first ??= err;
      }
    }
    throw first;
  }

  async function cached<T>(key: unknown, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = deps.cache !== undefined ? await deps.cache.get<T>(key) : undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    await deps.cache?.set(key, value, ttlMs);
    return value;
  }

  function ecbCurrencies(signal: AbortSignal): Promise<Record<string, string>> {
    return cached({ source: "frankfurter", kind: "currencies" }, FX_TTL_MS.currencies, () =>
      getJson("frankfurter", `${baseUrl}/v1/currencies`, CurrenciesResponse, signal),
    );
  }

  function currencyApiCurrencies(signal: AbortSignal): Promise<Record<string, string>> {
    return cached({ source: "currency-api", kind: "currencies" }, FX_TTL_MS.currencies, async () => {
      const all = await currencyApiJson("latest", "/currencies.json", CurrenciesResponse, signal);
      const iso: Record<string, string> = {};
      for (const [code, name] of Object.entries(all)) {
        const upper = code.toUpperCase();
        if (ISO_4217_CODES.has(upper)) iso[upper] = name;
      }
      return iso;
    });
  }

  async function currencies(signal: AbortSignal): Promise<Record<string, string>> {
    const [ecb, api] = await Promise.allSettled([ecbCurrencies(signal), currencyApiCurrencies(signal)]);
    if (ecb.status === "rejected" && api.status === "rejected") throw ecb.reason;
    return { ...(api.status === "fulfilled" ? api.value : {}), ...(ecb.status === "fulfilled" ? ecb.value : {}) };
  }

  /** Frankfurter's answer for a request whose codes it all covers. */
  async function fromFrankfurter(query: FxQuery, targets: string[], today: string, signal: AbortSignal): Promise<ExchangeRateOutput> {
    const wanted = targets.filter((c) => c !== query.from);
    const caveats = [FX_CAVEAT];
    let date = query.date ?? today;
    const rateOf = new Map<string, number>([[query.from, 1]]);
    if (wanted.length > 0) {
      const path = `/v1/${query.date ?? "latest"}?base=${encodeURIComponent(query.from)}&symbols=${wanted.map(encodeURIComponent).join(",")}`;
      const key = { source: "frankfurter", kind: query.date !== undefined ? "historical" : "latest", base: query.from, symbols: [...wanted].sort(), date: query.date ?? null };
      const ttl = query.date !== undefined ? FX_TTL_MS.historical : FX_TTL_MS.latest;
      const body = await cached(key, ttl, () => getJson("frankfurter", `${baseUrl}${path}`, RatesResponse, signal));
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
    return output(query, targets, date, rateOf, "frankfurter", caveats);
  }

  /** currency-api's answer; `reason` says why the ECB did not serve it. */
  async function fromCurrencyApi(query: FxQuery, targets: string[], today: string, reason: string, signal: AbortSignal): Promise<ExchangeRateOutput> {
    const wanted = targets.filter((c) => c !== query.from);
    const caveats = [CURRENCY_API_CAVEAT, reason];
    // Today's file may not be published yet; `latest` is the newest one.
    const fileDate = query.date === undefined || query.date === today ? "latest" : query.date;
    let date = query.date ?? today;
    const rateOf = new Map<string, number>([[query.from, 1]]);
    if (wanted.length > 0) {
      const key = { source: "currency-api", kind: fileDate === "latest" ? "latest" : "historical", base: query.from, date: fileDate };
      const ttl = fileDate === "latest" ? FX_TTL_MS.latest : FX_TTL_MS.historical;
      const file = await cached(key, ttl, () => currencyApiRates(query.from, fileDate, signal));
      date = file.date;
      for (const code of wanted) {
        const rate = file.rates[code];
        if (rate !== undefined) rateOf.set(code, rate);
      }
      const missing = wanted.filter((c) => !rateOf.has(c));
      if (missing.length > 0) {
        throw new FxError("provider", `currency-api returned no rate for ${missing.join(", ")} on ${date}`);
      }
      if (fileDate === "latest" && date !== today) caveats.push(`The latest currency-api date is ${date}.`);
    }
    return output(query, targets, date, rateOf, "currency-api", caveats);
  }

  async function currencyApiRates(base: string, fileDate: string, signal: AbortSignal): Promise<CurrencyApiRates> {
    const lower = base.toLowerCase();
    let body: Record<string, unknown>;
    try {
      body = await currencyApiJson(fileDate, `/currencies/${lower}.json`, CurrencyApiRatesResponse, signal);
    } catch (err) {
      if (err instanceof FxHttpError && err.status === 404 && fileDate !== "latest") {
        throw new FxError("provider", `currency-api has no rates published for ${fileDate}`, { cause: err });
      }
      throw err;
    }
    const date = body.date;
    const inner = body[lower];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof inner !== "object" || inner === null) {
      throw new FxError("provider", `currency-api returned an unexpected response shape for ${base}`);
    }
    const rates: Record<string, number> = {};
    for (const [code, rate] of Object.entries(inner)) {
      const upper = code.toUpperCase();
      if (ISO_4217_CODES.has(upper) && typeof rate === "number" && Number.isFinite(rate) && rate > 0) rates[upper] = rate;
    }
    return { date, rates };
  }

  function output(
    query: FxQuery,
    targets: string[],
    date: string,
    rateOf: Map<string, number>,
    source: ExchangeRateOutput["source"],
    caveats: string[],
  ): ExchangeRateOutput {
    if (targets.some((c) => c === query.from)) caveats.push(`${query.from} to ${query.from} is reported with rate 1.`);
    const result: ExchangeRateOutput = {
      base: query.from,
      date,
      amount: query.amount,
      rates: targets.map((currency) => {
        const rate = rateOf.get(currency) as number;
        return { currency, rate, converted: convertAmount(query.amount, rate) };
      }),
      source,
      fetched_at: new Date(now()).toISOString(),
      caveats,
    };
    const checked = ExchangeRateOutputSchema.safeParse(result);
    if (!checked.success) {
      throw new FxError("provider", `${source} data did not fit the exchange_rate schema (${checked.error.issues[0]?.message ?? "invalid"})`);
    }
    return checked.data;
  }

  /** A Frankfurter failure currency-api may stand in for: not a bad request, and not the caller giving up. */
  function canFallBack(err: unknown, signal: AbortSignal): err is FxError {
    return err instanceof FxError && err.code !== "invalid_input" && !signal.aborted;
  }

  async function convert(query: FxQuery, signal: AbortSignal): Promise<ExchangeRateOutput> {
    const targets = [...new Set(query.to)];
    const codes = [...new Set([query.from, ...targets])];
    const today = utcDateOf(now());
    if (query.date !== undefined) {
      if (query.date < EARLIEST_RATE_DATE) {
        throw new FxError("invalid_input", `date must be ${EARLIEST_RATE_DATE} or later (Frankfurter's history starts there); got ${query.date}`);
      }
      if (query.date > today) throw new FxError("invalid_input", `date ${query.date} is in the future; the latest reference date is at most ${today}`);
    }
    const apiCovers = query.date === undefined || query.date >= CURRENCY_API_EARLIEST_DATE;

    let ecb: Record<string, string> | undefined;
    let ecbFailure: FxError | undefined;
    try {
      ecb = await ecbCurrencies(signal);
    } catch (err) {
      if (!canFallBack(err, signal) || !apiCovers) throw err;
      ecbFailure = err;
    }

    let notEcb: string[] = [];
    if (ecb !== undefined) {
      const known = ecb;
      notEcb = codes.filter((c) => !(c in known));
      if (notEcb.length === 0) {
        try {
          return await fromFrankfurter(query, targets, today, signal);
        } catch (err) {
          if (!canFallBack(err, signal) || !apiCovers) throw err;
          ecbFailure = err;
        }
      }
    }

    // Only a code outside the ECB list gets here with an early date: Frankfurter's failures rethrow above.
    if (!apiCovers) {
      throw new FxError(
        "invalid_input",
        `the ECB reference rates do not cover ${notEcb.join(", ")}, and currency-api, which covers more currencies, has rates from ${CURRENCY_API_EARLIEST_DATE}; got ${query.date}`,
        { details: { not_ecb: notEcb, earliest: CURRENCY_API_EARLIEST_DATE } },
      );
    }
    if (ecbFailure !== undefined) deps.log.warn("exchange_rate is falling back to currency-api", { error: ecbFailure.message });
    const bothFailed = (err: unknown): unknown =>
      ecbFailure === undefined || !(err instanceof FxError) || signal.aborted
        ? err
        : new FxError(err.code, `frankfurter failed (${ecbFailure.message}) and currency-api failed (${err.message})`, { retryable: err.retryable, cause: err });

    let api: Record<string, string>;
    try {
      api = await currencyApiCurrencies(signal);
    } catch (err) {
      throw bothFailed(err);
    }
    const unsupported = codes.filter((c) => !(c in api) && !(ecb !== undefined && c in ecb));
    if (unsupported.length > 0) {
      const checked =
        ecb !== undefined
          ? "the ECB reference rates (Frankfurter) or the current ISO 4217 currencies in currency-api"
          : "the current ISO 4217 currencies in currency-api (Frankfurter's list could not be fetched)";
      throw new FxError("invalid_input", `unsupported currency code${unsupported.length > 1 ? "s" : ""} ${unsupported.join(", ")}: not in ${checked}. For crypto, use market_quote.`, {
        details: { unsupported, supported: Object.keys({ ...api, ...ecb }).sort() },
      });
    }

    const reason =
      ecbFailure !== undefined
        ? `Frankfurter failed (${ecbFailure.message}), so these rates come from currency-api.`
        : `The ECB reference rates do not cover ${notEcb.join(", ")}, so these rates come from currency-api.`;
    try {
      return await fromCurrencyApi(query, targets, today, reason, signal);
    } catch (err) {
      throw bothFailed(err);
    }
  }

  return { convert, currencies };
}

function timeoutError(source: string, cause: unknown): FxError {
  return new FxError("timeout", `${source} did not answer in time (timed out or cancelled)`, { retryable: true, cause });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reject when `signal` aborts, even if the underlying promise never settles. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, source: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(timeoutError(source, signal.reason));
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
