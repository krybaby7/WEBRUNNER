import type { Config } from "../../../config.js";
import type { BrowserSession } from "../../browser/types.js";
import type { LlmClient } from "../../llm/types.js";
import type { HotelProvider } from "../types.js";
import { GoogleHotelsProvider } from "./google-hotels.js";

/** Shared services the providers need. A provider whose service is missing is left out. */
export interface HotelProviderDeps {
  browser?: BrowserSession;
  llm?: LlmClient;
}

/**
 * Every hotel provider, configured or not, mirroring `buildAllFlightProviders`.
 * `search_hotels` uses this to tell a caller that an explicitly requested
 * source is unavailable rather than silently ignoring it.
 */
export function buildAllHotelProviders(_config: Config, deps: HotelProviderDeps = {}): HotelProvider[] {
  return [
    // Google Hotels needs a browser; without one it is not offered at all. The LLM is optional (fallback only).
    ...(deps.browser !== undefined
      ? [
          new GoogleHotelsProvider({
            browser: deps.browser,
            ...(deps.llm !== undefined && { llm: deps.llm }),
          }),
        ]
      : []),
  ];
}

/** Providers that are configured and ready to search. */
export function buildHotelProviders(config: Config, deps: HotelProviderDeps = {}): HotelProvider[] {
  return buildAllHotelProviders(config, deps).filter((p) => p.isConfigured());
}
