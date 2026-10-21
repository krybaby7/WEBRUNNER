import { errors as playwrightErrors, type Page } from "playwright";
import { z } from "zod";
import { MARKET_STATES } from "../../../schemas/markets.js";
import { detectBotWall } from "../../fetch/browser.js";
import { LlmError } from "../../llm/types.js";
import { RecipeError, type Recipe, type RecipeContext } from "./types.js";

/**
 * Google Finance quote recipe (PLAN.md 14.2, WP20). Quote only, no history.
 *
 * Personal use only: automated reading of Google Finance is against Google's
 * terms of service (PLAN.md 14.0). No stealth, no CAPTCHA solving: a bot wall
 * is reported as `blocked`.
 *
 * Verified live on 2026-10-18 from a headless Chromium in the development
 * environment (HTTP 200, no consent dialog, no CAPTCHA):
 *
 *   https://www.google.com/finance/quote/AAPL:NASDAQ?hl=en   title "Apple Inc (AAPL) Stock Price & News - Google Finance"
 *   https://www.google.com/finance/quote/VOD:LON?hl=en       title "Vodafone Group plc (VOD) Stock Price & News - Google Finance"
 *   https://www.google.com/finance/quote/AAPL?hl=en          (no exchange) title "Google Finance", body
 *       "Page Not Found / We couldn't find any match for your search." -> a symbol MUST carry its exchange.
 *   https://www.google.com/finance/quote/ZZZQQQ:NASDAQ?hl=en the same "Page Not Found" text.
 *   https://www.google.com/finance?q=VOD.L&hl=en             redirects to the home page: the site search is
 *       interactive only, so a bare symbol is resolved by trying exchanges (see `candidateListings`).
 *
 * Markup: the 2026 page carries none of the `data-last-price` / `data-currency-code` /
 * `data-exchange` attributes older scrapers used. The quote header is the
 * `c-wiz[data-show-intraday]` element whose `data-p` attribute embeds
 * `[null,["AAPL","NASDAQ"]]`, and whose visible text runs, one line each:
 *
 *   AAPL:NASDAQ
 *   check_indeterminate_small          (icon ligature)
 *   Add to list
 *   Apple Inc
 *   $343.46                            (VOD:LON printed "GBX 120.79": currency code before the number)
 *   arrow_upward                       (icon ligature)
 *   +0.43%
 *   (+1.46) Today
 *   Closed: Oct 16, 4:00:01 PM GMT-4  ·   USD      (VOD: "Oct 16, 5:00:13 PM GMT+1  ·   GBX", no prefix)
 *   $342.62 / arrow_downward / -0.24% / (-0.84) / After hours · 7:59 PM     (US stocks only)
 *
 * Elements: price `[jsname=Pdsbrc]`, percent `[jsname=vY9t3b]`, absolute change `[jsname=xnruHf]`
 * (obfuscated names, used only as hints). The key statistics block
 * (`[jsname=EZteOc]`) is a list of label/value pairs in the visible text:
 * "Open $346.08", "High $347.82", "Low $340.46", "Mkt. cap 5.01T", "Avg. vol. 40.30M",
 * "Volume 59.95M", "52-wk high $348.15", "52-wk low $243.42". No "delayed" note
 * appeared on either page (only a "Disclaimer" link), so `delayed_min` is set
 * only when the text says "delayed by N min" / "N min delay".
 *
 * The deterministic path parses those text lines; when the header is present
 * but no price can be read, the visible text goes to the LLM with
 * `LlmExtractionSchema` (schema-driven extraction, PLAN.md 4.5). Without an
 * LLM client the fallback fails with the client's own `config` error.
 */

export const GOOGLE_FINANCE_SITE = "google_finance";
export const GOOGLE_FINANCE_BASE_URL = "https://www.google.com/finance/quote";

export const GoogleFinanceParamsSchema = z.object({
  /** "AAPL", "AAPL:NASDAQ", "VOD.L", "^GSPC". */
  symbol: z.string().trim().min(1).max(32),
  /** Google exchange code, when known ("NASDAQ", "LON"). Overrides any suffix in `symbol`. */
  exchange: z.string().trim().min(1).max(20).optional(),
});
export type GoogleFinanceParams = z.infer<typeof GoogleFinanceParamsSchema>;

const MarketStateSchema = z.enum(MARKET_STATES);

export const GoogleFinanceQuoteSchema = z.object({
  symbol: z.string().min(1),
  exchange: z.string().min(1),
  name: z.string().min(1).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  price: z.number(),
  change: z.number().optional(),
  change_pct: z.number().optional(),
  previous_close: z.number().optional(),
  open: z.number().optional(),
  day_high: z.number().optional(),
  day_low: z.number().optional(),
  volume: z.number().nonnegative().optional(),
  market_cap: z.number().nonnegative().optional(),
  week52_high: z.number().optional(),
  week52_low: z.number().optional(),
  market_state: MarketStateSchema.optional(),
  /** ISO 8601 UTC when the page's timestamp could be read. */
  as_of: z.string().optional(),
  delayed_min: z.number().int().nonnegative().optional(),
  extracted_by: z.enum(["dom", "llm"]),
  /** The URL the quote was read from. */
  url: z.string(),
});
export type GoogleFinanceQuote = z.infer<typeof GoogleFinanceQuoteSchema>;

