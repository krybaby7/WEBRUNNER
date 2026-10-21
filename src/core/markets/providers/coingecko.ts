import { z } from "zod";
import {
  HISTORY_INTERVALS,
  MAX_BARS,
  MarketQuoteSchema,
  type Bar,
  type HistoryInterval,
  type HistoryRange,
  type MarketQuote,
  type SymbolMatch,
} from "../../../schemas/markets.js";
import { parseMarketBody, requestMarketJson, round, stripTrailingSlash } from "../http.js";
import { MarketProviderError, type MarketProvider, type QuoteOptions } from "../types.js";

/**
 * CoinGecko (keyless public API), PLAN.md 14.2. Verified live on 2026-10-18 from the development environment:
 *   /api/v3/search?query=bitcoin
 *     -> { coins: [{ id: "bitcoin", name: "Bitcoin", api_symbol, symbol: "BTC", market_cap_rank: 1, thumb, large }, ...], exchanges, ... }
 *   /api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true
 *     -> { bitcoin: { usd: 81878, usd_market_cap: 1.6e12, usd_24h_vol: 1.58e10, usd_24h_change: 0.6068, last_updated_at: 1792328037 } }
 *   /api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=7
 *     -> [[ms, o, h, l, c], ...] (42 bars at 4 h for 7 days)
 * CoinGecko picks the bar size itself: 30 min for 1-2 days, 4 h for 3-30 days, 4 days beyond; the
 * reported `interval` is the nearest supported value and a caveat says so. A 429 is retryable with Retry-After.
 *
 * `quote()` takes a symbol ("BTC", "ETH", "BTC-USD": the suffix overrides the quote currency) or a
 * CoinGecko id ("bitcoin"); ids are resolved through a built-in table, lookups seen earlier in the
 * process, then `/search` (exact symbol match by rank, else exact name match).
 */

export const COINGECKO_BASE_URL = "https://api.coingecko.com";
export const COINGECKO_INTERVAL_CAVEAT =
  "CoinGecko returns history bars at its own granularity (30 min up to 2 days, 4 h up to 30 days, 4 days beyond); the reported interval is the nearest supported value.";

/** Range to the CoinGecko `days` parameter. */
export const COINGECKO_DAYS: Readonly<Record<HistoryRange, string>> = {
  "1d": "1",
  "5d": "7",
  "1mo": "30",
  "3mo": "90",
  "6mo": "180",
  "1y": "365",
  "5y": "max",
  max: "max",
};

/** Well-known coins, so the common cases need no lookup request. */
export const KNOWN_COIN_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  USDC: "usd-coin",
  ADA: "cardano",
  DOGE: "dogecoin",
  TRX: "tron",
  TON: "the-open-network",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  LINK: "chainlink",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  SHIB: "shiba-inu",
  XLM: "stellar",
  UNI: "uniswap",
  ATOM: "cosmos",
  XMR: "monero",
  ETC: "ethereum-classic",
  NEAR: "near",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  FIL: "filecoin",
  AAVE: "aave",
};

export interface CoinGeckoProviderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const SearchResponse = z.object({
  coins: z.array(
    z.object({ id: z.string(), symbol: z.string(), name: z.string(), market_cap_rank: z.number().nullable().optional() }),
  ),
});
const PriceResponse = z.record(z.string(), z.record(z.string(), z.number().nullable()));
const OhlcResponse = z.array(z.array(z.number()));

type Coin = z.infer<typeof SearchResponse>["coins"][number];
/** A search hit with its market-cap rank (the market service uses the rank to tell a real coin from a junk token). */
export type RankedCoin = Coin;

/**
 * Best match first: exact matches (id, symbol or name) before the rest, each
 * group by market-cap rank (unranked last); equal ranks prefer id, then symbol,
 * then name. Rank decides among exact matches because tickers are not unique:
 * live (2026-10-21) `/search?query=BITCOIN` returned Bitcoin (id "bitcoin",
 * rank 1) and an unrelated token whose symbol is "BITCOIN" (rank 983).
 */
