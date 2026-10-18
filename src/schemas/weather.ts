import { z } from "zod";

/** `weather` input and output, PLAN.md section 14.3. Owned by WP15, consumed by WP20. */

export const WEATHER_UNITS = ["metric", "imperial"] as const;
export const WeatherUnitsSchema = z.enum(WEATHER_UNITS);
export type WeatherUnits = z.infer<typeof WeatherUnitsSchema>;

export const DEFAULT_FORECAST_DAYS = 3;
export const MAX_FORECAST_DAYS = 16;
export const HOURLY_HOURS = 48;

export const CoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const WeatherInputSchema = z.object({
  location: z
    .union([z.string().trim().min(1).max(120), CoordinatesSchema])
    .describe("A place name ('Paris', 'Paris, FR', a postcode) or {latitude, longitude}."),
  days: z.number().int().min(1).max(MAX_FORECAST_DAYS).default(DEFAULT_FORECAST_DAYS).describe("Forecast days, 1 to 16."),
  units: WeatherUnitsSchema.default("metric").describe("metric: °C, km/h, mm. imperial: °F, mph, inch."),
  hourly: z.boolean().default(false).describe("Also return the next 48 hours hour by hour."),
});
export type WeatherInput = z.input<typeof WeatherInputSchema>;

export const WeatherLocationSchema = z.object({
  name: z.string(),
  country: z.string().optional(),
  admin1: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
});

export const CurrentWeatherSchema = z.object({
  time: z.string(),
  temperature: z.number(),
  apparent_temperature: z.number(),
  humidity_pct: z.number(),
  wind_speed: z.number(),
  wind_direction_deg: z.number(),
  precipitation: z.number(),
  weather_code: z.number().int(),
  condition: z.string(),
  is_day: z.boolean(),
});

export const DailyWeatherSchema = z.object({
  date: z.string(),
  temp_max: z.number(),
  temp_min: z.number(),
  precipitation_sum: z.number(),
  precipitation_probability_max: z.number().optional(),
  wind_speed_max: z.number(),
  sunrise: z.string(),
  sunset: z.string(),
  weather_code: z.number().int(),
  condition: z.string(),
  uv_index_max: z.number().optional(),
});

export const HourlyWeatherSchema = z.object({
  time: z.string(),
  temperature: z.number(),
  precipitation_probability: z.number().optional(),
  precipitation: z.number(),
  weather_code: z.number().int(),
  condition: z.string(),
  wind_speed: z.number(),
});

export const WeatherOutputSchema = z.object({
  location: WeatherLocationSchema,
  current: CurrentWeatherSchema,
  daily: z.array(DailyWeatherSchema).min(1).max(MAX_FORECAST_DAYS),
  hourly: z.array(HourlyWeatherSchema).max(HOURLY_HOURS).optional(),
  units: z.object({
    temperature: z.enum(["°C", "°F"]),
    wind_speed: z.enum(["km/h", "mph"]),
    precipitation: z.enum(["mm", "inch"]),
  }),
  source: z.literal("open_meteo"),
  fetched_at: z.string(),
  caveats: z.array(z.string()),
});
export type WeatherOutput = z.infer<typeof WeatherOutputSchema>;
