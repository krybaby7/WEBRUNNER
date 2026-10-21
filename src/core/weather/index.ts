import { z } from "zod";
import type { Logger } from "../../log.js";
import { HOURLY_HOURS, WeatherOutputSchema, type WeatherOutput, type WeatherUnits } from "../../schemas/weather.js";
import type { Cache } from "../cache/index.js";
import { conditionText } from "./codes.js";

/**
 * Weather from Open-Meteo (keyless), PLAN.md 14.3.
 *
 * Geocoding verified live on 2026-10-18 from the development environment:
 *   https://geocoding-api.open-meteo.com/v1/search?name=Paris&count=5&language=en&format=json
 *   -> results[] of { name, latitude, longitude, country, country_code, admin1, admin2, timezone, population, ... }
 *   (Paris FR first, then four US towns named Paris). A place with no match answers `{"generationtime_ms":...}` with no `results`.
 * Forecast: api.open-meteo.com timed out from the development environment on
 * 2026-10-18, so the mapping was first written from the documented shape
 * (variables as parallel arrays under `current`, `daily` and `hourly`, each with
 * a `time` array in the location's local time when `timezone=auto`; see
 * test/fixtures/weather/forecast-paris.json). Verified live on 2026-10-21 from a
 * cloud session: the response had exactly the documented keys and units
 * (test/fixtures/weather/forecast-paris-live.json). From that shared cloud IP
 * some requests answered HTTP 429 `{"error":true,"reason":"Daily API request
 * limit exceeded..."}` (Open-Meteo's free tier counts calls per IP); that is a
 * retryable `provider` error naming the reason.
 *
 * `hourly` holds the next 48 hours (14.3), but Open-Meteo returns hourly data
 * only for the `forecast_days` requested, so an hourly request asks for at least
 * HOURLY_MIN_DAYS days and `daily` is cut back to the requested `days`.
 */

export const GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com";
export const FORECAST_BASE_URL = "https://api.open-meteo.com";
export const WEATHER_DEFAULT_TIMEOUT_MS = 10_000;
export const WEATHER_TTL_MS = { forecast: 10 * 60_000, geocoding: 30 * 24 * 60 * 60_000 } as const;
const GEOCODE_COUNT = 5;
/** Days of forecast that always cover the next 48 hours, whatever the current hour (72 - 23 >= 48). */
const HOURLY_MIN_DAYS = 3;
const MAX_ALTERNATIVES = 3;

const CURRENT_VARS = [
  "temperature_2m", "apparent_temperature", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m",
  "precipitation", "weather_code", "is_day",
];
const DAILY_VARS = [
  "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max",
  "wind_speed_10m_max", "sunrise", "sunset", "weather_code", "uv_index_max",
];
const HOURLY_VARS = ["temperature_2m", "precipitation_probability", "precipitation", "weather_code", "wind_speed_10m"];

export type WeatherErrorCode = "invalid_input" | "provider" | "timeout";

export class WeatherError extends Error {
  readonly code: WeatherErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: WeatherErrorCode, message: string, options: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WeatherError";
    this.code = code;
    this.retryable = options.retryable ?? code === "timeout";
    if (options.details !== undefined) this.details = options.details;
  }
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** The parsed `weather` input (defaults applied by the schema). */
export interface WeatherQuery {
  location: string | Coordinates;
  days: number;
  units: WeatherUnits;
  hourly: boolean;
}

export interface WeatherService {
  forecast(query: WeatherQuery, signal: AbortSignal): Promise<WeatherOutput>;
}

export interface WeatherServiceDeps {
  log: Logger;
  cache?: Cache;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  geocodingBaseUrl?: string;
  forecastBaseUrl?: string;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  /** Clock in epoch milliseconds, for fetched_at. Default Date.now. */
  now?: () => number;
}

const GeocodeHit = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  country: z.string().optional(),
  country_code: z.string().optional(),
  admin1: z.string().optional(),
  timezone: z.string().optional(),
});
const GeocodeResponse = z.object({ results: z.array(GeocodeHit).optional() });
export type GeocodeHit = z.infer<typeof GeocodeHit>;

const numbers = z.array(z.number().nullable());
const strings = z.array(z.string());
const ForecastResponse = z.object({
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    wind_speed_10m: z.number(),
    wind_direction_10m: z.number(),
    precipitation: z.number(),
    weather_code: z.number(),
    is_day: z.number(),
  }),
  daily: z.object({
    time: strings,
    temperature_2m_max: numbers,
    temperature_2m_min: numbers,
    precipitation_sum: numbers,
    precipitation_probability_max: numbers.optional(),
    wind_speed_10m_max: numbers,
    sunrise: strings,
    sunset: strings,
    weather_code: numbers,
    uv_index_max: numbers.optional(),
  }),
  hourly: z
    .object({
      time: strings,
      temperature_2m: numbers,
      precipitation_probability: numbers.optional(),
      precipitation: numbers,
      weather_code: numbers,
      wind_speed_10m: numbers,
    })
    .optional(),
});