/** Thrown (code `provider`, not retryable) when no candidate listing has a quote page. */
export class GoogleFinanceNotFoundError extends RecipeError {
  constructor(message: string) {
    super("provider", message, { retryable: false });
    this.name = "GoogleFinanceNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Listings and URLs
// ---------------------------------------------------------------------------

export interface Listing {
  symbol: string;
  exchange: string;
  /** Currency to report when the page prints none (index pages quote points with no currency). */
  currency?: string;
}

/**
 * Yahoo-style exchange suffixes to Google Finance exchange codes. Verified live
 * (a quote page read deterministically): LON (VOD.L) and the suffix-less NASDAQ
 * case on 2026-10-18; ETR (SAP.DE), EPA (MC.PA), TYO (7203.T), TSE (RY.TO),
 * ASX (BHP.AX), HKG (0700.HK), NSE (RELIANCE.NS), AMS (ASML.AS), SWX
 * (NESN.SW), BME (ITX.MC), BIT (ENEL.MI), STO (VOLV-B.ST), CPH (NOVO-B.CO),
 * KRX (005930.KS), SHA (600519.SS), BVMF (PETR4.SA), SGX (D05.SI) and the
 * suffix-less NYSEARCA (SPY) and NYSE (BRK-B) cases on 2026-10-21. The rest
 * follow Google Finance's documented exchange list.
 */
export const SUFFIX_EXCHANGES: Readonly<Record<string, string>> = {
  L: "LON", PA: "EPA", DE: "ETR", F: "FRA", AS: "AMS", BR: "EBR", MI: "BIT", MC: "BME", SW: "SWX", VI: "VIE",
  ST: "STO", HE: "HEL", CO: "CPH", OL: "OSL", LS: "ELI", IR: "ISE", WA: "WSE", TO: "TSE", V: "CVE", AX: "ASX",
  NZ: "NZE", HK: "HKG", T: "TYO", SS: "SHA", SZ: "SHE", KS: "KRX", KQ: "KOSDAQ", NS: "NSE", BO: "BOM", TW: "TPE",
  SI: "SGX", JO: "JSE", SA: "BVMF", MX: "BMV", SR: "TADAWUL", TA: "TLV", IS: "IST", JK: "IDX", BK: "BKK", KL: "KLSE",
};

/**
 * Yahoo-style index tickers to Google Finance listings. Index pages print the
 * level with no currency sign and a status line with no currency
 * (".INX:INDEXSP" live on 2026-10-21: "7,763.96" and "Oct 21, 1:40:21 PM GMT-4"),
 * so each entry names the currency to report, the one Yahoo uses for the index.
 */
export const INDEX_LISTINGS: Readonly<Record<string, Listing>> = {
  "^GSPC": { symbol: ".INX", exchange: "INDEXSP", currency: "USD" },
  "^SPX": { symbol: ".INX", exchange: "INDEXSP", currency: "USD" },
  "^DJI": { symbol: ".DJI", exchange: "INDEXDJX", currency: "USD" },
  "^IXIC": { symbol: ".IXIC", exchange: "INDEXNASDAQ", currency: "USD" },
  "^NDX": { symbol: "NDX", exchange: "INDEXNASDAQ", currency: "USD" },
  "^RUT": { symbol: "RUT", exchange: "INDEXRUSSELL", currency: "USD" },
  "^VIX": { symbol: "VIX", exchange: "INDEXCBOE", currency: "USD" },
  "^FTSE": { symbol: "UKX", exchange: "INDEXFTSE", currency: "GBP" },
  "^GDAXI": { symbol: "DAX", exchange: "INDEXDB", currency: "EUR" },
  "^FCHI": { symbol: "PX1", exchange: "INDEXEURO", currency: "EUR" },
  "^STOXX50E": { symbol: "SX5E", exchange: "INDEXSTOXX", currency: "EUR" },
  "^N225": { symbol: "NI225", exchange: "INDEXNIKKEI", currency: "JPY" },
  "^HSI": { symbol: "HSI", exchange: "INDEXHANGSENG", currency: "HKD" },
  "^AXJO": { symbol: "XJO", exchange: "INDEXASX", currency: "AUD" },
  "^GSPTSE": { symbol: "OSPTX", exchange: "INDEXTSI", currency: "CAD" },
};


/** US exchanges tried, in order, for a ticker with no exchange and no suffix. */
export const DEFAULT_US_EXCHANGES = ["NASDAQ", "NYSE", "NYSEARCA"] as const;

/**
 * Yahoo writes share classes with a hyphen ("BRK-B", "BT-A.L", "VOLV-B.ST").
 * Google Finance uses a dot on US exchanges and in London ("BRK.B:NYSE",
 * "BF.B:NYSE", "BT.A:LON") but keeps the hyphen in Stockholm and Copenhagen
 * ("VOLV-B:STO", "NOVO-B:CPH"); all checked live on 2026-10-21.
 */
const DOT_CLASS_EXCHANGES: ReadonlySet<string> = new Set<string>(["LON", ...DEFAULT_US_EXCHANGES]);

function googleShareClass(symbol: string, exchange: string): string {
  return DOT_CLASS_EXCHANGES.has(exchange) ? symbol.replace(/^([A-Z]{1,6})-([A-Z])$/, "$1.$2") : symbol;
}

/** Google Finance listings to try for an input, best guess first. */
export function candidateListings(params: GoogleFinanceParams): Listing[] {
  const raw = params.symbol.trim().toUpperCase();
  if (params.exchange !== undefined) return [{ symbol: raw.replace(/:[A-Z0-9.]+$/, ""), exchange: params.exchange.trim().toUpperCase() }];
  const colon = /^([A-Z0-9.^-]+):([A-Z0-9.]+)$/.exec(raw);
  if (colon !== null) return [{ symbol: colon[1] as string, exchange: colon[2] as string }];
  const index = INDEX_LISTINGS[raw];
  if (index !== undefined) return [index];
  const suffix = /^([A-Z0-9-]+)\.([A-Z]{1,2})$/.exec(raw);
  if (suffix !== null) {
    const exchange = SUFFIX_EXCHANGES[suffix[2] as string];
    if (exchange !== undefined) return [{ symbol: googleShareClass(suffix[1] as string, exchange), exchange }];
  }
  return DEFAULT_US_EXCHANGES.map((exchange) => ({ symbol: googleShareClass(raw, exchange), exchange }));
}

export function buildGoogleFinanceUrl(listing: Listing, baseUrl: string = GOOGLE_FINANCE_BASE_URL): string {
  return `${baseUrl}/${encodeURIComponent(listing.symbol)}:${encodeURIComponent(listing.exchange)}?hl=en`;
}

// ---------------------------------------------------------------------------
// Text parsing (pure, unit-tested without a browser)
// ---------------------------------------------------------------------------

const CURRENCY_SIGNS: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₪": "ILS", "₺": "TRY", "₽": "RUB", R$: "BRL", "C$": "CAD", "A$": "AUD", HK$: "HKD", "S$": "SGD", "NT$": "TWD", "₫": "VND", "₱": "PHP", "₦": "NGN", zł: "PLN", Fr: "CHF", kr: "SEK" };

/** Normalise the odd spaces Google emits (narrow no-break, no-break) and trim. */
export function cleanLine(s: string): string {
  return s.replace(/[\u00a0\u202f\u2009]/g, " ").replace(/\s+/g, " ").trim();
}

/** "$343.46", "GBX 120.79", "€12.30", "1,082.08", "R$ 12.50" -> amount and (when printed) currency. */
export function parseMoney(text: string): { amount: number; currency?: string } | undefined {
  const t = cleanLine(text);
  let m = /^([A-Z]{3}) ?(-?\d[\d,]*(?:\.\d+)?)$/.exec(t);
  if (m !== null) return { amount: Number((m[2] as string).replaceAll(",", "")), currency: m[1] as string };
  m = /^([^\d\s-]{1,3}) ?(-?\d[\d,]*(?:\.\d+)?)$/.exec(t);
  // Only a known sign or a currency symbol counts: an index name such as "S&P 500" is not "500 in S&P" (live 2026-10-21).
  if (m !== null && (CURRENCY_SIGNS[m[1] as string] !== undefined || /\p{Sc}/u.test(m[1] as string))) {
    const currency = CURRENCY_SIGNS[m[1] as string];
    return { amount: Number((m[2] as string).replaceAll(",", "")), ...(currency !== undefined && { currency }) };
  }
  m = /^(-?\d[\d,]*(?:\.\d+)?)$/.exec(t);
  if (m !== null) return { amount: Number((m[1] as string).replaceAll(",", "")) };
  return undefined;
}

/** "5.01T", "40.30M", "166K", "59,950,000", "$1.2B" -> a number. */
export function parseCompact(text: string): number | undefined {
  const m = /^(?:[A-Z]{3} |[^\d\s-]{1,3} ?)?(-?\d[\d,]*(?:\.\d+)?)\s*([KMBT])?$/i.exec(cleanLine(text));
  if (m === null) return undefined;
  const n = Number((m[1] as string).replaceAll(",", ""));
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] ?? "").toUpperCase()] ?? 1;
  return n * mult;
}

