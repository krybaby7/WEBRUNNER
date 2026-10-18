import type { Config } from "../../../config.js";
import type { FlightProvider } from "../types.js";
import { DuffelProvider } from "./duffel.js";

/**
 * Every flight provider, configured or not. `search_flights` uses this to tell
 * a caller that an explicitly requested source (`sources: ["duffel"]`) is
 * unavailable because its key is missing, rather than silently ignoring it.
 */
export function buildAllFlightProviders(config: Config): FlightProvider[] {
  return [
    new DuffelProvider({ ...(config.duffel_api_key !== undefined && { apiKey: config.duffel_api_key }) }),
    // REGISTRATION POINT (WP11): add the Google Flights provider here, for example
    //   new GoogleFlightsProvider({ ...deps }),
    // It must implement FlightProvider with name "google_flights".
  ];
}

/** Providers that are configured and ready to search. */
export function buildFlightProviders(config: Config): FlightProvider[] {
  return buildAllFlightProviders(config).filter((p) => p.isConfigured());
}
