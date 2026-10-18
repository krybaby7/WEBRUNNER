import type {
  AssetType,
  HistoryRequest,
  MarketQuote,
  MarketSource,
  SymbolMatch,
} from "../../schemas/markets.js";

export type { AssetType, HistoryRequest, MarketQuote, MarketSource, SymbolMatch };

export interface QuoteOptions {
  /** Also fetch price history. Providers without history ignore it; the tool then adds a caveat. */
  history?: HistoryRequest;
  /** Quote currency for crypto. Equity providers ignore it. */
  currency: string;
}

/**
 * A source of market data, PLAN.md 14.2 and 14.8. `quote` returns a value
 * validated by `MarketQuoteSchema` with `source: name` and `requested` left for
 * the tool to fill. Failures are `MarketProviderError`; `not_found` means the
 * symbol is unknown to this source (the tool tries the next one).
 */
export interface MarketProvider {
  readonly name: MarketSource;
  /** Asset classes this source can quote. */
  readonly assetTypes: readonly AssetType[];
  isConfigured(): boolean;
  /** Resolve a name or loose ticker to candidate symbols, best match first. Optional. */
  lookup?(query: string, signal: AbortSignal): Promise<SymbolMatch[]>;
  quote(symbol: string, opts: QuoteOptions, signal: AbortSignal): Promise<MarketQuote>;
}

export type MarketProviderErrorCode = "provider" | "timeout" | "config" | "blocked" | "not_found" | "invalid_input";

export interface MarketProviderErrorOptions {
  provider: MarketSource;
  code: MarketProviderErrorCode;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

/** Failure of a market provider. `not_found` becomes an `unresolved` entry; the other codes map onto the envelope. */
export class MarketProviderError extends Error {
  readonly provider: MarketSource;
  readonly code: MarketProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: MarketProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MarketProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}
