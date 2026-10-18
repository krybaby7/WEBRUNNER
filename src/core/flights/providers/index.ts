import type { Config } from "../../../config.js";
import type { BrowserSession } from "../../browser/types.js";
import type { LlmClient } from "../../llm/types.js";
import type { FlightProvider } from "../types.js";
import { DuffelProvider } from "./duffel.js";
import { GoogleFlightsProvider } from "./google-flights.js";

/** Shared services some providers need. Providers whose service is missing are left out. */
export interface FlightProviderDeps {
  browser?: BrowserSession;
  llm?: LlmClient;
}

/**
 * Every flight provider, configured or not. `search_flights` uses this to tell
 * a caller that an explicitly requested source (`sources: ["duffel"]`) is
 * unavailable because its key is missing, rather than silently ignoring it.
 */
export function buildAllFlightProviders(config: Config, deps: FlightProviderDeps = {}): FlightProvider[] {
  return [
    new DuffelProvider({ ...(config.duffel_api_key !== undefined && { apiKey: config.duffel_api_key }) }),
    // Google Flights needs a browser; without one it is not offered at all.
    ...(deps.browser !== undefined
      ? [
          new GoogleFlightsProvider({
            browser: deps.browser,
            ...(deps.llm !== undefined && { llm: deps.llm }),
          }),
        ]
      : []),
  ];
}

/** Providers that are configured and ready to search. */
export function buildFlightProviders(config: Config, deps: FlightProviderDeps = {}): FlightProvider[] {
  return buildAllFlightProviders(config, deps).filter((p) => p.isConfigured());
}
