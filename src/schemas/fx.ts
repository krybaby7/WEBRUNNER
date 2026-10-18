import { z } from "zod";
import { CurrencyCodeSchema, DateStringSchema } from "./flights.js";

/** `exchange_rate` input and output, PLAN.md section 14.4. Owned by WP15, consumed by WP20. */

export const MAX_TARGET_CURRENCIES = 20;
/** Frankfurter's history starts on the first ECB reference date. */
export const EARLIEST_RATE_DATE = "1999-01-04";

const CurrencyInput = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter ISO 4217 code, for example USD" });

export const ExchangeRateInputSchema = z.object({
  from: CurrencyInput.describe("Base currency, ISO 4217."),
  to: z.array(CurrencyInput).min(1).max(MAX_TARGET_CURRENCIES).describe("Target currencies, ISO 4217."),
  amount: z.number().positive().default(1).describe("Amount in the base currency to convert; default 1."),
  date: DateStringSchema.optional().describe(`Historical reference date, YYYY-MM-DD, ${EARLIEST_RATE_DATE} or later. Default: latest.`),
});
export type ExchangeRateInput = z.input<typeof ExchangeRateInputSchema>;

export const ExchangeRateOutputSchema = z.object({
  base: CurrencyCodeSchema,
  date: DateStringSchema,
  amount: z.number().positive(),
  rates: z.array(z.object({ currency: CurrencyCodeSchema, rate: z.number().positive(), converted: z.number() })).min(1),
  source: z.literal("frankfurter"),
  fetched_at: z.string(),
  caveats: z.array(z.string()),
});
export type ExchangeRateOutput = z.infer<typeof ExchangeRateOutputSchema>;
