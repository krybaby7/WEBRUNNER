import type { Config } from "./config.js";
import { createCache, type Cache } from "./core/cache/index.js";
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
  return { config, log, cache, search };
}