export function rankCoins(coins: readonly Coin[], query: string): Coin[] {
  const q = query.trim().toLowerCase();
  const kind = (c: Coin): number => (c.id === q ? 0 : c.symbol.toLowerCase() === q ? 1 : c.name.toLowerCase() === q ? 2 : 3);
  const exact = (c: Coin): number => (kind(c) < 3 ? 0 : 1);
  const rank = (c: Coin): number => c.market_cap_rank ?? Number.MAX_SAFE_INTEGER;
  return [...coins].sort((a, b) => exact(a) - exact(b) || rank(a) - rank(b) || kind(a) - kind(b));
}

/** Nearest supported interval to a bar size in minutes; ties go to the coarser one. */
export function nearestInterval(minutes: number): HistoryInterval {
  const MINUTES: Record<HistoryInterval, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "1d": 1440, "1wk": 10_080, "1mo": 43_200 };
  let best: HistoryInterval = "1m";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const iv of HISTORY_INTERVALS) {
    const diff = Math.abs(MINUTES[iv] - minutes);
    if (diff <= bestDiff) {
      best = iv;
      bestDiff = diff;
    }
  }
  return best;
}

/** CoinGecko's own OHLC granularity for a `days` value, in minutes. */
export function coingeckoBarMinutes(days: string): number {
  if (days === "max") return 4 * 1440;
  const n = Number(days);
  if (n <= 2) return 30;
  if (n <= 30) return 240;
  return 4 * 1440;
}

/** Split "BTC-USD" into base and quote currency; a bare symbol has no quote part. */
export function splitPair(symbol: string): { base: string; quote?: string } {
  const m = /^([A-Za-z0-9.]+)-([A-Za-z]{3})$/.exec(symbol.trim());
  if (m === null) return { base: symbol.trim() };
  return { base: m[1] as string, quote: (m[2] as string).toUpperCase() };
}

export class CoinGeckoProvider implements MarketProvider {
  readonly name = "coingecko" as const;
  readonly assetTypes = ["crypto"] as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  /**
   * Lower-cased query -> the coin it resolved to, filled by searches in this
   * process. Only the query's own best exact match is kept: every other coin a
   * search returns may share a ticker with a bigger coin ("BITCOIN").
   */
  private readonly ids = new Map<string, { id: string; symbol: string; name: string }>();

