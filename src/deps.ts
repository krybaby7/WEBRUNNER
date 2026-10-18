import type { Config } from "./config.js";
import { createBrowserSession } from "./core/browser/session.js";
import type { BrowserSession } from "./core/browser/types.js";
import { createCache, type Cache } from "./core/cache/index.js";
import { createFetchService, type FetchService } from "./core/fetch/index.js";
import { BrowserFetcher } from "./core/fetch/browser.js";
import { buildFastFetchers } from "./core/fetch/fast/index.js";
import { createLlmClient } from "./core/llm/index.js";
import { DailyCostCap } from "./core/llm/daily-cap.js";
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
  /**
   * Daily soft cap on LLM spend, set only when WEBRUNNER_DAILY_COST_CAP_USD is
   * configured. It is also the LLM client's client-wide meter, so every call is
   * counted; tools use it to refuse work up front.
   */
  dailyCap?: DailyCostCap;
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
  const dailyCap =
    config.daily_cost_cap_usd !== undefined
      ? new DailyCostCap({ capUsd: config.daily_cost_cap_usd, dir: config.cache_dir, log })
      : undefined;
  const llm = createLlmClient(config, dailyCap !== undefined ? { meter: dailyCap } : {});
  const browser = createBrowserSession(config);
  const fetch = createFetchService({
    fastFetchers: buildFastFetchers(config),
    browserFetcher: new BrowserFetcher(browser),
    cache,
    log,
    secrets,
  });
  return { config, log, cache, search, llm, browser, fetch, ...(dailyCap !== undefined && { dailyCap }) };
}

/** How long `closeDeps` waits for the browser to close before it gives up and lets the process exit. */
export const BROWSER_CLOSE_TIMEOUT_MS = 6000;

/**
 * Release everything that holds a process or file handle. Safe to call twice.
 * Closing the browser is bounded by `browserCloseTimeoutMs`: a Chromium that
 * will not close must not keep the server alive, and the caller's forced-exit
 * timer must be longer than this so it never races a close still in progress.
 */
export async function closeDeps(deps: Deps, browserCloseTimeoutMs: number = BROWSER_CLOSE_TIMEOUT_MS): Promise<void> {
  if (deps.browser !== undefined) {
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), browserCloseTimeoutMs);
    });
    try {
      const outcome = await Promise.race([deps.browser.close().then(() => "closed" as const), gaveUp]);
      if (outcome === "timeout") {
        log.warn("the browser did not close in time; exiting anyway", { timeout_ms: browserCloseTimeoutMs });
      }
    } catch (err) {
      log.warn("error while closing the browser session", { error: String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
}
