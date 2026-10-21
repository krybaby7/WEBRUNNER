import { z } from "zod";
import {
  DEFAULT_INTERVAL,
  MAX_BARS,
  MarketQuoteSchema,
  type AssetType,
  type Bar,
  type HistoryInterval,
  type MarketQuote,
  type SymbolMatch,
} from "../../../schemas/markets.js";
import { isoFromEpochSeconds, parseMarketBody, requestMarketJson, round, stripTrailingSlash } from "../http.js";
import { MarketProviderError, type MarketProvider, type QuoteOptions } from "../types.js";

/**
 * Yahoo Finance, keyless (PLAN.md 14.2).
 *
 * Chart (quote + history):
 *   https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=<range>&interval=<interval>&includePrePost=false
 *   `chart.result[0].meta` carries currency, symbol, exchangeName, fullExchangeName, instrumentType
 *   (EQUITY, ETF, INDEX, CRYPTOCURRENCY, MUTUALFUND), regularMarketPrice, chartPreviousClose, previousClose,
 *   regularMarketTime (epoch s), regularMarketDayHigh/Low, regularMarketVolume, fiftyTwoWeekHigh/Low, longName,
 *   shortName, exchangeTimezoneName and sometimes marketState; `timestamp[]` and `indicators.quote[0].{open,high,low,close,volume}`
 *   hold the bars (nulls for missing ticks are skipped). `chart.error.code === "Not Found"` (HTTP 404) is an unknown symbol.
 * Lookup:
 *   https://query2.finance.yahoo.com/v1/finance/search?q=<q>&quotesCount=6&newsCount=0
 *   `quotes[]` of symbol, shortname, longname, quoteType, exchange, exchDisp.
 *
 * Verification: from the development environment (cloud IP) both endpoints
 * answered HTTP 429 "Too Many Requests" with no Retry-After header on
 * 2026-10-18, so the fixtures under test/fixtures/markets/yahoo-*.json follow
 * the documented shapes and are marked unverified. A 429 is a retryable
 * `RateLimitedMarketError`, which makes the service move on to the next source.
 *
 * Quotes are delayed 15 minutes on most exchanges for free Yahoo data;
 * `delayed_min` is 15 for non-crypto instruments unless `meta.exchangeDataDelayedBy` says otherwise.
 */

export const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com";
export const YAHOO_SEARCH_BASE_URL = "https://query2.finance.yahoo.com";
export const YAHOO_DEFAULT_DELAY_MIN = 15;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const LOOKUP_COUNT = 6;

export interface YahooProviderOptions {
  fetchImpl?: typeof fetch;
  /** Chart endpoint origin. Default query1.finance.yahoo.com. */
  baseUrl?: string;
  /** Search endpoint origin. Default query2.finance.yahoo.com. */
  searchBaseUrl?: string;
  userAgent?: string;
}

const num = z.number().nullable().optional();
const ChartMeta = z.object({
  currency: z.string().nullish(),
  symbol: z.string(),
  exchangeName: z.string().nullish(),
  fullExchangeName: z.string().nullish(),
  instrumentType: z.string().nullish(),
  regularMarketPrice: z.number(),
  chartPreviousClose: num,
  previousClose: num,
  regularMarketTime: z.number().nullish(),
  regularMarketDayHigh: num,
  regularMarketDayLow: num,
  regularMarketVolume: num,
  fiftyTwoWeekHigh: num,
  fiftyTwoWeekLow: num,
  longName: z.string().nullish(),
  shortName: z.string().nullish(),
  exchangeTimezoneName: z.string().nullish(),
  marketState: z.string().nullish(),
  exchangeDataDelayedBy: z.number().nullish(),
});
const series = z.array(z.number().nullable()).optional();
const ChartResponse = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: ChartMeta,
          timestamp: z.array(z.number()).optional(),
          indicators: z
            .object({
              quote: z.array(z.object({ open: series, high: series, low: series, close: series, volume: series })).optional(),
            })
            .optional(),
        }),
      )
      .nullable(),
    error: z.object({ code: z.string().nullish(), description: z.string().nullish() }).nullable().optional(),
  }),
});

