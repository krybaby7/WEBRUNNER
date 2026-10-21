import { z } from "zod";
import { MarketQuoteSchema, type AssetType, type MarketQuote, type SymbolMatch } from "../../../schemas/markets.js";
import { hasKey, isoFromEpochSeconds, parseMarketBody, redactSecrets, requestMarketJson, stripTrailingSlash } from "../http.js";
import { MarketProviderError, type MarketProvider, type QuoteOptions } from "../types.js";

/**
 * Finnhub (needs FINNHUB_API_KEY), PLAN.md 14.2. Free tier: US equities, no history.
 *   https://finnhub.io/api/v1/quote?symbol=<SYM>&token=<key>   -> { c, d, dp, h, l, o, pc, t }
 *     (c current, d change, dp change %, h/l/o day high/low/open, pc previous close, t epoch seconds;
 *      an unknown symbol answers with every field 0, which is mapped to `not_found`)
 *   https://finnhub.io/api/v1/search?q=<q>&token=<key>          -> { result: [{ symbol, description, type }] }
 * Docs: https://finnhub.io/docs/api/quote, https://finnhub.io/docs/api/symbol-search.
 * UNVERIFIED live: no key in the development environment; fixtures follow the docs.
 * The token travels in the query string, so every error message is passed through `redactSecrets`.
 */

export const FINNHUB_BASE_URL = "https://finnhub.io";

export interface FinnhubProviderOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const QuoteResponse = z.object({
  c: z.number().nullable(),
  d: z.number().nullable().optional(),
  dp: z.number().nullable().optional(),
  h: z.number().nullable().optional(),
  l: z.number().nullable().optional(),
  o: z.number().nullable().optional(),
  pc: z.number().nullable().optional(),
  t: z.number().nullable().optional(),
});
const SearchResponse = z.object({
  result: z.array(z.object({ symbol: z.string(), description: z.string().nullish(), type: z.string().nullish() })).optional(),
});

/** Finnhub security types to the shared asset type. */
export function finnhubAssetType(type: string | null | undefined): AssetType {
  const t = (type ?? "").toLowerCase();
  if (t === "" || t.includes("stock") || t === "adr" || t === "reit" || t === "gdr") return "stock";
  if (t === "etp" || t === "etf" || t === "etn") return "etf";
  if (t.includes("index")) return "index";
  if (t.includes("fund")) return "fund";
  if (t.includes("crypto")) return "crypto";
  return "other";
}

export class FinnhubProvider implements MarketProvider {
  readonly name = "finnhub" as const;
  readonly assetTypes = ["stock", "etf"] as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: FinnhubProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? FINNHUB_BASE_URL);
  }

  isConfigured(): boolean {
    return hasKey(this.apiKey);
  }

  private token(): string {
    if (!hasKey(this.apiKey)) {
      throw new MarketProviderError("finnhub is not configured: set FINNHUB_API_KEY", { provider: this.name, code: "config", retryable: false });
    }
    return (this.apiKey as string).trim();
  }

  /** Run a request and make sure the key never leaks through an error message. */
  private async get(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    const token = this.token();
    params.set("token", token);
    try {
      const { body } = await requestMarketJson({
        provider: this.name,
        url: `${this.baseUrl}${path}?${params.toString()}`,
        fetchImpl: this.fetchImpl,
        signal,
      });
      return body;
    } catch (err) {
      if (err instanceof MarketProviderError && err.message.includes(token)) {
        throw new MarketProviderError(redactSecrets(err.message, [token]), {
          provider: err.provider,
          code: err.code,
          retryable: err.retryable,
          ...(err.status !== undefined && { status: err.status }),
          cause: err,
        });
      }
      throw err;
    }
  }

  async lookup(query: string, signal: AbortSignal): Promise<SymbolMatch[]> {
    const body = await this.get("/api/v1/search", new URLSearchParams({ q: query }), signal);
    const parsed = parseMarketBody(this.name, SearchResponse, body);
    return (parsed.result ?? []).map((r) => ({
      symbol: r.symbol,
      ...(r.description != null && r.description !== "" && { name: r.description }),
      asset_type: finnhubAssetType(r.type),
      source: this.name,
    }));
  }

  async quote(symbol: string, _opts: QuoteOptions, signal: AbortSignal): Promise<MarketQuote> {
    const body = await this.get("/api/v1/quote", new URLSearchParams({ symbol }), signal);
    const q = parseMarketBody(this.name, QuoteResponse, body);
    if (q.c === null || (q.c === 0 && (q.t ?? 0) === 0)) {
      throw new MarketProviderError(`finnhub knows no symbol "${symbol}"`, { provider: this.name, code: "not_found", retryable: false });
    }
    const quote: MarketQuote = {
      requested: symbol,
      symbol: symbol.toUpperCase(),
      asset_type: "stock",
      currency: "USD",
      price: q.c,
      ...(q.pc != null && { previous_close: q.pc }),
      ...(q.d != null && { change: q.d }),
      ...(q.dp != null && { change_pct: q.dp }),
      ...(q.o != null && { open: q.o }),
      ...(q.h != null && { day_high: q.h }),
      ...(q.l != null && { day_low: q.l }),
      as_of: isoFromEpochSeconds(q.t ?? 0),
      source: this.name,
    };
    const checked = MarketQuoteSchema.safeParse(quote);
    if (!checked.success) {
      throw new MarketProviderError(`finnhub data for "${symbol}" did not fit the quote schema`, { provider: this.name, code: "provider", retryable: false });
    }
    return checked.data;
  }
}
