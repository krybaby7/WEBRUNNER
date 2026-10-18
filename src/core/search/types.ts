/**
 * Search provider contract, PLAN.md section 4.1.
 * Implemented by the four providers under ./providers and consumed by the
 * fusion layer and the `web_search` tool (WP2).
 */

export type SearchProviderName = "brave" | "exa" | "tavily" | "perplexity";

export type Recency = "day" | "week" | "month" | "year";

export interface SearchQuery {
  query: string;
  maxResults: number;
  recency?: Recency;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface RawResult {
  url: string;
  title: string;
  snippet: string;
  /** ISO 8601 UTC, already run through normalizePublishedAt. Omitted when unknown. */
  publishedAt?: string;
  /** 1-based rank within this provider's own result list. */
  rank: number;
}

export interface SearchProvider {
  readonly name: SearchProviderName;
  isConfigured(): boolean;
  search(q: SearchQuery, signal: AbortSignal): Promise<RawResult[]>;
}

/** Constructor options shared by every provider. */
export interface ProviderOptions {
  apiKey?: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** API origin, without a trailing path. Overridable for tests. */
  baseUrl?: string;
}

export interface ProviderErrorInit {
  provider: SearchProviderName;
  message: string;
  status?: number;
  retryable: boolean;
  /** True when the failure is the caller's AbortSignal firing, not the provider failing. */
  aborted?: boolean;
  cause?: unknown;
}

/**
 * Every provider failure surfaces as this type. `code` is always "provider" so
 * it maps directly onto the error envelope (PLAN.md section 3.6).
 */
export class ProviderError extends Error {
  readonly code = "provider" as const;
  readonly provider: SearchProviderName;
  readonly status?: number;
  readonly retryable: boolean;
  readonly aborted: boolean;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ProviderError";
    this.provider = init.provider;
    if (init.status !== undefined) this.status = init.status;
    this.retryable = init.retryable;
    this.aborted = init.aborted ?? false;
  }
}

/** 429 and 5xx are retryable; every other HTTP status is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