const MONTHS: Readonly<Record<string, number>> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/**
 * "Oct 16, 4:00:01 PM GMT-4" (optionally "Oct 16, 2025, 4:00 PM GMT+1") to ISO 8601 UTC.
 * A date with no year gets the year that puts it at most a day into the future relative to `nowMs`.
 */
export function parseAsOf(text: string, nowMs: number = Date.now()): string | undefined {
  const m = /^([A-Za-z]{3,4})\.? (\d{1,2})(?:, (\d{4}))?,? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)(?: (?:GMT|UTC)([+-]\d{1,2})(?::?(\d{2}))?)?$/i.exec(cleanLine(text));
  if (m === null) return undefined;
  const month = MONTHS[(m[1] as string).toLowerCase()];
  if (month === undefined) return undefined;
  const day = Number(m[2]);
  let hour = Number(m[4]) % 12;
  if ((m[7] as string).toUpperCase() === "PM") hour += 12;
  const minute = Number(m[5]);
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  const offsetMin = m[8] !== undefined ? Number(m[8]) * 60 + (Number(m[8]) < 0 ? -1 : 1) * Number(m[9] ?? 0) : 0;
  const build = (year: number): number => Date.UTC(year, month, day, hour, minute, second) - offsetMin * 60_000;
  const year = m[3] !== undefined ? Number(m[3]) : new Date(nowMs).getUTCFullYear();
  let at = build(year);
  if (m[3] === undefined && at > nowMs + 24 * 3600_000) at = build(year - 1);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

