import type { Config } from "./config.js";
import { createBrowserSession } from "./core/browser/session.js";
import type { BrowserSession } from "./core/browser/types.js";
import { createCache, type Cache } from "./core/cache/index.js";
import { createFetchService, type FetchService } from "./core/fetch/index.js";
import { BrowserFetcher } from "./core/fetch/browser.js";
import { buildFastFetchers } from "./core/fetch/fast/index.js";
import { createLlmClient } from "./core/llm/index.js";
import type { LlmClient } from "./core/llm/types.js";
import { createSearchService, type SearchService } from "./core/search/index.js";
import { buildProviders } from "./core/search/providers/index.js";
import { log, type Logger } from "./log.js";

/**
 * Shared dependencies handed to every tool at registration time.
 * Later work packages add fields here (cache, llm, search, fetch, browser);
 * each addition is one optional field so parallel branches merge cleanly.
 */
export interface Deps {
  config: Config;
  log: Logger;
  /** Disk cache under config.cache_dir. Set by buildDeps. */
  cache?: Cache;
  /** Merged web search. Set by buildDeps even when no provider is configured. */
  search?: SearchService;
  /**
   * Claude API client. Always set; `complete()` throws an LlmError with code
   * "config" when ANTHROPIC_API_KEY is unset (PLAN.md section 1).
   */
  llm?: LlmClient;
  /**
   * Shared Playwright session (PLAN.md 4.3). Launches lazily on first
   * `acquire()`; `closeDeps` closes it on shutdown.
   */
  browser?: BrowserSession;
  /** URL to Markdown with fast fetchers, a browser fallback and a cache (PLAN.md 3.2). Set by buildDeps. */
  fetch?: FetchService;
}

export function buildDeps(config: Config): Deps {
  const cache = createCache(config.cache_dir);
  const secrets = [
    config.anthropic_api_key,
    config.brave_api_key,
    config.exa_api_key,
    config.tavily_api_key,
    config.perplexity_api_key,
    config.firecrawl_api_key,
    config.jina_api_key,
    config.duffel_api_key,
  ].filter((k): k is string => k !== undefined && k !== "");
  const search = createSearchService({ providers: buildProviders(config), cache, log, secrets });
  const llm = createLlmClient(config);
  const browser = createBrowserSession(config);
  const fetch = createFetchService({
    fastFetchers: buildFastFetchers(config),
    browserFetcher: new BrowserFetcher(browser),
    cache,
    log,
    secrets,
  });
  return { config, log, cache, search, llm, browser, fetch };
}

/** Release everything that holds a process or file handle. Safe to call twice. */
export async function closeDeps(deps: Deps): Promise<void> {
  if (deps.browser !== undefined) {
    try {
      await deps.browser.close();
    } catch (err) {
      log.warn("error while closing the browser session", { error: String(err) });
    }
  }
}
