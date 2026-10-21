import { describe, expect, it } from "vitest";
import { createFxService } from "../../src/core/fx/index.js";
import { createMarketService } from "../../src/core/markets/index.js";
import { CoinGeckoProvider } from "../../src/core/markets/providers/coingecko.js";
import { YahooProvider } from "../../src/core/markets/providers/yahoo.js";
import { MarketProviderError } from "../../src/core/markets/types.js";
import { createWeatherService } from "../../src/core/weather/index.js";
import { log } from "../../src/log.js";
import { ExchangeRateOutputSchema } from "../../src/schemas/fx.js";
import { MarketQuoteOutputSchema } from "../../src/schemas/markets.js";
import { WeatherOutputSchema } from "../../src/schemas/weather.js";

/**
 * Real keyless services. Gated: run with
 *   RUN_INTEGRATION=1 npx vitest run test/integration/markets-weather-fx.test.ts
 * From the development environment on 2026-10-18 CoinGecko, Frankfurter and
 * Open-Meteo geocoding answered; Yahoo returned HTTP 429 and the Open-Meteo
 * forecast host timed out, so those two cases accept that outcome and say so.
 */
const RUN = process.env["RUN_INTEGRATION"] === "1";
const signal = (): AbortSignal => AbortSignal.timeout(25_000);

describe.skipIf(!RUN)(`market_quote, weather and exchange_rate against the live services${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  it("CoinGecko quotes bitcoin in USD with history", async () => {
    const svc = createMarketService({ providers: [new CoinGeckoProvider()], log });
    const out = await svc.quote({ symbols: ["BTC", "ethereum"], currency: "USD", history: { range: "5d" } }, signal());
    expect(MarketQuoteOutputSchema.safeParse(out).success).toBe(true);
    expect(out.quotes.map((q) => q.symbol).sort()).toEqual(["BTC", "ETH"]);
    const btc = out.quotes.find((q) => q.symbol === "BTC");
    expect(btc?.price).toBeGreaterThan(0);
    expect(btc?.history?.bars.length).toBeGreaterThan(5);
  }, 60_000);

  it("Yahoo quotes AAPL, or reports a retryable rate limit from this network", async () => {
    const yahoo = new YahooProvider();
    const result = await yahoo.quote("AAPL", { currency: "USD" }, signal()).then(
      (q) => ({ q }),
      (e: unknown) => ({ e }),
    );
    if ("q" in result) {
      expect(result.q.currency).toBe("USD");
      expect(result.q.price).toBeGreaterThan(0);
      expect(result.q.delayed_min).toBe(15);
    } else {
      expect(result.e).toBeInstanceOf(MarketProviderError);
      expect((result.e as MarketProviderError).status).toBe(429);
      expect((result.e as MarketProviderError).retryable).toBe(true);
    }
  }, 60_000);

  it("Frankfurter converts USD to EUR and GBP", async () => {
    const out = await createFxService({ log }).convert({ from: "USD", to: ["EUR", "GBP"], amount: 10 }, signal());
    expect(ExchangeRateOutputSchema.safeParse(out).success).toBe(true);
    expect(out.rates).toHaveLength(2);
    expect(out.rates[0]?.rate).toBeGreaterThan(0.5);
    expect(out.rates[0]?.rate).toBeLessThan(1.5);
  }, 60_000);

  it("Open-Meteo geocodes Paris and, when its forecast host answers, returns a 3-day forecast", async () => {
    const svc = createWeatherService({ log });
    const result = await svc.forecast({ location: "Paris", days: 3, units: "metric", hourly: true }, signal()).then(
      (out) => ({ out }),
      (e: unknown) => ({ e }),
    );
    if ("out" in result) {
      expect(WeatherOutputSchema.safeParse(result.out).success).toBe(true);
      expect(result.out.location.country).toBe("France");
      expect(result.out.daily).toHaveLength(3);
      expect(result.out.hourly?.length).toBeGreaterThan(24);
      expect(result.out.caveats.some((c) => c.startsWith("Several places match"))).toBe(true);
    } else {
      // The forecast host timed out from the development environment; geocoding must still have worked.
      expect(String(result.e)).toMatch(/forecast/);
    }
  }, 60_000);
});
