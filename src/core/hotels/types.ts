import type { HotelResult, HotelSource, NormalizedHotelsQuery } from "../../schemas/hotels.js";
import type { CostMeter } from "../llm/cost.js";

export type { HotelResult, HotelSource, NormalizedHotelsQuery };

/**
 * Notes a provider wants the tool to pass on to the user ("a consent dialog was
 * dismissed", "more results were not expanded") and the LLM budget shared with
 * the tool. PLAN.md 14.8.
 */
export interface HotelSearchHooks {
  caveats?: string[];
  meter?: CostMeter;
}

/**
 * A source of hotel offers, PLAN.md 14.1 and 14.8. Implementations return
 * results already validated by `HotelResultSchema`, tagged `source: name`, in
 * the page's own order (the tool sorts and filters), at most `max_results`.
 * Failures are thrown as `HotelProviderError`.
 */
export interface HotelProvider {
  readonly name: HotelSource;
  isConfigured(): boolean;
  search(query: NormalizedHotelsQuery, signal: AbortSignal, hooks?: HotelSearchHooks): Promise<HotelResult[]>;
}

export type HotelProviderErrorCode = "provider" | "timeout" | "invalid_input" | "config" | "blocked";

export interface HotelProviderErrorOptions {
  provider: HotelSource;
  code: HotelProviderErrorCode;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

/** Failure of a hotel provider. `code` maps onto the error envelope (PLAN.md 3.6). */
export class HotelProviderError extends Error {
  readonly provider: HotelSource;
  readonly code: HotelProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: HotelProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HotelProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}