export interface StatusLine {
  market_state?: z.infer<typeof MarketStateSchema>;
  currency?: string;
  as_of_text?: string;
}

/**
 * "Closed: Oct 16, 4:00:01 PM GMT-4 · USD", "Oct 16, 5:00:13 PM GMT+1 · GBX", "Open: ...", "Pre-market: ...".
 * Index pages print the time alone ("Oct 21, 1:40:21 PM GMT-4"): accepted when the
 * text after an optional state prefix is a timestamp, with no currency.
 */
export function parseStatusLine(text: string): StatusLine | undefined {
  const t = cleanLine(text);
  const parts = t.split(/\s*·\s*/);
  let currency: string | undefined;
  if (parts.length >= 2) {
    currency = (parts[parts.length - 1] as string).trim();
    if (!/^[A-Z]{3}$/.test(currency)) return undefined;
  }
  let head = (parts[0] as string).trim();
  let state: StatusLine["market_state"];
  const prefix = /^(Closed|Market closed|Open|Market open|Pre-market|After hours|Post-market):?\s*/i.exec(head);
  if (prefix !== null) {
    const p = (prefix[1] as string).toLowerCase();
    state = p.includes("closed") ? "closed" : p.includes("pre") ? "pre" : p.includes("after") || p.includes("post") ? "post" : "regular";
    head = head.slice(prefix[0].length);
  }
  if (currency === undefined && (parts.length !== 1 || parseAsOf(head) === undefined)) return undefined;
  return { ...(state !== undefined && { market_state: state }), ...(currency !== undefined && { currency }), ...(head !== "" && { as_of_text: head }) };
}

const SYMBOL_LINE_RE = /^([A-Z0-9.^-]{1,15}):([A-Z0-9.]{2,15})$/;
const PCT_RE = /^([+-]\d[\d,]*(?:\.\d+)?)%$/;
const ABS_RE = /^\(([+-]\d[\d,]*(?:\.\d+)?)\)(?: Today)?$/;
/** Material icon ligatures Google renders as text ("arrow_upward", "check_indeterminate_small"); with styles gone they glue onto neighbouring text. */
const ICON_RE = /(?<![A-Za-z0-9])[a-z]+(?:_[a-z0-9]+)+/g;
const SKIP_LINES = new Set(["add to list", "remove from list", "follow", "following", "share", "compare"]);
type StatField = "previous_close" | "open" | "day_high" | "day_low" | "volume" | "market_cap" | "week52_high" | "week52_low";
const STAT_LABELS: ReadonlyArray<readonly [RegExp, StatField, "money" | "compact"]> = [
  [/^previous close$/i, "previous_close", "money"],
  [/^open$/i, "open", "money"],
  [/^high$/i, "day_high", "money"],
  [/^low$/i, "day_low", "money"],
  [/^volume$/i, "volume", "compact"],
  [/^mkt\.? cap$/i, "market_cap", "compact"],
  [/^market cap$/i, "market_cap", "compact"],
  [/^52-wk high$/i, "week52_high", "money"],
  [/^52-wk low$/i, "week52_low", "money"],
];

export interface ParsedHeader {
  symbol: string;
  exchange: string;
  name?: string;
  currency?: string;
  price?: number;
  change?: number;
  change_pct?: number;
  market_state?: z.infer<typeof MarketStateSchema>;
  as_of?: string;
  delayed_min?: number;
  stats: Partial<Record<StatField, number>>;
}

