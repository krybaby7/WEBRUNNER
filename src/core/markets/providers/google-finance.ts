import {
  GoogleFinanceNotFoundError,
  googleFinanceRecipe,
  type GoogleFinanceParams,
  type GoogleFinanceQuote,
} from "../../browser/recipes/google-finance.js";
import { RecipeError, type Recipe } from "../../browser/recipes/types.js";
import type { BrowserSession } from "../../browser/types.js";
import type { CostMeter } from "../../llm/cost.js";
import { LlmError, type LlmClient } from "../../llm/types.js";
import { log as defaultLog, type Logger } from "../../../log.js";
import { MarketQuoteSchema, type AssetType, type MarketQuote } from "../../../schemas/markets.js";
import { MarketProviderError, type MarketProvider, type QuoteOptions } from "../types.js";

/** Default time budget for one Google Finance quote, page load included. */
export const GOOGLE_FINANCE_DEFAULT_TIMEOUT_MS = 10_000;

export interface GoogleFinanceProviderOptions {
  /** Shared browser session. Without it the provider is not configured. */
  browser?: BrowserSession;
  /** Optional: enables the LLM fallback when the DOM probe cannot read the quote. */
  llm?: LlmClient;
  /** For tests. Defaults to the live recipe. */
  recipe?: Recipe<GoogleFinanceParams, GoogleFinanceQuote>;
  /** Whole-quote budget in ms. Default 10000. */
  timeoutMs?: number;
  logger?: Logger;
  meter?: CostMeter;
}

/** Optional fourth argument of `quote`: a sink for user-facing notes (consent dismissed, LLM used, GBX pence). */
export interface QuoteHooks {
  caveats?: string[];
}

/** An LlmClient stand-in for when ANTHROPIC_API_KEY is unset: the recipe's fallback then fails with code `config`. */
const noLlm: LlmClient = {
  complete: () =>
    Promise.reject(
      new LlmError("config", "not_configured", "the LLM client is not available (ANTHROPIC_API_KEY unset); the Google Finance page could not be read without it", {
        retryable: false,
      }),
    ),
};

/** Google exchange code to the shared asset type: indices are recognisable, equities and ETFs are not told apart. */
export function assetTypeForExchange(exchange: string): AssetType {
  if (/^INDEX/i.test(exchange)) return "index";
  if (/^(NYSEARCA|BATS)$/i.test(exchange)) return "etf";
  return "stock";
}

/** Google Finance through a real browser and the recipe in `core/browser/recipes/google-finance.ts`. Quote only. */
export class GoogleFinanceProvider implements MarketProvider {
  readonly name = "google_finance" as const;
  readonly assetTypes = ["stock", "etf", "index"] as const;
  private readonly browser: BrowserSession | undefined;
  private readonly llm: LlmClient | undefined;
  private readonly recipe: Recipe<GoogleFinanceParams, GoogleFinanceQuote>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly meter: CostMeter | undefined;

  constructor(options: GoogleFinanceProviderOptions = {}) {
    this.browser = options.browser;
    this.llm = options.llm;
    this.recipe = options.recipe ?? googleFinanceRecipe;
    this.timeoutMs = options.timeoutMs ?? GOOGLE_FINANCE_DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? defaultLog;
    this.meter = options.meter;
  }

  isConfigured(): boolean {
    return this.browser !== undefined;
  }

  async quote(symbol: string, _opts: QuoteOptions, signal: AbortSignal, hooks: QuoteHooks = {}): Promise<MarketQuote> {
    const browser = this.browser;
    if (browser === undefined) throw this.error("no browser session is available", "config", false);
    if (signal.aborted) throw this.error("Google Finance quote aborted before it started", "timeout", true);

    let page;
    try {
      page = await browser.acquire();
    } catch (err) {
      throw this.error(`could not open a browser page: ${message(err)}`, "provider", true, err);
    }
    const acquired = page;
    const onAbort = (): void => {
      acquired.close().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const caveats: string[] = [];
    const drain = (): void => {
      if (hooks.caveats !== undefined) for (const c of caveats) if (!hooks.caveats.includes(c)) hooks.caveats.push(c);
    };
    try {
      const found = await this.recipe.run(
        acquired,
        { symbol },
        {
          llm: this.llm ?? noLlm,
          log: this.logger,
          deadline: Date.now() + this.timeoutMs,
          signal,
          caveats,
          ...(this.meter !== undefined && { meter: this.meter }),
        },
      );
      if (found.currency === "GBX") caveats.push("GBX is pence sterling (1/100 GBP), as Google Finance quotes London listings.");
      drain();
      return this.toMarketQuote(symbol, found);
    } catch (err) {
      drain();
      if (err instanceof GoogleFinanceNotFoundError) throw this.error(err.message, "not_found", false, err);
      if (err instanceof RecipeError) throw this.error(err.message, err.code, err.retryable, err);
      if (err instanceof LlmError) {
        // The LLM is optional here: its absence or failure is a provider failure, not a tool-wide config error.
        throw this.error(`the Google Finance page could not be read deterministically and the LLM fallback failed: ${err.message}`, "provider", err.retryable, err);
      }
      if (signal.aborted) throw this.error("Google Finance quote was cancelled or timed out", "timeout", true, err);
      throw this.error(`Google Finance quote failed: ${message(err)}`, "provider", false, err);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.release(acquired);
    }
  }

  private toMarketQuote(requested: string, q: GoogleFinanceQuote): MarketQuote {
    const quote: MarketQuote = {
      requested,
      symbol: q.symbol,
      ...(q.name !== undefined && { name: q.name }),
      asset_type: assetTypeForExchange(q.exchange),
      exchange: q.exchange,
      currency: q.currency,
      price: q.price,
      ...(q.previous_close !== undefined && { previous_close: q.previous_close }),
      ...(q.change !== undefined && { change: q.change }),
      ...(q.change_pct !== undefined && { change_pct: q.change_pct }),
      ...(q.open !== undefined && { open: q.open }),
      ...(q.day_high !== undefined && { day_high: q.day_high }),
      ...(q.day_low !== undefined && { day_low: q.day_low }),
      ...(q.volume !== undefined && { volume: q.volume }),
      ...(q.market_cap !== undefined && { market_cap: q.market_cap }),
      ...(q.week52_high !== undefined && { week52_high: q.week52_high }),
      ...(q.week52_low !== undefined && { week52_low: q.week52_low }),
      ...(q.market_state !== undefined && { market_state: q.market_state }),
      as_of: q.as_of ?? new Date().toISOString(),
      ...(q.delayed_min !== undefined && { delayed_min: q.delayed_min }),
      source: this.name,
    };
    const checked = MarketQuoteSchema.safeParse(quote);
    if (!checked.success) {
      throw this.error(`Google Finance data for "${requested}" did not fit the quote schema (${checked.error.issues[0]?.message ?? "invalid"})`, "provider", false);
    }
    return checked.data;
  }

  private error(text: string, code: MarketProviderError["code"], retryable: boolean, cause?: unknown): MarketProviderError {
    return new MarketProviderError(text, { provider: this.name, code, retryable, ...(cause !== undefined && { cause }) });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
