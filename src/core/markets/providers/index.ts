import type { Config } from "../../../config.js";
import type { BrowserSession } from "../../browser/types.js";
import type { LlmClient } from "../../llm/types.js";
import type { MarketProvider } from "../types.js";
import { CoinGeckoProvider } from "./coingecko.js";
import { FinnhubProvider } from "./finnhub.js";
import { GoogleFinanceProvider } from "./google-finance.js";
import { YahooProvider } from "./yahoo.js";

export { CoinGeckoProvider, FinnhubProvider, GoogleFinanceProvider, YahooProvider };

/** Shared services some providers need. Google Finance is left out without a browser. */
export interface MarketProviderDeps {
  browser?: BrowserSession;
  llm?: LlmClient;
}

/**
 * Every market provider, configured or not, so `market_quote` can tell a
 * caller that an explicitly requested source is unavailable (no key) instead
 * of silently ignoring it.
 */
export function buildAllMarketProviders(config: Config, deps: MarketProviderDeps = {}): MarketProvider[] {
  return [
    new YahooProvider(),
    new FinnhubProvider({ ...(config.finnhub_api_key !== undefined && { apiKey: config.finnhub_api_key }) }),
    new CoinGeckoProvider(),
    ...(deps.browser !== undefined
      ? [new GoogleFinanceProvider({ browser: deps.browser, ...(deps.llm !== undefined && { llm: deps.llm }) })]
      : []),
  ];
}

/** Providers that are configured and ready to quote. */
export function buildMarketProviders(config: Config, deps: MarketProviderDeps = {}): MarketProvider[] {
  return buildAllMarketProviders(config, deps).filter((p) => p.isConfigured());
}
