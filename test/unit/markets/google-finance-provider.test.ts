import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { GoogleFinanceNotFoundError, type GoogleFinanceParams, type GoogleFinanceQuote } from "../../../src/core/browser/recipes/google-finance.js";
import { RecipeError, type Recipe, type RecipeContext } from "../../../src/core/browser/recipes/types.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { LlmError } from "../../../src/core/llm/types.js";
import { assetTypeForExchange, GoogleFinanceProvider } from "../../../src/core/markets/providers/google-finance.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import { MarketQuoteSchema } from "../../../src/schemas/markets.js";
import { BASE_OPTS, makeLogger, signal } from "./helpers.js";

const FOUND: GoogleFinanceQuote = {
  symbol: "VOD", exchange: "LON", name: "Vodafone Group plc", currency: "GBX", price: 120.79, change: 0.59, change_pct: 0.49, previous_close: 120.2,
  open: 119.5, day_high: 122.1, day_low: 119.4, volume: 84_400_000, market_cap: 37.57e9, week52_high: 132.07, week52_low: 85.06,
  as_of: "2026-10-16T16:00:13.000Z", extracted_by: "dom", url: "https://www.google.com/finance/quote/VOD:LON?hl=en",
};

function fakeBrowser() {
  const page = { close: vi.fn(async () => undefined) } as unknown as Page;
  const browser: BrowserSession = {
    acquire: vi.fn(async () => page),
    release: vi.fn(async () => undefined),
    close: async () => undefined,
    isOpen: () => true,
    stats: () => ({ mode: "persistent", open: true, closed: false, headless: true, activePages: 0, waiting: 0, maxPages: 3, totalAcquired: 1 }),
    cookies: async () => [],
    clearCookies: async () => 0,
    openUnpooledPage: async () => page,
  };
  return { page, browser };
}

function recipeOf(run: (page: Page, params: GoogleFinanceParams, ctx: RecipeContext) => Promise<GoogleFinanceQuote>): Recipe<GoogleFinanceParams, GoogleFinanceQuote> {
  return { site: "google_finance", paramsSchema: {} as never, resultSchema: {} as never, run };
}

describe("google finance provider", () => {
  it("is configured only with a browser and fails with config without one", async () => {
    expect(new GoogleFinanceProvider().isConfigured()).toBe(false);
    const err = await new GoogleFinanceProvider().quote("AAPL", BASE_OPTS, signal()).catch((e: unknown) => e);
    expect((err as MarketProviderError).code).toBe("config");
  });

  it("maps the recipe result to a MarketQuote, adds the GBX caveat through hooks and releases the page", async () => {
    const { page, browser } = fakeBrowser();
    const run = vi.fn(async (_page: Page, _params: GoogleFinanceParams, _ctx: RecipeContext) => FOUND);
    const p = new GoogleFinanceProvider({ browser, recipe: recipeOf(run), logger: makeLogger(), timeoutMs: 5000 });
    const caveats: string[] = [];
    const q = await p.quote("VOD.L", BASE_OPTS, signal(), { caveats });
    expect(MarketQuoteSchema.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({ requested: "VOD.L", symbol: "VOD", exchange: "LON", asset_type: "stock", currency: "GBX", price: 120.79, previous_close: 120.2, as_of: "2026-10-16T16:00:13.000Z", source: "google_finance" });
    expect(q.delayed_min).toBeUndefined();
    expect(caveats).toEqual(["GBX is pence sterling (1/100 GBP), as Google Finance quotes London listings."]);
    expect(run.mock.calls[0]?.[1]).toEqual({ symbol: "VOD.L" });
    const ctx = run.mock.calls[0]?.[2] as RecipeContext;
    expect(ctx.deadline).toBeGreaterThan(Date.now());
    expect(ctx.deadline).toBeLessThanOrEqual(Date.now() + 5000);
    expect(browser.release).toHaveBeenCalledWith(page);
  });

  it("maps recipe outcomes to provider codes", async () => {
    const { browser } = fakeBrowser();
    const mk = (err: unknown) => new GoogleFinanceProvider({ browser, recipe: recipeOf(() => Promise.reject(err)), logger: makeLogger() });
    const code = async (err: unknown) => ((await mk(err).quote("X", BASE_OPTS, signal()).catch((e: unknown) => e)) as MarketProviderError).code;
    expect(await code(new GoogleFinanceNotFoundError("none"))).toBe("not_found");
    expect(await code(new RecipeError("blocked", "wall"))).toBe("blocked");
    expect(await code(new RecipeError("timeout", "slow"))).toBe("timeout");
    expect(await code(new LlmError("config", "not_configured", "no key", { retryable: false }))).toBe("provider");
    expect(await code(new Error("kaboom"))).toBe("provider");
    expect(browser.release).toHaveBeenCalledTimes(5);
  });

  it("fills as_of with now when the page gave no timestamp and types exchanges", async () => {
    const { browser } = fakeBrowser();
    const { as_of: _omit, ...noTime } = FOUND;
    const p = new GoogleFinanceProvider({ browser, recipe: recipeOf(async () => ({ ...noTime, exchange: "INDEXSP", symbol: ".INX", currency: "USD" })), logger: makeLogger() });
    const q = await p.quote("^GSPC", BASE_OPTS, signal());
    expect(q.asset_type).toBe("index");
    expect(Date.now() - Date.parse(q.as_of)).toBeLessThan(5000);
    expect(assetTypeForExchange("NYSEARCA")).toBe("etf");
    expect(assetTypeForExchange("NASDAQ")).toBe("stock");
  });

  it("closes the page when the signal aborts", async () => {
    const { page, browser } = fakeBrowser();
    const ac = new AbortController();
    const run = (_page: Page, _params: GoogleFinanceParams, ctx: RecipeContext): Promise<GoogleFinanceQuote> =>
      new Promise((_r, reject) => {
        const closed = (): void => reject(new Error("Target page, context or browser has been closed"));
        if (ctx.signal?.aborted) closed();
        else ctx.signal?.addEventListener("abort", closed, { once: true });
      });
    const p = new GoogleFinanceProvider({ browser, recipe: recipeOf(run), logger: makeLogger() });
    const pending = p.quote("AAPL", BASE_OPTS, ac.signal).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 20);
    const err = (await pending) as MarketProviderError;
    expect(err.code).toBe("timeout");
    expect(page.close).toHaveBeenCalled();
  });
});
