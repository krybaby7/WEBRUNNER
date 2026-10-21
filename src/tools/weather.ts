import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { createWeatherService, WeatherError, type WeatherService } from "../core/weather/index.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";
import { WeatherInputSchema, WeatherOutputSchema } from "../schemas/weather.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Current conditions and a daily forecast (1 to 16 days, default 3), optionally the next 48 hours hour by hour, for a place name or coordinates. " +
  "Source: Open-Meteo (no API key): its geocoder resolves the place (the first match is used and other countries or regions with the same name are listed in caveats; pass coordinates to pick one), " +
  "then its forecast API answers with WMO weather codes mapped to plain-English conditions. Metric by default (°C, km/h, mm); imperial gives °F, mph and inch. " +
  "Times are the location's local time with the timezone named in the result. Forecasts are cached 10 minutes. " +
  "Each request gets 10 seconds and the whole call is capped at 20 seconds; past that it returns error code timeout (retryable).";

export interface WeatherToolOptions {
  /** Replaces the Open-Meteo service. For tests. */
  service?: (deps: Deps) => WeatherService;
  /** Overrides the 20 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

export function registerWeatherTool(server: McpServer, deps: Deps, options: WeatherToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.weather;
  const makeService =
    options.service ?? ((d: Deps): WeatherService => createWeatherService({ log: d.log, ...(d.cache !== undefined && { cache: d.cache }) }));

  server.registerTool(
    "weather",
    {
      title: "Weather",
      description: DESCRIPTION,
      inputSchema: WeatherInputSchema,
      outputSchema: WeatherOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("weather", capMs, async (wallSignal) => {
        try {
          const parsed = WeatherInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const service = makeService(deps);
          const output = await service.forecast(parsed.data, AbortSignal.any([extra.signal, wallSignal]));
          const checked = WeatherOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("weather produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "weather produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          if (err instanceof WeatherError) return toolError(err.code, err.message, err.retryable, err.details);
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("weather failed unexpectedly", { error: message });
          return toolError("internal", `weather failed: ${message}`, false);
        }
      }),
  );
}
