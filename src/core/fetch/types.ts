import type { ErrorCode } from "../../schemas/error.js";

/**
 * Fetcher contract, PLAN.md section 4.2. Implemented by the fast fetchers
 * (firecrawl, jina, direct) in WP3 and the browser fetcher in WP4; composed
 * into the `fetch_page` tool by WP5.
 */

export type FetchMethod = "firecrawl" | "jina" | "direct" | "browser";

export interface FetchOpts {
  /** Maximum characters of Markdown to return. Truncation is flagged, never silent. */
  maxChars: number;
  /** Browser mode only: CSS selector to wait for before extracting. */
  waitFor?: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
}

export interface FetchResult {
  url: string;
  final_url: string;
  title: string;
  markdown: string;
  truncated: boolean;
  method: FetchMethod;
  /** ISO 8601 UTC. */
  fetched_at: string;
  /**
   * True when the response looks like a bot wall (Cloudflare challenge,
   * "enable JavaScript", HTTP 403/429 interstitial). Auto mode falls back to
   * the browser fetcher when this is set.
   */
  botWall: boolean;
}

export interface Fetcher {
  readonly name: FetchMethod;
  isConfigured(): boolean;
  fetch(url: string, opts: FetchOpts, signal: AbortSignal): Promise<FetchResult>;
}

/** Typed failure raised by fetchers. `code` maps onto the tool error envelope. */
export class FetchError extends Error {
  constructor(
    public readonly fetcher: FetchMethod,
    public readonly code: Extract<ErrorCode, "provider" | "timeout" | "blocked" | "invalid_input" | "config">,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}