/**
 * Read the quote header from visible-text lines (the quote `c-wiz`, or the
 * whole body). Returns undefined when no `SYMBOL:EXCHANGE` line exists.
 */
export function parseQuoteText(rawLines: readonly string[], nowMs: number = Date.now()): ParsedHeader | undefined {
  const lines = rawLines.map((l) => cleanLine(cleanLine(l).replace(ICON_RE, " "))).filter((l) => l !== "");
  const symIdx = lines.findIndex((l) => SYMBOL_LINE_RE.test(l));
  if (symIdx < 0) return undefined;
  const sym = SYMBOL_LINE_RE.exec(lines[symIdx] as string) as RegExpExecArray;
  const out: ParsedHeader = { symbol: sym[1] as string, exchange: sym[2] as string, stats: {} };

  const isNoise = (l: string): boolean => SKIP_LINES.has(l.toLowerCase());
  let i = symIdx + 1;
  // Name: the first plain line after the symbol that is not an icon, an action, a money amount or a percentage.
  for (; i < lines.length; i++) {
    const l = lines[i] as string;
    if (isNoise(l)) continue;
    if (parseMoney(l) !== undefined || PCT_RE.test(l) || ABS_RE.test(l)) break;
    out.name = l;
    i++;
    break;
  }
  // Price, percent, absolute change and the status line, in order; stop at the status line or after 12 lines.
  for (let n = 0; i < lines.length && n < 12; i++, n++) {
    const l = lines[i] as string;
    if (isNoise(l)) continue;
    if (out.price === undefined) {
      const money = parseMoney(l);
      if (money !== undefined) {
        out.price = money.amount;
        if (money.currency !== undefined) out.currency = money.currency;
        continue;
      }
    }
    const pct = PCT_RE.exec(l);
    if (pct !== null && out.change_pct === undefined) {
      out.change_pct = Number((pct[1] as string).replaceAll(",", ""));
      continue;
    }
    const abs = ABS_RE.exec(l);
    if (abs !== null && out.change === undefined) {
      out.change = Number((abs[1] as string).replaceAll(",", ""));
      continue;
    }
    const status = parseStatusLine(l);
    if (status !== undefined) {
      if (status.market_state !== undefined) out.market_state = status.market_state;
      if (status.currency !== undefined) out.currency = status.currency;
      if (status.as_of_text !== undefined) {
        const iso = parseAsOf(status.as_of_text, nowMs);
        if (iso !== undefined) out.as_of = iso;
      }
      i++;
      break;
    }
  }
  // Key statistics: a label line followed by its value, anywhere after the header.
  for (let j = i; j < lines.length - 1; j++) {
    const label = lines[j] as string;
    const spec = STAT_LABELS.find(([re]) => re.test(label));
    if (spec === undefined) continue;
    const [, field, kind] = spec;
    if (out.stats[field] !== undefined) continue;
    const value = lines[j + 1] as string;
    const n = kind === "money" ? parseMoney(value)?.amount : parseCompact(value);
    if (n !== undefined && Number.isFinite(n)) out.stats[field] = n;
  }
  const delay = /delayed(?: by)? (\d{1,3}) ?min|(\d{1,3}) ?min(?:ute)?s? delay/i.exec(lines.join(" "));
  if (delay !== null) out.delayed_min = Number(delay[1] ?? delay[2]);
  return out;
}

/** Assemble the recipe result from a parsed header; undefined when the price or currency is missing. */
export function toQuote(h: ParsedHeader, url: string, extractedBy: "dom" | "llm"): GoogleFinanceQuote | undefined {
  if (h.price === undefined || h.currency === undefined) return undefined;
  const previous = h.stats.previous_close ?? (h.change !== undefined ? Math.round((h.price - h.change) * 1e6) / 1e6 : undefined);
  const quote: GoogleFinanceQuote = {
    symbol: h.symbol,
    exchange: h.exchange,
    ...(h.name !== undefined && { name: h.name }),
    currency: h.currency,
    price: h.price,
    ...(h.change !== undefined && { change: h.change }),
    ...(h.change_pct !== undefined && { change_pct: h.change_pct }),
    ...(previous !== undefined && { previous_close: previous }),
    ...(h.stats.open !== undefined && { open: h.stats.open }),
    ...(h.stats.day_high !== undefined && { day_high: h.stats.day_high }),
    ...(h.stats.day_low !== undefined && { day_low: h.stats.day_low }),
    ...(h.stats.volume !== undefined && { volume: h.stats.volume }),
    ...(h.stats.market_cap !== undefined && { market_cap: h.stats.market_cap }),
    ...(h.stats.week52_high !== undefined && { week52_high: h.stats.week52_high }),
    ...(h.stats.week52_low !== undefined && { week52_low: h.stats.week52_low }),
    ...(h.market_state !== undefined && { market_state: h.market_state }),
    ...(h.as_of !== undefined && { as_of: h.as_of }),
    ...(h.delayed_min !== undefined && { delayed_min: h.delayed_min }),
    extracted_by: extractedBy,
    url,
  };
  const checked = GoogleFinanceQuoteSchema.safeParse(quote);
  return checked.success ? checked.data : undefined;
}

