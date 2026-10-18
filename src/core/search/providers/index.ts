import type { Config } from "../../../config.js";
import type { SearchProvider } from "../types.js";
import { BraveProvider } from "./brave.js";
import { ExaProvider } from "./exa.js";
import { PerplexityProvider } from "./perplexity.js";
import { TavilyProvider } from "./tavily.js";

export { BraveProvider } from "./brave.js";
export { ExaProvider } from "./exa.js";
export { PerplexityProvider } from "./perplexity.js";
export { TavilyProvider } from "./tavily.js";

export interface BuildProvidersOptions {
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The configured search providers, in the fixed order brave, exa, tavily, perplexity. */
export function buildProviders(config: Config, opts: BuildProvidersOptions = {}): SearchProvider[] {
  const shared = opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {};
  const all: SearchProvider[] = [
    new BraveProvider({ ...shared, ...(config.brave_api_key !== undefined && { apiKey: config.brave_api_key }) }),
    new ExaProvider({ ...shared, ...(config.exa_api_key !== undefined && { apiKey: config.exa_api_key }) }),
    new TavilyProvider({ ...shared, ...(config.tavily_api_key !== undefined && { apiKey: config.tavily_api_key }) }),
    new PerplexityProvider({
      ...shared,
      ...(config.perplexity_api_key !== undefined && { apiKey: config.perplexity_api_key }),
    }),
  ];
  return all.filter((p) => p.isConfigured());
}
