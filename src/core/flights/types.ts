import type { FlightOffer, FlightSource, NormalizedFlightsQuery } from "../../schemas/flights.js";

export type { FlightOffer, FlightSource, NormalizedFlightsQuery };

/**
 * A source of flight offers. Implementations return offers already mapped to
 * the shared schema (`FlightOfferSchema`), tagged with `source: name`, sorted
 * by price ascending and capped at 30. Failures are thrown as
 * `FlightProviderError`.
 */
export interface FlightProvider {
  readonly name: FlightSource;
  isConfigured(): boolean;
  search(query: NormalizedFlightsQuery, signal: AbortSignal): Promise<FlightOffer[]>;
}

export type FlightProviderErrorCode = "provider" | "timeout" | "invalid_input" | "config";

export interface FlightProviderErrorOptions {
  provider: FlightSource;
  code: FlightProviderErrorCode;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

/**
 * Failure of a flight provider. `code` matches the error envelope codes in
 * PLAN.md section 3.6 so the tool can pass it straight to `toolError`.
 */
export class FlightProviderError extends Error {
  readonly provider: FlightSource;
  readonly status?: number;
  readonly retryable: boolean;
  readonly code: FlightProviderErrorCode;

  constructor(message: string, options: FlightProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FlightProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}