// ---------------------------------------------------------------------------
// LLM fallback schema
// ---------------------------------------------------------------------------

/** What the model fills in from the page text. Nulls mean "not stated". */
export const LlmExtractionSchema = z.object({
  symbol: z.string().nullable().describe("Ticker as printed before the colon in SYMBOL:EXCHANGE"),
  exchange: z.string().nullable().describe("Exchange code as printed after the colon"),
  name: z.string().nullable(),
  currency: z.string().nullable().describe("ISO 4217 code printed on the page (USD, GBX, EUR); null if not stated"),
  price: z.number().nullable().describe("The main quoted price, as a number"),
  change: z.number().nullable().describe("Absolute change for the day, e.g. 1.46 from '(+1.46) Today'"),
  change_pct: z.number().nullable().describe("Percent change for the day, e.g. 0.43 from '+0.43%'"),
  previous_close: z.number().nullable(),
  open: z.number().nullable(),
  day_high: z.number().nullable(),
  day_low: z.number().nullable(),
  volume: z.number().nullable().describe("Expanded number: 59.95M is 59950000"),
  market_cap: z.number().nullable().describe("Expanded number: 5.01T is 5010000000000"),
  week52_high: z.number().nullable(),
  week52_low: z.number().nullable(),
  market_state: MarketStateSchema.nullable(),
  delayed_min: z.number().nullable().describe("Only when the page says quotes are delayed by N minutes"),
});

const SYSTEM_PROMPT = [
  "You read the visible text of a Google Finance quote page and return the quote as structured data.",
  "The page text is the only source of truth: never use outside knowledge for prices or numbers.",
  "Rules: the main price is the first amount after the company name; '+0.43%' is change_pct 0.43; '(+1.46) Today' is change 1.46;",
  "the line ending in '· USD' names the currency; 'Closed:' means market_state closed, 'Pre-market' pre, 'After hours' post, otherwise regular when the page says Open.",
  "Expand compact numbers (5.01T, 59.95M, 166K). Use null for anything the text does not state.",
].join("\n");

// ---------------------------------------------------------------------------
// In-page probe (a string: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

const PROBE_JS = `(() => {
  const body = document.body ? (document.body.innerText || "") : "";
  const header = document.querySelector("c-wiz[data-show-intraday]");
  const headerText = header ? (header.innerText || "") : "";
  return {
    url: location.href,
    title: document.title || "",
    text: body.slice(0, 8000),
    textLength: body.length,
    headerLines: headerText.split("\\n"),
    bodyLines: body.slice(0, 20000).split("\\n"),
    recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha'),
    notFound: /Page Not Found|couldn.t find any match/i.test(body.slice(0, 3000)),
  };
})()`;

interface Probe {
  url: string;
  title: string;
  text: string;
  textLength: number;
  headerLines: string[];
  bodyLines: string[];
  recaptcha: boolean;
  notFound: boolean;
}

const REJECT_RE = /^\s*(reject all|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto|alles afwijzen|odrzuć wszystko|recusar tudo|rejeitar tudo|avvisa alla|afvis alle|hylkää kaikki)\s*$/i;
const ACCEPT_RE = /^\s*(accept all|alle akzeptieren|tout accepter|aceptar todo|accetta tutto|alles accepteren|zaakceptuj wszystko|aceitar tudo|godkänn alla|i agree)\s*$/i;