  constructor(options: CoinGeckoProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? COINGECKO_BASE_URL);
  }

  isConfigured(): boolean {
    return true;
  }

  private async get<S extends z.ZodType>(path: string, params: URLSearchParams, schema: S, signal: AbortSignal): Promise<z.infer<S>> {
    const { body } = await requestMarketJson({
      provider: this.name,
      url: `${this.baseUrl}${path}?${params.toString()}`,
      fetchImpl: this.fetchImpl,
      signal,
    });
    return parseMarketBody(this.name, schema, body);
  }

  private async search(query: string, signal: AbortSignal): Promise<Coin[]> {
    const body = await this.get("/api/v3/search", new URLSearchParams({ query }), SearchResponse, signal);
    const ranked = rankCoins(body.coins, query);
    const q = query.trim().toLowerCase();
    const top = ranked[0];
    if (top !== undefined && (top.id === q || top.symbol.toLowerCase() === q || top.name.toLowerCase() === q)) {
      this.ids.set(q, { id: top.id, symbol: top.symbol.toUpperCase(), name: top.name });
    }
    return ranked;
  }

  /** `/search` hits, best match first, with ranks. */
  rankedSearch(query: string, signal: AbortSignal): Promise<RankedCoin[]> {
    return this.search(query, signal);
  }

  async lookup(query: string, signal: AbortSignal): Promise<SymbolMatch[]> {
    const coins = await this.search(query, signal);
    return coins.map((c) => ({ symbol: c.symbol.toUpperCase(), name: c.name, asset_type: "crypto" as const, source: this.name }));
  }

  /** Resolve a symbol, name or id to a CoinGecko id. */
  async resolveId(symbolOrName: string, signal: AbortSignal): Promise<{ id: string; symbol: string; name?: string }> {
    const key = symbolOrName.trim();
    const upper = key.toUpperCase();
    const known = KNOWN_COIN_IDS[upper];
    if (known !== undefined) return { id: known, symbol: upper };
    const seen = this.ids.get(key.toLowerCase());
    if (seen !== undefined) return seen;
    const coins = await this.search(key, signal);
    const exact = coins.find(
      (c) => c.symbol.toLowerCase() === key.toLowerCase() || c.name.toLowerCase() === key.toLowerCase() || c.id === key.toLowerCase(),
    );
    if (exact === undefined) {
      throw new MarketProviderError(`coingecko knows no coin "${key}"`, { provider: this.name, code: "not_found", retryable: false });
    }
    return { id: exact.id, symbol: exact.symbol.toUpperCase(), name: exact.name };
  }

  async quote(symbol: string, opts: QuoteOptions, signal: AbortSignal): Promise<MarketQuote> {
    const pair = splitPair(symbol);
    const currency = (pair.quote ?? opts.currency).toUpperCase();
    const vs = currency.toLowerCase();
    const coin = await this.resolveId(pair.base, signal);

    const params = new URLSearchParams({
      ids: coin.id,
      vs_currencies: vs,
      include_market_cap: "true",
      include_24hr_vol: "true",
      include_24hr_change: "true",
      include_last_updated_at: "true",
    });
    const prices = await this.get("/api/v3/simple/price", params, PriceResponse, signal);
    const entry = prices[coin.id];
    const price = entry?.[vs];
    if (entry === undefined || price == null) {
      throw new MarketProviderError(`coingecko has no ${currency} price for "${coin.id}"`, {
        provider: this.name,
        code: entry === undefined ? "not_found" : "invalid_input",
        retryable: false,
      });
    }
    const pct = entry[`${vs}_24h_change`];
    const cap = entry[`${vs}_market_cap`];
    const vol = entry[`${vs}_24h_vol`];
    const updated = entry["last_updated_at"];
    const change = pct != null && pct > -100 ? round(price - price / (1 + pct / 100), 8) : undefined;

    const quote: MarketQuote = {
      requested: symbol,
      symbol: coin.symbol,
      ...(coin.name !== undefined && { name: coin.name }),
      asset_type: "crypto",
      currency,
      price,
      ...(change !== undefined && { change }),
      ...(pct != null && { change_pct: round(pct, 4) }),
      ...(vol != null && vol >= 0 && { volume: vol }),
      ...(cap != null && cap >= 0 && { market_cap: cap }),
      as_of: updated != null ? new Date(updated * 1000).toISOString() : new Date().toISOString(),
      source: this.name,
    };

    if (opts.history !== undefined) {
      const days = COINGECKO_DAYS[opts.history.range];
      const ohlc = await this.get(`/api/v3/coins/${encodeURIComponent(coin.id)}/ohlc`, new URLSearchParams({ vs_currency: vs, days }), OhlcResponse, signal);
      const bars: Bar[] = ohlc
        .filter((row): row is [number, number, number, number, number] => row.length >= 5)
        .map(([t, o, h, l, c]) => ({ t: new Date(t).toISOString(), o, h, l, c }))
        .sort((a, b) => a.t.localeCompare(b.t));
      quote.history = {
        range: opts.history.range,
        interval: nearestInterval(coingeckoBarMinutes(days)),
        bars: bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars,
      };
    }
    const checked = MarketQuoteSchema.safeParse(quote);
    if (!checked.success) {
      throw new MarketProviderError(`coingecko data for "${symbol}" did not fit the quote schema (${checked.error.issues[0]?.message ?? "invalid"})`, {
        provider: this.name,
        code: "provider",
        retryable: false,
      });
    }
    return checked.data;
  }
}
