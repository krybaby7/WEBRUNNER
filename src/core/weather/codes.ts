/**
 * WMO weather interpretation codes as Open-Meteo documents them
 * (https://open-meteo.com/en/docs, "WMO Weather interpretation codes (WW)").
 * `condition` in the `weather` output is this text, PLAN.md 14.3.
 */
export const WMO_CODES: Readonly<Record<number, string>> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

/** Every code the table knows, ascending. */
export const KNOWN_WMO_CODES: readonly number[] = Object.keys(WMO_CODES)
  .map(Number)
  .sort((a, b) => a - b);

/** Human text for a WMO code; an unknown code is named, never dropped. */
export function conditionText(code: number): string {
  return WMO_CODES[code] ?? `unknown (code ${code})`;
}