function blockedReason(probe: Probe): string | undefined {
  if (/\/sorry\//.test(probe.url)) return "sorry/index";
  if (probe.recaptcha) return "recaptcha";
  if (/unusual traffic/i.test(probe.text)) return "unusual traffic";
  return detectBotWall({ title: probe.title, text: probe.text, textLength: probe.textLength });
}

async function dismissConsent(page: Page): Promise<boolean> {
  for (const re of [REJECT_RE, ACCEPT_RE]) {
    for (const frame of page.frames()) {
      try {
        const button = frame.getByRole("button", { name: re }).first();
        if ((await button.count()) === 0) continue;
        await button.click({ timeout: 3000 });
        return true;
      } catch {
        // Not clickable: try the next candidate.
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export interface GoogleFinanceRecipeOptions {
  /** Quote page base. Tests point it at a local fixture server. Default https://www.google.com/finance/quote. */
  baseUrl?: string;
  /** Longest wait for the quote header per listing, in ms (also capped by the deadline). Default 8000. */
  maxWaitMs?: number;
  /** Poll interval while waiting. Default 250. */
  pollMs?: number;
  /** Clock for `as_of` year inference. Default Date.now. */
  now?: () => number;
}

export function createGoogleFinanceRecipe(options: GoogleFinanceRecipeOptions = {}): Recipe<GoogleFinanceParams, GoogleFinanceQuote> {
  const baseUrl = (options.baseUrl ?? GOOGLE_FINANCE_BASE_URL).replace(/\/+$/, "");
  const maxWaitMs = options.maxWaitMs ?? 8000;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;

  const buildUrl = (params: GoogleFinanceParams): string | null => {
    const first = candidateListings(params)[0];
    return first === undefined ? null : buildGoogleFinanceUrl(first, baseUrl);
  };

  async function run(page: Page, params: GoogleFinanceParams, ctx: RecipeContext): Promise<GoogleFinanceQuote> {
    const parsedParams = GoogleFinanceParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new RecipeError("invalid_input", `invalid Google Finance query: ${parsedParams.error.issues.map((i) => i.message).join("; ")}`);
    }
    const p = parsedParams.data;
    const caveat = (msg: string): void => {
      if (ctx.caveats !== undefined && !ctx.caveats.includes(msg)) ctx.caveats.push(msg);
    };
    const remaining = (): number => ctx.deadline - Date.now();
    const checkTime = (what: string): void => {
      if (ctx.signal?.aborted === true) throw new RecipeError("timeout", `Google Finance quote aborted ${what}`);
      if (remaining() <= 0) throw new RecipeError("timeout", `Google Finance quote ran out of time ${what}`);
    };

    const listings = candidateListings(p);
    const tried: string[] = [];
    try {
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      for (const [index, listing] of listings.entries()) {
        checkTime("before navigating");
        // Do not start another listing when it cannot finish in time.
        if (index > 0 && remaining() < 3000) break;
        const url = buildGoogleFinanceUrl(listing, baseUrl);
        tried.push(`${listing.symbol}:${listing.exchange}`);
        await navigate(page, url, ctx, checkTime);
        const outcome = await waitForQuote(page, ctx, { maxWaitMs, pollMs, caveat, checkTime, now, ...(listing.currency !== undefined && { fallbackCurrency: listing.currency }) });
        if (outcome.kind === "not_found") continue;
        if (outcome.kind === "quote") return outcome.quote;
        // Header present but unreadable: schema-driven LLM extraction over the visible text.
        const quote = await extractWithLlm(outcome.probe, ctx, listing);
        caveat("The Google Finance quote was read by the LLM from the page text because the deterministic parser could not read it.");
        return quote;
      }
    } catch (err) {
      throw toRecipeError(err, ctx);
    }
    throw new GoogleFinanceNotFoundError(`Google Finance has no quote page for ${tried.join(", ")}`);
  }

  async function navigate(page: Page, url: string, ctx: RecipeContext, checkTime: (w: string) => void): Promise<void> {
    checkTime("while loading the page");
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1000, Math.min(ctx.deadline - Date.now(), 20_000)),
    });
    const status = response?.status();
    if (status === 429 || status === 403) {
      throw new RecipeError("blocked", `Google Finance answered HTTP ${status}; it is blocking this browser or network`);
    }
    if (status !== undefined && status >= 500) {
      throw new RecipeError("provider", `Google Finance answered HTTP ${status}`, { retryable: true });
    }
  }

  type Outcome = { kind: "quote"; quote: GoogleFinanceQuote } | { kind: "not_found" } | { kind: "unreadable"; probe: Probe };

  async function waitForQuote(
    page: Page,
    ctx: RecipeContext,
    o: { maxWaitMs: number; pollMs: number; caveat: (m: string) => void; checkTime: (w: string) => void; now: () => number; fallbackCurrency?: string },
  ): Promise<Outcome> {
    const start = Date.now();
    const until = start + Math.max(500, Math.min(o.maxWaitMs, ctx.deadline - start - 500));
    let consentHandled = false;
    let headerSeenAt: number | undefined;
    for (;;) {
      o.checkTime("while waiting for the quote");
      let probe: Probe | undefined;
      try {
        probe = await page.evaluate<Probe>(PROBE_JS);
      } catch {
        // A navigation (consent redirect) destroyed the execution context; probe again.
      }
      if (probe !== undefined) {
        const wall = blockedReason(probe);
        if (wall !== undefined) {
          throw new RecipeError("blocked", `Google Finance served a bot check (${wall}) at ${probe.url}; no quote was returned`, { retryable: false });
        }
        const header = parseQuoteText(probe.headerLines.length > 1 ? probe.headerLines : probe.bodyLines, o.now());
        if (header !== undefined) {
          const withStats = header.stats.open === undefined ? parseQuoteText(probe.bodyLines, o.now()) : undefined;
          const merged: ParsedHeader = withStats !== undefined ? { ...header, stats: { ...withStats.stats, ...header.stats } } : { ...header };
          if (merged.currency === undefined && o.fallbackCurrency !== undefined) merged.currency = o.fallbackCurrency;
          const quote = toQuote(merged, probe.url, "dom");
          if (quote !== undefined) return { kind: "quote", quote };
          headerSeenAt ??= Date.now();
          // Give the price a moment to render before falling back to the model.
          if (Date.now() - headerSeenAt > 2000) return { kind: "unreadable", probe };
        } else if (probe.notFound) {
          return { kind: "not_found" };
        }
      }
      if (!consentHandled && (await dismissConsent(page))) {
        consentHandled = true;
        o.caveat("A cookie consent dialog was shown and dismissed (reject preferred) before reading the quote.");
        continue;
      }
      if (Date.now() >= until) {
        if (probe !== undefined && probe.textLength > 200) return { kind: "unreadable", probe };
        throw new RecipeError("timeout", `no Google Finance quote appeared within ${Math.round((until - start) / 1000)}s (page: ${probe?.title ?? "unknown"})`);
      }
      await sleep(o.pollMs);
    }
  }

  async function extractWithLlm(probe: Probe, ctx: RecipeContext, listing: Listing): Promise<GoogleFinanceQuote> {
    const remainingMs = Math.max(1000, ctx.deadline - Date.now());
    const timeoutSignal = AbortSignal.timeout(remainingMs);
    const signal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    const content = [
      `Requested listing: ${listing.symbol}:${listing.exchange}`,
      `Page: ${probe.url}`,
      `Title: ${probe.title}`,
      "",
      "Visible page text:",
      probe.text.slice(0, 6000),
    ].join("\n");
    const response = await ctx.llm.complete({
      role: "extractor",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      schema: LlmExtractionSchema,
      effort: "low",
      maxTokens: 2000,
      ...(ctx.meter !== undefined && { meter: ctx.meter }),
      signal,
    });
    const parsed = LlmExtractionSchema.safeParse(response.parsed);
    if (!parsed.success) throw new RecipeError("provider", "the extractor did not return the expected structure", { retryable: true });
    const x = parsed.data;
    if (x.price === null) throw new RecipeError("provider", `Google Finance page for ${listing.symbol}:${listing.exchange} shows no readable price`, { retryable: false });
    const header: ParsedHeader = {
      symbol: x.symbol ?? listing.symbol,
      exchange: x.exchange ?? listing.exchange,
      ...(x.name !== null && { name: x.name }),
      currency: (x.currency ?? listing.currency ?? "").toUpperCase(),
      price: x.price,
      ...(x.change !== null && { change: x.change }),
      ...(x.change_pct !== null && { change_pct: x.change_pct }),
      ...(x.market_state !== null && { market_state: x.market_state }),
      ...(x.delayed_min !== null && { delayed_min: Math.max(0, Math.round(x.delayed_min)) }),
      stats: {
        ...(x.previous_close !== null && { previous_close: x.previous_close }),
        ...(x.open !== null && { open: x.open }),
        ...(x.day_high !== null && { day_high: x.day_high }),
        ...(x.day_low !== null && { day_low: x.day_low }),
        ...(x.volume !== null && x.volume >= 0 && { volume: x.volume }),
        ...(x.market_cap !== null && x.market_cap >= 0 && { market_cap: x.market_cap }),
        ...(x.week52_high !== null && { week52_high: x.week52_high }),
        ...(x.week52_low !== null && { week52_low: x.week52_low }),
      },
    };
    const quote = toQuote(header, probe.url, "llm");
    if (quote === undefined) {
      throw new RecipeError("provider", `the extractor returned a quote without a valid currency for ${listing.symbol}:${listing.exchange}`, { retryable: false });
    }
    return quote;
  }

  return {
    site: GOOGLE_FINANCE_SITE,
    paramsSchema: GoogleFinanceParamsSchema,
    resultSchema: GoogleFinanceQuoteSchema,
    buildUrl,
    run,
  };
}

function toRecipeError(err: unknown, ctx: RecipeContext): unknown {
  if (err instanceof RecipeError) return err;
  if (err instanceof LlmError) return err;
  const aborted = ctx.signal?.aborted === true;
  if (err instanceof playwrightErrors.TimeoutError || aborted) {
    return new RecipeError("timeout", `Google Finance quote timed out: ${errMsg(err)}`, { cause: err });
  }
  if (ctx.deadline - Date.now() <= 0 && /closed|Target/.test(errMsg(err))) {
    return new RecipeError("timeout", "Google Finance quote ran out of time", { cause: err });
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(errMsg(err))?.[1];
  if (net !== undefined) {
    return new RecipeError("provider", `navigation to Google Finance failed: ${net}`, { cause: err, retryable: true });
  }
  return new RecipeError("provider", `Google Finance recipe failed: ${errMsg(err)}`, { cause: err, retryable: false });
}

/** The recipe against live Google Finance. */
export const googleFinanceRecipe: Recipe<GoogleFinanceParams, GoogleFinanceQuote> = createGoogleFinanceRecipe();
