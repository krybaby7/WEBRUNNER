import type { Config } from "../../../config.js";
import type { BrowserSession } from "../../browser/types.js";
import type { FetchService } from "../../fetch/index.js";
import type { LlmClient } from "../../llm/types.js";
import type { FetchImpl } from "../http.js";
import type { ReviewSourceProvider } from "../types.js";
import { AppStoreSource } from "./app-store.js";
import { buildBrowserReviewSources } from "./browser.js";
import { TrustpilotSource } from "./trustpilot.js";

/** Shared services the sources draw on. A source whose service is missing is left out or reports itself unconfigured. */
export interface ReviewSourceDeps {
  browser?: BrowserSession;
  llm?: LlmClient;
  fetch?: FetchService;
  /** Replaces global fetch for the API and raw-HTML sources. For tests. */
  fetchImpl?: FetchImpl;
}

/**
 * Every review source, configured or not, one per `REVIEW_SOURCES` entry where
 * its code exists. `search_reviews` uses the full list to tell a caller that an
 * explicitly requested source is unavailable rather than silently skipping it.
 */
export function buildAllReviewSources(_config: Config, deps: ReviewSourceDeps = {}): ReviewSourceProvider[] {
  const fetchImpl = deps.fetchImpl;
  return [
    new AppStoreSource({ ...(fetchImpl !== undefined && { fetchImpl }) }),
    new TrustpilotSource({
      ...(fetchImpl !== undefined && { fetchImpl }),
      ...(deps.fetch !== undefined && { fetch: deps.fetch }),
      ...(deps.llm !== undefined && { llm: deps.llm }),
      ...(deps.browser !== undefined && { browser: deps.browser }),
    }),
    // Browser sources (WP19b): listed even without a browser so an explicit request can be told why they are unavailable.
    ...buildBrowserReviewSources({
      ...(deps.browser !== undefined && { browser: deps.browser }),
      ...(deps.llm !== undefined && { llm: deps.llm }),
    }),
  ];
}

/** Sources that are configured and ready to search. */
export function buildReviewSources(config: Config, deps: ReviewSourceDeps = {}): ReviewSourceProvider[] {
  return buildAllReviewSources(config, deps).filter((s) => s.isConfigured());
}
