import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/config.js";
import { WeatherError, type WeatherService } from "../../../src/core/weather/index.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { WeatherOutputSchema, type WeatherOutput } from "../../../src/schemas/weather.js";
import { registerWeatherTool, type WeatherToolOptions } from "../../../src/tools/weather.js";
import { makeLogger } from "../markets/helpers.js";
import { callTool, connectServer, type Connected } from "../tools/helpers.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const OUTPUT: WeatherOutput = {
  location: { name: "Paris", country: "France", latitude: 48.85, longitude: 2.35, timezone: "Europe/Paris" },
  current: { time: "2026-10-18T14:15", temperature: 16.4, apparent_temperature: 14.9, humidity_pct: 62, wind_speed: 13.3, wind_direction_deg: 221, precipitation: 0, weather_code: 3, condition: "Overcast", is_day: true },
  daily: [{ date: "2026-10-18", temp_max: 16.6, temp_min: 9.2, precipitation_sum: 0.8, wind_speed_max: 18.4, sunrise: "2026-10-18T08:12", sunset: "2026-10-18T18:51", weather_code: 61, condition: "Slight rain" }],
  units: { temperature: "°C", wind_speed: "km/h", precipitation: "mm" },
  source: "open_meteo",
  fetched_at: "2026-10-18T12:00:00.000Z",
  caveats: [],
};

async function connect(options: WeatherToolOptions): Promise<Connected> {
  const deps: Deps = { config: { currency: "USD" } as Config, log: makeLogger() };
  const c = await connectServer((server) => registerWeatherTool(server, deps, options));
  open.push(() => c.close());
  return c;
}


/** The MCP SDK rejects arguments that fail the input schema before the handler runs; the handler's own check covers the rest. */
function expectInvalidInput(result: Awaited<ReturnType<typeof callTool>>): void {
  expect(result.isError).toBe(true);
  if (result.structuredContent !== undefined) {
    expect(ErrorEnvelopeSchema.parse(result.structuredContent).error.code).toBe("invalid_input");
  } else {
    expect(result.content[0]?.text ?? "").toMatch(/invalid|validation/i);
  }
}

function envelope(result: Awaited<ReturnType<typeof callTool>>) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

describe("weather tool", () => {
  it("describes itself with source, cap and annotations", async () => {
    const { client } = await connect({});
    const tool = (await client.listTools()).tools.find((t) => t.name === "weather");
    expect(tool?.description).toMatch(/Open-Meteo/);
    expect(tool?.description).toMatch(/no API key/);
    expect(tool?.description).toMatch(/20 seconds/);
    expect(tool?.description).toMatch(/16 days/);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
  });

  it("applies defaults and returns the forecast", async () => {
    let seen: unknown;
    const service: WeatherService = {
      forecast: async (q) => {
        seen = q;
        return OUTPUT;
      },
    };
    const { client } = await connect({ service: () => service });
    const result = await callTool(client, "weather", { location: "Paris" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ location: "Paris", days: 3, units: "metric", hourly: false });
    expect(WeatherOutputSchema.parse(result.structuredContent)).toEqual(OUTPUT);
  });

  it("returns invalid_input for bad arguments and for an unknown place", async () => {
    const service: WeatherService = { forecast: () => Promise.reject(new WeatherError("invalid_input", 'no place matches "Zzz"')) };
    const { client } = await connect({ service: () => service });
    expectInvalidInput(await callTool(client, "weather", {}));
    expectInvalidInput(await callTool(client, "weather", { location: "Paris", days: 17 }));
    expectInvalidInput(await callTool(client, "weather", { location: { latitude: 91, longitude: 0 } }));
    const e = envelope(await callTool(client, "weather", { location: "Zzz" }));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toContain("Zzz");
  });

  it("maps provider and timeout errors, the wall clock and unexpected failures", async () => {
    const provider: WeatherService = { forecast: () => Promise.reject(new WeatherError("provider", "open-meteo forecast returned HTTP 503", { retryable: true })) };
    const { client } = await connect({ service: () => provider });
    const e1 = envelope(await callTool(client, "weather", { location: "Paris" }));
    expect(e1).toMatchObject({ code: "provider", retryable: true });

    const { client: c2 } = await connect({ service: () => ({ forecast: () => new Promise(() => undefined) }), wallClockMs: 100 });
    const e2 = envelope(await callTool(c2, "weather", { location: "Paris" }));
    expect(e2).toMatchObject({ code: "timeout", retryable: true });

    const { client: c3 } = await connect({ service: () => ({ forecast: () => Promise.reject(new Error("boom\n at x")) }) });
    const e3 = envelope(await callTool(c3, "weather", { location: "Paris" }));
    expect(e3.code).toBe("internal");
    expect(e3.message).toBe("weather failed: boom");
  });
});
