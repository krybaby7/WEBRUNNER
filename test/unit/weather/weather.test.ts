import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ambiguityCaveat,
  buildForecastQuery,
  createWeatherService,
  WEATHER_TTL_MS,
  WeatherError,
  type WeatherQuery,
  type WeatherServiceDeps,
} from "../../../src/core/weather/index.js";
import { WeatherOutputSchema } from "../../../src/schemas/weather.js";
import { fakeFetch, jsonResponse, type RecordedCall } from "../search/helpers.js";
import { makeLogger, memoryCache, signal } from "../markets/helpers.js";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/weather/${name}.json`, import.meta.url), "utf8"));
const geocoding = load("geocoding-paris") as { results: Array<Record<string, unknown>> };
const forecast = load("forecast-paris");

function respond(call: RecordedCall): Response {
  const url = new URL(call.url);
  if (url.hostname === "geocoding-api.open-meteo.com") return jsonResponse(geocoding);
  if (url.hostname === "api.open-meteo.com") return jsonResponse(forecast);
  return new Response("nope", { status: 404 });
}

const PARIS: WeatherQuery = { location: "Paris", days: 3, units: "metric", hourly: false };

function service(f = fakeFetch(respond), over: Partial<WeatherServiceDeps> = {}) {
  return { f, svc: createWeatherService({ log: makeLogger(), fetchImpl: f.fetchImpl, ...over }) };
}

describe("weather: geocoding (fixture recorded live 2026-10-18)", () => {
  it("uses the first hit and lists the other countries or regions with coordinates", async () => {
    const { f, svc } = service();
    const out = await svc.forecast(PARIS, signal());
    expect(WeatherOutputSchema.safeParse(out).success).toBe(true);
    expect(out.location).toEqual({ name: "Paris", country: "France", admin1: "Île-de-France Region", latitude: 48.85341, longitude: 2.3488, timezone: "Europe/Paris" });
    expect(out.caveats[0]).toBe(
      "Several places match; using Paris, Île-de-France Region, France (48.85, 2.35). Other matches: Paris, Texas, United States (33.66, -95.56); Paris, Tennessee, United States (36.30, -88.33); Paris, Kentucky, United States (38.21, -84.25). Pass coordinates to pick one.",
    );
    const geo = new URL(f.calls[0]?.url ?? "");
    expect(geo.origin + geo.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(Object.fromEntries(geo.searchParams)).toEqual({ name: "Paris", count: "5", language: "en", format: "json" });
  });

  it("no caveat when the other hits share country and region, none for a single hit", () => {
    const a = { name: "X", latitude: 1, longitude: 2, country: "C", admin1: "R" };
    expect(ambiguityCaveat([a, { ...a, latitude: 3 }])).toBeUndefined();
    expect(ambiguityCaveat([a])).toBeUndefined();
    expect(ambiguityCaveat([])).toBeUndefined();
    expect(ambiguityCaveat([a, { ...a, admin1: "S" }])).toMatch(/Other matches: X, S, C/);
  });

  it("an unknown place is invalid_input without a forecast request", async () => {
    const f = fakeFetch(() => jsonResponse({ generationtime_ms: 0.5 }));
    const err = await service(f).svc.forecast({ ...PARIS, location: "Zzzzqqq" }, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeatherError);
    expect((err as WeatherError).code).toBe("invalid_input");
    expect(f.calls).toHaveLength(1);
  });

  it("coordinates skip geocoding and name the location by its coordinates", async () => {
    const { f, svc } = service();
    const out = await svc.forecast({ ...PARIS, location: { latitude: 48.85, longitude: 2.35 } }, signal());
    expect(f.calls).toHaveLength(1);
    expect(out.location).toEqual({ name: "48.8500, 2.3500", latitude: 48.85, longitude: 2.35, timezone: "Europe/Paris" });
    expect(out.caveats).toHaveLength(1);
  });
});

describe("weather: forecast mapping (fixture from docs; the live shape is checked below)", () => {
  it("maps current and daily with WMO condition text and metric units", async () => {
    const { f, svc } = service();
    const out = await svc.forecast(PARIS, signal());
    expect(out.current).toEqual({
      time: "2026-10-18T14:15", temperature: 16.4, apparent_temperature: 14.9, humidity_pct: 62, wind_speed: 13.3, wind_direction_deg: 221,
      precipitation: 0, weather_code: 3, condition: "Overcast", is_day: true,
    });
    expect(out.daily).toHaveLength(3);
    expect(out.daily[0]).toEqual({
      date: "2026-10-18", temp_max: 16.6, temp_min: 9.2, precipitation_sum: 0.8, precipitation_probability_max: 40, wind_speed_max: 18.4,
      sunrise: "2026-10-18T08:12", sunset: "2026-10-18T18:51", weather_code: 61, condition: "Slight rain", uv_index_max: 2.9,
    });
    expect(out.daily[2]?.condition).toBe("Mainly clear");
    expect(out.hourly).toBeUndefined();
    expect(out.units).toEqual({ temperature: "°C", wind_speed: "km/h", precipitation: "mm" });
    expect(out.source).toBe("open_meteo");
    expect(out.caveats.at(-1)).toBe("Times are local to Europe/Paris. Forecast data by Open-Meteo (open-meteo.com).");
    const fc = new URL(f.calls[1]?.url ?? "");
    expect(fc.origin + fc.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(fc.searchParams.get("latitude")).toBe("48.85341");
    expect(fc.searchParams.get("timezone")).toBe("auto");
    expect(fc.searchParams.get("forecast_days")).toBe("3");
    expect(fc.searchParams.get("current")).toBe("temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code,is_day");
    expect(fc.searchParams.get("daily")).toBe("temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,weather_code,uv_index_max");
    expect(fc.searchParams.has("hourly")).toBe(false);
    expect(fc.searchParams.has("temperature_unit")).toBe(false);
  });

  it("hourly starts at the current hour and is cut to 48 entries; imperial sets the unit parameters", async () => {
    const { f, svc } = service();
    const out = await svc.forecast({ ...PARIS, hourly: true, units: "imperial" }, signal());
    expect(out.hourly?.map((h) => h.time)).toEqual(["2026-10-18T14:00", "2026-10-18T15:00", "2026-10-18T16:00", "2026-10-18T17:00"]);
    expect(out.hourly?.[2]).toEqual({ time: "2026-10-18T16:00", temperature: 16.1, precipitation_probability: 35, precipitation: 0.3, weather_code: 51, condition: "Light drizzle", wind_speed: 12.8 });
    expect(out.units).toEqual({ temperature: "°F", wind_speed: "mph", precipitation: "inch" });
    const fc = new URL(f.calls[1]?.url ?? "");
    expect(fc.searchParams.get("hourly")).toBe("temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m");
    expect(fc.searchParams.get("temperature_unit")).toBe("fahrenheit");
    expect(fc.searchParams.get("wind_speed_unit")).toBe("mph");
    expect(fc.searchParams.get("precipitation_unit")).toBe("inch");
    const q = buildForecastQuery({ latitude: 1, longitude: 2 }, { days: 16, units: "metric", hourly: true });
    expect(q).toContain("forecast_days=16");
    const many = structuredClone(forecast) as { hourly: Record<string, unknown[]> };
    many.hourly["time"] = Array.from({ length: 72 }, (_, i) => `2026-10-18T${String(i % 24).padStart(2, "0")}:00`);
    for (const k of ["temperature_2m", "precipitation_probability", "precipitation", "weather_code", "wind_speed_10m"]) many.hourly[k] = Array.from({ length: 72 }, () => 1);
    const f2 = fakeFetch((call) => (new URL(call.url).hostname === "api.open-meteo.com" ? jsonResponse(many) : respond(call)));
    const out2 = await service(f2).svc.forecast({ ...PARIS, hourly: true }, signal());
    expect(out2.hourly).toHaveLength(48);
    expect(out2.hourly?.[0]?.time).toBe("2026-10-18T14:00");
  });

  it("drops days with null temperatures and keeps optional fields optional", async () => {
    const body = structuredClone(forecast) as { daily: Record<string, unknown[]> };
    body.daily["temperature_2m_max"] = [16.6, null, 13.1];
    delete body.daily["uv_index_max"];
    delete body.daily["precipitation_probability_max"];
    const f = fakeFetch((call) => (new URL(call.url).hostname === "api.open-meteo.com" ? jsonResponse(body) : respond(call)));
    const out = await service(f).svc.forecast(PARIS, signal());
    expect(out.daily.map((d) => d.date)).toEqual(["2026-10-18", "2026-10-20"]);
    expect("uv_index_max" in (out.daily[0] as object)).toBe(false);
    expect("precipitation_probability_max" in (out.daily[0] as object)).toBe(false);
  });

  it("maps HTTP and network failures to provider errors and an abort to timeout", async () => {
    const f500 = fakeFetch((call) => (new URL(call.url).hostname === "api.open-meteo.com" ? new Response("oops", { status: 503 }) : respond(call)));
    const e1 = (await service(f500).svc.forecast(PARIS, signal()).catch((e: unknown) => e)) as WeatherError;
    expect(e1.code).toBe("provider");
    expect(e1.retryable).toBe(true);
    expect(e1.message).toContain("503");
    const fNet = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const e2 = (await service(fNet).svc.forecast(PARIS, signal()).catch((e: unknown) => e)) as WeatherError;
    expect(e2.code).toBe("provider");
    const fHang = fakeFetch(() => new Promise<Response>(() => undefined));
    const ac = new AbortController();
    const pending = service(fHang).svc.forecast(PARIS, ac.signal).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 10);
    expect(((await pending) as WeatherError).code).toBe("timeout");
    const fSlow = fakeFetch(() => new Promise<Response>(() => undefined));
    const e4 = (await service(fSlow, { timeoutMs: 30 }).svc.forecast(PARIS, signal()).catch((e: unknown) => e)) as WeatherError;
    expect(e4.code).toBe("timeout");
  });
});

describe("weather: forecast mapping against a live response (recorded 2026-10-21)", () => {
  const live = load("forecast-paris-live");
  const liveFetch = () => fakeFetch((call) => (new URL(call.url).hostname === "api.open-meteo.com" ? jsonResponse(live) : respond(call)));

  it("maps the recorded response: current, three days and 48 hours from the current hour", async () => {
    const out = await service(liveFetch()).svc.forecast({ ...PARIS, hourly: true }, signal());
    expect(WeatherOutputSchema.safeParse(out).success).toBe(true);
    expect(out.current).toEqual({
      time: "2026-10-21T19:30", temperature: 11.9, apparent_temperature: 8.3, humidity_pct: 63, wind_speed: 16.3, wind_direction_deg: 248,
      precipitation: 0, weather_code: 0, condition: "Clear sky", is_day: false,
    });
    expect(out.daily.map((d) => [d.date, d.temp_max, d.temp_min, d.condition])).toEqual([
      ["2026-10-21", 14.5, 8.3, "Slight rain showers"],
      ["2026-10-22", 14.9, 8.8, "Slight rain"],
      ["2026-10-23", 12.9, 9.4, "Slight rain showers"],
    ]);
    expect(out.daily[0]).toMatchObject({ sunrise: "2026-10-21T08:20", sunset: "2026-10-21T18:49", precipitation_probability_max: 85, uv_index_max: 2.45 });
    expect(out.hourly).toHaveLength(48);
    expect(out.hourly?.[0]?.time).toBe("2026-10-21T19:00");
    expect(out.hourly?.at(-1)?.time).toBe("2026-10-23T18:00");
    expect(out.location.timezone).toBe("Europe/Paris");
  });

  it("asks for at least three days when hourly is on, so a one-day request still gets 48 hours", async () => {
    const f = liveFetch();
    const out = await service(f).svc.forecast({ ...PARIS, days: 1, hourly: true }, signal());
    expect(new URL(f.calls[1]?.url ?? "").searchParams.get("forecast_days")).toBe("3");
    expect(out.daily).toHaveLength(1);
    expect(out.hourly).toHaveLength(48);
    expect(buildForecastQuery({ latitude: 1, longitude: 2 }, { days: 1, units: "metric", hourly: false })).toContain("forecast_days=1");
    expect(buildForecastQuery({ latitude: 1, longitude: 2 }, { days: 2, units: "metric", hourly: true })).toContain("forecast_days=3");
    expect(buildForecastQuery({ latitude: 1, longitude: 2 }, { days: 7, units: "metric", hourly: true })).toContain("forecast_days=7");
  });

  it("names Open-Meteo's daily-limit 429 in a retryable provider error", async () => {
    const f = fakeFetch((call) =>
      new URL(call.url).hostname === "api.open-meteo.com"
        ? jsonResponse({ error: true, reason: "Daily API request limit exceeded. Please try again tomorrow." }, 429)
        : respond(call),
    );
    const err = (await service(f).svc.forecast(PARIS, signal()).catch((e: unknown) => e)) as WeatherError;
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("HTTP 429");
    expect(err.message).toContain("Daily API request limit exceeded");
  });
});

describe("weather: cache TTLs with an injected clock", () => {
  it("geocoding 30 days, forecast 10 minutes", async () => {
    const clock = { now: Date.parse("2026-10-18T12:00:00Z") };
    const cache = memoryCache(clock);
    const f = fakeFetch(respond);
    const svc = createWeatherService({ log: makeLogger(), fetchImpl: f.fetchImpl, cache, now: () => clock.now });
    const hosts = () => f.calls.map((c) => new URL(c.url).hostname);
    await svc.forecast(PARIS, signal());
    await svc.forecast(PARIS, signal());
    expect(hosts()).toEqual(["geocoding-api.open-meteo.com", "api.open-meteo.com"]);
    clock.now += WEATHER_TTL_MS.forecast;
    await svc.forecast(PARIS, signal());
    expect(hosts()).toEqual(["geocoding-api.open-meteo.com", "api.open-meteo.com", "api.open-meteo.com"]);
    clock.now += WEATHER_TTL_MS.geocoding - WEATHER_TTL_MS.forecast;
    const out = await svc.forecast(PARIS, signal());
    expect(hosts().filter((h) => h.startsWith("geocoding"))).toHaveLength(2);
    expect(out.fetched_at).toBe(new Date(clock.now).toISOString());
    // The forecast key includes days, units and hourly.
    await svc.forecast({ ...PARIS, days: 5 }, signal());
    expect(hosts().filter((h) => h === "api.open-meteo.com")).toHaveLength(4);
    expect(vi.isMockFunction(f.fetchImpl)).toBe(false);
  });
});