const SearchResponse = z.object({
  quotes: z
    .array(
      z.object({
        symbol: z.string(),
        shortname: z.string().nullish(),
        longname: z.string().nullish(),
        quoteType: z.string().nullish(),
        exchange: z.string().nullish(),
        exchDisp: z.string().nullish(),
      }),
    )
    .optional(),
});

/** Yahoo `instrumentType` / `quoteType` to the shared asset type. */
export function yahooAssetType(type: string | null | undefined): AssetType {
  switch ((type ?? "").toUpperCase()) {
    case "EQUITY":
      return "stock";
    case "ETF":
      return "etf";
    case "INDEX":
      return "index";
    case "CRYPTOCURRENCY":
      return "crypto";
    case "MUTUALFUND":
      return "fund";
    default:
      return "other";
  }
}

export function yahooMarketState(state: string | null | undefined): MarketQuote["market_state"] | undefined {
  switch ((state ?? "").toUpperCase()) {
    case "PRE":
      return "pre";
    case "REGULAR":
      return "regular";
    case "POST":
      return "post";
    case "CLOSED":
    case "PREPRE":
    case "POSTPOST":
      return "closed";
    default:
      return undefined;
  }
}

/** Zip Yahoo's parallel arrays into bars, skipping ticks with a null OHLC, ascending, at most MAX_BARS (the latest). */
export function yahooBars(
  timestamps: readonly number[],
  q: { open?: readonly (number | null)[]; high?: readonly (number | null)[]; low?: readonly (number | null)[]; close?: readonly (number | null)[]; volume?: readonly (number | null)[] },
): Bar[] {
  const bars: Bar[] = [];
  timestamps.forEach((t, i) => {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) return;
    const v = q.volume?.[i];
    bars.push({ t: isoFromEpochSeconds(t), o, h, l, c, ...(v != null && v >= 0 && { v }) });
  });
  bars.sort((a, b) => a.t.localeCompare(b.t));
  return bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars;
}

export class YahooProvider implements MarketProvider {
  readonly name = "yahoo" as const;
  readonly assetTypes = ["stock", "etf", "index", "crypto", "fund"] as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly searchBaseUrl: string;
  private readonly userAgent: string;

  constructor(options: YahooProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? YAHOO_CHART_BASE_URL);
    this.searchBaseUrl = stripTrailingSlash(options.searchBaseUrl ?? YAHOO_SEARCH_BASE_URL);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  isConfigured(): boolean {
    return true;
  }

  async lookup(query: string, signal: AbortSignal): Promise<SymbolMatch[]> {
    const params = new URLSearchParams({ q: query, quotesCount: String(LOOKUP_COUNT), newsCount: "0" });
    const { body } = await requestMarketJson({
      provider: this.name,
      url: `${this.searchBaseUrl}/v1/finance/search?${params.toString()}`,
      fetchImpl: this.fetchImpl,
      signal,
      headers: { "User-Agent": this.userAgent },
    });
    const parsed = parseMarketBody(this.name, SearchResponse, body);
    return (parsed.quotes ?? []).map((q) => {
      const name = q.longname ?? q.shortname ?? undefined;
      const exchange = q.exchDisp ?? q.exchange ?? undefined;
      return {
        symbol: q.symbol,
        ...(name !== undefined && name !== "" && { name }),
        asset_type: yahooAssetType(q.quoteType),
        ...(exchange !== undefined && exchange !== "" && { exchange }),
        source: this.name,
      };
    });
  }