/** Query string of the forecast request, PLAN.md 14.3 (exported for tests). */
export function buildForecastQuery(coords: Coordinates, q: Pick<WeatherQuery, "days" | "units" | "hourly">): string {
  const params = new URLSearchParams({
    latitude: String(coords.latitude),
    longitude: String(coords.longitude),
    timezone: "auto",
    forecast_days: String(q.hourly ? Math.max(q.days, HOURLY_MIN_DAYS) : q.days),
    current: CURRENT_VARS.join(","),
    daily: DAILY_VARS.join(","),
  });
  if (q.hourly) params.set("hourly", HOURLY_VARS.join(","));
  if (q.units === "imperial") {
    params.set("temperature_unit", "fahrenheit");
    params.set("wind_speed_unit", "mph");
    params.set("precipitation_unit", "inch");
  }
  return params.toString();
}

/** The alternatives caveat when other hits differ in country or admin1 from the first (exported for tests). */
export function ambiguityCaveat(hits: readonly GeocodeHit[]): string | undefined {
  const first = hits[0];
  if (first === undefined) return undefined;
  const others = hits
    .slice(1)
    .filter((h) => h.country !== first.country || h.admin1 !== first.admin1)
    .slice(0, MAX_ALTERNATIVES);
  if (others.length === 0) return undefined;
  const describe = (h: GeocodeHit): string =>
    `${[h.name, h.admin1, h.country].filter((p) => p !== undefined && p !== "").join(", ")} (${h.latitude.toFixed(2)}, ${h.longitude.toFixed(2)})`;
  return `Several places match; using ${describe(first)}. Other matches: ${others.map(describe).join("; ")}. Pass coordinates to pick one.`;
}

function pick<T>(arr: readonly (T | null)[] | undefined, i: number): T | undefined {
  const v = arr?.[i];
  return v === null || v === undefined ? undefined : v;
}

