import { z } from "zod";
import { CurrencyCodeSchema } from "./flights.js";

/**
 * Shared schemas for `market_quote`, PLAN.md section 14.2.
 * Owned by WP15, consumed by WP20.
 */

export const MARKET_SOURCES = ["yahoo", "finnhub", "coingecko", "google_finance"] as const;
export const MarketSourceSchema = z.enum(MARKET_SOURCES);
export type MarketSource = z.infer<typeof MarketSourceSchema>;

export const ASSET_TYPES = ["stock", "etf", "index", "crypto", "fund", "other"] as const;
export const AssetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const HISTORY_RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y", "max"] as const;
export const HISTORY_INTERVALS = ["1m", "5m", "15m", "1h", "1d", "1wk", "1mo"] as const;
export const HistoryRangeSchema = z.enum(HISTORY_RANGES);
export const HistoryIntervalSchema = z.enum(HISTORY_INTERVALS);
export type HistoryRange = z.infer<typeof HistoryRangeSchema>;
export type HistoryInterval = z.infer<typeof HistoryIntervalSchema>;

export const MARKET_STATES = ["pre", "regular", "post", "closed"] as const;

export const MAX_SYMBOLS = 10;
export const MAX_BARS = 1000;
/** A plausible ticker: letters, digits, `.`, `-`, `^`, `=`, no spaces, at most 12 characters. Anything else is a name to look up. */
export const TICKER_RE = /^[A-Za-z0-9.^=-]{1,12}$/;

/** Default interval per range when the caller gives none (PLAN.md 14.2: the coarsest sensible one). */
export const DEFAULT_INTERVAL: Readonly<Record<HistoryRange, HistoryInterval>> = {
  "1d": "5m",
  "5d": "15m",
  "1mo": "1d",
  "3mo": "1d",
  "6mo": "1d",
  "1y": "1wk",
  "5y": "1mo",
  max: "1mo",
};

export const HistoryRequestSchema = z.object({
  range: HistoryRangeSchema,
  interval: HistoryIntervalSchema.optional().describe("Defaults to the coarsest sensible interval for the range."),
});
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;

export const MarketQuoteInputSchema = z.object({
  symbols: z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(MAX_SYMBOLS)
    .describe(
      `1 to ${MAX_SYMBOLS} tickers ("AAPL", "VOD.L", "^GSPC", "BTC-USD") or names ("Apple", "bitcoin"). Names are looked up first.`,
    ),
  history: HistoryRequestSchema.optional().describe("Also return price history (OHLCV bars) for each quote."),
  sources: z.array(MarketSourceSchema).min(1).optional().describe("Defaults to every configured source."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter ISO 4217 code, for example USD" })
    .optional()
    .describe("Quote currency for crypto assets; defaults to WEBRUNNER_CURRENCY. Stocks are quoted in their listing currency."),
});
export type MarketQuoteInput = z.input<typeof MarketQuoteInputSchema>;

export const BarSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().nonnegative().optional(),
});
export type Bar = z.infer<typeof BarSchema>;

export const PriceHistorySchema = z.object({
  range: HistoryRangeSchema,
  interval: HistoryIntervalSchema,
  bars: z.array(BarSchema).max(MAX_BARS),
});
export type PriceHistory = z.infer<typeof PriceHistorySchema>;

export const MarketQuoteSchema = z.object({
  requested: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1).optional(),
  asset_type: AssetTypeSchema,
  exchange: z.string().min(1).optional(),
  currency: CurrencyCodeSchema,
  price: z.number(),
  previous_close: z.number().optional(),
  change: z.number().optional(),
  change_pct: z.number().optional(),
  open: z.number().optional(),
  day_high: z.number().optional(),
  day_low: z.number().optional(),
  volume: z.number().nonnegative().optional(),
  market_cap: z.number().nonnegative().optional(),
  week52_high: z.number().optional(),
  week52_low: z.number().optional(),
  market_state: z.enum(MARKET_STATES).optional(),
  as_of: z.string(),
  delayed_min: z.number().int().nonnegative().optional(),
  source: MarketSourceSchema,
  history: PriceHistorySchema.optional(),
});
export type MarketQuote = z.infer<typeof MarketQuoteSchema>;

/** One candidate from a provider's name lookup. */
export const SymbolMatchSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1).optional(),
  asset_type: AssetTypeSchema,
  exchange: z.string().min(1).optional(),
  source: MarketSourceSchema,
});
export type SymbolMatch = z.infer<typeof SymbolMatchSchema>;

export const MarketQuoteOutputSchema = z.object({
  quotes: z.array(MarketQuoteSchema).max(MAX_SYMBOLS),
  unresolved: z.array(z.object({ requested: z.string(), error: z.string() })),
  sources_used: z.array(MarketSourceSchema),
  sources_failed: z.array(z.object({ source: MarketSourceSchema, error: z.string() })),
  fetched_at: z.string(),
  caveats: z.array(z.string()),
});
export type MarketQuoteOutput = z.infer<typeof MarketQuoteOutputSchema>;