  async quote(symbol: string, opts: QuoteOptions, signal: AbortSignal): Promise<MarketQuote> {
    const range = opts.history?.range ?? "1d";
    const interval: HistoryInterval = opts.history?.interval ?? DEFAULT_INTERVAL[range];
    const params = new URLSearchParams({ range, interval: opts.history !== undefined ? interval : "1d", includePrePost: "false" });
    const { body } = await requestMarketJson({
      provider: this.name,
      url: `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`,
      fetchImpl: this.fetchImpl,
      signal,
      headers: { "User-Agent": this.userAgent },
      acceptStatuses: [404],
    });
    const parsed = parseMarketBody(this.name, ChartResponse, body);
    const error = parsed.chart.error;
    if (error != null) {
      const code = error.code ?? "";
      if (/not found/i.test(code)) {
        throw new MarketProviderError(`yahoo knows no symbol "${symbol}"${error.description ? ` (${error.description})` : ""}`, {
          provider: this.name,
          code: "not_found",
          retryable: false,
        });
      }
      throw new MarketProviderError(`yahoo chart error ${code}: ${error.description ?? ""}`.trim(), {
        provider: this.name,
        code: "provider",
        retryable: false,
      });
    }
    const result = parsed.chart.result?.[0];
    if (result === undefined) {
      throw new MarketProviderError(`yahoo returned no chart result for "${symbol}"`, { provider: this.name, code: "not_found", retryable: false });
    }
    const m = result.meta;
    const assetType = yahooAssetType(m.instrumentType);
    const price = m.regularMarketPrice;
    const previous = m.chartPreviousClose ?? m.previousClose ?? undefined;
    const change = previous !== undefined ? round(price - previous, 6) : undefined;
    const changePct = previous !== undefined && previous !== 0 ? round(((price - previous) / previous) * 100, 4) : undefined;
    const name = m.longName ?? m.shortName ?? undefined;
    const exchange = m.fullExchangeName ?? m.exchangeName ?? undefined;
    const state = yahooMarketState(m.marketState);
    const asOf = m.regularMarketTime != null ? isoFromEpochSeconds(m.regularMarketTime) : new Date().toISOString();
    const delay = assetType === "crypto" ? undefined : (m.exchangeDataDelayedBy ?? YAHOO_DEFAULT_DELAY_MIN);
    const currency = (m.currency ?? "").toUpperCase();

    const quote: MarketQuote = {
      requested: symbol,
      symbol: m.symbol,
      ...(name !== undefined && name !== "" && { name }),
      asset_type: assetType,
      ...(exchange !== undefined && exchange !== "" && { exchange }),
      currency,
      price,
      ...(previous !== undefined && { previous_close: previous }),
      ...(change !== undefined && { change }),
      ...(changePct !== undefined && { change_pct: changePct }),
      ...(m.regularMarketDayHigh != null && { day_high: m.regularMarketDayHigh }),
      ...(m.regularMarketDayLow != null && { day_low: m.regularMarketDayLow }),
      ...(m.regularMarketVolume != null && m.regularMarketVolume >= 0 && { volume: m.regularMarketVolume }),
      ...(m.fiftyTwoWeekHigh != null && { week52_high: m.fiftyTwoWeekHigh }),
      ...(m.fiftyTwoWeekLow != null && { week52_low: m.fiftyTwoWeekLow }),
      ...(state !== undefined && { market_state: state }),
      as_of: asOf,
      ...(delay !== undefined && { delayed_min: Math.max(0, Math.round(delay)) }),
      source: this.name,
    };
    const bars = yahooBars(result.timestamp ?? [], result.indicators?.quote?.[0] ?? {});
    if (opts.history !== undefined) {
      quote.history = { range, interval, bars };
    }
    if (quote.open === undefined && bars.length > 0 && opts.history === undefined) {
      // The 1d/1d request returns the session's single bar; its open is the day's open.
      quote.open = (bars[0] as Bar).o;
    }
    const checked = MarketQuoteSchema.safeParse(quote);
    if (!checked.success) {
      throw new MarketProviderError(`yahoo data for "${symbol}" did not fit the quote schema (${checked.error.issues[0]?.message ?? "invalid"})`, {
        provider: this.name,
        code: "provider",
        retryable: false,
      });
    }
    return checked.data;
  }
}