export function createWeatherService(deps: WeatherServiceDeps): WeatherService {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const geocodingBase = (deps.geocodingBaseUrl ?? GEOCODING_BASE_URL).replace(/\/+$/, "");
  const forecastBase = (deps.forecastBaseUrl ?? FORECAST_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? WEATHER_DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function getJson<S extends z.ZodType>(url: string, what: string, schema: S, signal: AbortSignal): Promise<z.infer<S>> {
    const perRequest = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    let text: string;
    try {
      res = await raceAbort(fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: perRequest }), perRequest, what);
      text = await raceAbort(res.text(), perRequest, what);
    } catch (err) {
      if (err instanceof WeatherError) throw err;
      if (perRequest.aborted) throw timeoutError(what, err);
      throw new WeatherError("provider", `open-meteo ${what} network error: ${message(err)}`, { retryable: true, cause: err });
    }
    if (res.status < 200 || res.status > 299) {
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new WeatherError("provider", `open-meteo ${what} returned HTTP ${res.status}${preview !== "" ? `: ${preview}` : ""}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (err) {
      throw new WeatherError("provider", `open-meteo ${what} returned a body that is not valid JSON`, { cause: err });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WeatherError("provider", `open-meteo ${what} returned an unexpected response shape (${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"})`);
    }
    return parsed.data;
  }

  async function cached<T>(key: unknown, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = deps.cache !== undefined ? await deps.cache.get<T>(key) : undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    await deps.cache?.set(key, value, ttlMs);
    return value;
  }

  async function geocode(name: string, signal: AbortSignal): Promise<GeocodeHit[]> {
    const q = name.trim();
    const hits = await cached({ source: "open_meteo", kind: "geocode", name: q.toLowerCase() }, WEATHER_TTL_MS.geocoding, async () => {
      const params = new URLSearchParams({ name: q, count: String(GEOCODE_COUNT), language: "en", format: "json" });
      const body = await getJson(`${geocodingBase}/v1/search?${params.toString()}`, "geocoding", GeocodeResponse, signal);
      return body.results ?? [];
    });
    if (hits.length === 0) throw new WeatherError("invalid_input", `no place matches "${q}"; try a city name with its country ("Paris, FR") or coordinates`);
    return hits;
  }

  async function forecast(query: WeatherQuery, signal: AbortSignal): Promise<WeatherOutput> {
    const caveats: string[] = [];
    let coords: Coordinates;
    let place: { name: string; country?: string; admin1?: string };
    if (typeof query.location === "string") {
      const hits = await geocode(query.location, signal);
      const first = hits[0] as GeocodeHit;
      coords = { latitude: first.latitude, longitude: first.longitude };
      place = {
        name: first.name,
        ...(first.country !== undefined && { country: first.country }),
        ...(first.admin1 !== undefined && { admin1: first.admin1 }),
      };
      const ambiguity = ambiguityCaveat(hits);
      if (ambiguity !== undefined) caveats.push(ambiguity);
    } else {
      coords = query.location;
      place = { name: `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}` };
    }

    const key = { source: "open_meteo", kind: "forecast", ...coords, days: query.days, units: query.units, hourly: query.hourly };
    const body = await cached(key, WEATHER_TTL_MS.forecast, () =>
      getJson(`${forecastBase}/v1/forecast?${buildForecastQuery(coords, query)}`, "forecast", ForecastResponse, signal),
    );

    const daily = body.daily.time.map((date, i) => {
      const code = pick(body.daily.weather_code, i) ?? 0;
      const probability = pick(body.daily.precipitation_probability_max, i);
      const uv = pick(body.daily.uv_index_max, i);
      return {
        date,
        temp_max: pick(body.daily.temperature_2m_max, i) ?? Number.NaN,
        temp_min: pick(body.daily.temperature_2m_min, i) ?? Number.NaN,
        precipitation_sum: pick(body.daily.precipitation_sum, i) ?? 0,
        ...(probability !== undefined && { precipitation_probability_max: probability }),
        wind_speed_max: pick(body.daily.wind_speed_10m_max, i) ?? Number.NaN,
        sunrise: body.daily.sunrise[i] ?? "",
        sunset: body.daily.sunset[i] ?? "",
        weather_code: code,
        condition: conditionText(code),
        ...(uv !== undefined && { uv_index_max: uv }),
      };
    }).filter((d) => Number.isFinite(d.temp_max) && Number.isFinite(d.temp_min) && Number.isFinite(d.wind_speed_max));
    if (daily.length === 0) throw new WeatherError("provider", "open-meteo returned no complete daily forecast");

    let hourly: WeatherOutput["hourly"];
    if (query.hourly && body.hourly !== undefined) {
      const h = body.hourly;
      const currentHour = `${body.current.time.slice(0, 13)}:00`;
      let start = h.time.findIndex((t) => t >= currentHour);
      if (start < 0) start = 0;
      hourly = h.time.slice(start, start + HOURLY_HOURS).flatMap((time, j) => {
        const i = start + j;
        const temperature = pick(h.temperature_2m, i);
        const code = pick(h.weather_code, i);
        const wind = pick(h.wind_speed_10m, i);
        if (temperature === undefined || code === undefined || wind === undefined) return [];
        const probability = pick(h.precipitation_probability, i);
        return [
          {
            time,
            temperature,
            ...(probability !== undefined && { precipitation_probability: probability }),
            precipitation: pick(h.precipitation, i) ?? 0,
            weather_code: code,
            condition: conditionText(code),
            wind_speed: wind,
          },
        ];
      });
    } else if (query.hourly) {
      caveats.push("Open-Meteo returned no hourly data for this location.");
    }

    const imperial = query.units === "imperial";
    const output: WeatherOutput = {
      location: { ...place, latitude: coords.latitude, longitude: coords.longitude, timezone: body.timezone },
      current: {
        time: body.current.time,
        temperature: body.current.temperature_2m,
        apparent_temperature: body.current.apparent_temperature,
        humidity_pct: body.current.relative_humidity_2m,
        wind_speed: body.current.wind_speed_10m,
        wind_direction_deg: body.current.wind_direction_10m,
        precipitation: body.current.precipitation,
        weather_code: body.current.weather_code,
        condition: conditionText(body.current.weather_code),
        is_day: body.current.is_day === 1,
      },
      daily: daily.slice(0, query.days),
      ...(hourly !== undefined && { hourly }),
      units: imperial
        ? { temperature: "°F", wind_speed: "mph", precipitation: "inch" }
        : { temperature: "°C", wind_speed: "km/h", precipitation: "mm" },
      source: "open_meteo",
      fetched_at: new Date(now()).toISOString(),
      caveats: [...caveats, `Times are local to ${body.timezone}. Forecast data by Open-Meteo (open-meteo.com).`],
    };
    const checked = WeatherOutputSchema.safeParse(output);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new WeatherError("provider", `open-meteo data did not fit the weather schema (${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"})`);
    }
    return checked.data;
  }

  return { forecast };
}

function timeoutError(what: string, cause: unknown): WeatherError {
  return new WeatherError("timeout", `open-meteo ${what} did not answer in time (timed out or cancelled)`, { retryable: true, cause });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(timeoutError(what, signal.reason));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
