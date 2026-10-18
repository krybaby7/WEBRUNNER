import { googleHotelsRecipe, missingLlmClient } from "../../browser/recipes/google-hotels.js";
import { RecipeError, type Recipe } from "../../browser/recipes/types.js";
import type { BrowserSession } from "../../browser/types.js";
import type { CostMeter } from "../../llm/cost.js";
import { LlmError, type LlmClient } from "../../llm/types.js";
import { log as defaultLog, type Logger } from "../../../log.js";
import type { HotelResult, NormalizedHotelsQuery } from "../../../schemas/hotels.js";
import { HotelProviderError, type HotelProvider, type HotelSearchHooks } from "../types.js";

/** Default time budget for one Google Hotels search, page load and extraction included (PLAN.md 14.1: 90 s). */
export const GOOGLE_HOTELS_DEFAULT_TIMEOUT_MS = 90_000;

export interface GoogleHotelsProviderOptions {
  /** Shared browser session. Without it the provider is not configured. */
  browser?: BrowserSession;
  /**
   * Used by the recipe only when the deterministic DOM probe fails. Without it
   * the recipe still works keyless on a recognised page and fails with code
   * `config` (naming ANTHROPIC_API_KEY) otherwise.
   */
  llm?: LlmClient;
  /** For tests. Defaults to the live Google Hotels recipe. */
  recipe?: Recipe<NormalizedHotelsQuery, HotelResult[]>;
  /** Whole-search budget in ms. Default 90000. */
  timeoutMs?: number;
  logger?: Logger;
  /** Cost meter for the extraction call; a meter in the search hooks takes precedence. */
  meter?: CostMeter;
}

/** Google Hotels through a real browser and the recipe in `core/browser/recipes/google-hotels.ts`. */
export class GoogleHotelsProvider implements HotelProvider {
  readonly name = "google_hotels" as const;
  private readonly browser: BrowserSession | undefined;
  private readonly llm: LlmClient | undefined;
  private readonly recipe: Recipe<NormalizedHotelsQuery, HotelResult[]>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly meter: CostMeter | undefined;

  constructor(options: GoogleHotelsProviderOptions = {}) {
    this.browser = options.browser;
    this.llm = options.llm;
    this.recipe = options.recipe ?? googleHotelsRecipe;
    this.timeoutMs = options.timeoutMs ?? GOOGLE_HOTELS_DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? defaultLog;
    this.meter = options.meter;
  }

  isConfigured(): boolean {
    return this.browser !== undefined;
  }

  async search(query: NormalizedHotelsQuery, signal: AbortSignal, hooks: HotelSearchHooks = {}): Promise<HotelResult[]> {
    const browser = this.browser;
    if (browser === undefined) {
      throw this.error("no browser session is available", "config", false);
    }
    if (signal.aborted) throw this.error("Google Hotels search aborted before it started", "timeout", true);

    let page;
    try {
      page = await browser.acquire();
    } catch (err) {
      throw this.error(`could not open a browser page: ${message(err)}`, "provider", true, err);
    }
    const acquired = page;
    // Closing the page makes every pending Playwright call reject promptly.
    const onAbort = (): void => {
      acquired.close().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const caveats: string[] = [];
    const meter = hooks.meter ?? this.meter;
    const pass = (): void => {
      if (hooks.caveats !== undefined) for (const c of caveats) if (!hooks.caveats.includes(c)) hooks.caveats.push(c);
    };
    try {
      const hotels = await this.recipe.run(acquired, query, {
        llm: this.llm ?? missingLlmClient(),
        log: this.logger,
        deadline: Date.now() + this.timeoutMs,
        signal,
        caveats,
        ...(meter !== undefined && { meter }),
      });
      pass();
      // Page order is kept (the tool sorts); the contract caps a provider at max_results.
      return hotels.slice(0, query.max_results);
    } catch (err) {
      pass();
      if (err instanceof RecipeError) {
        throw this.error(err.message, err.code, err.retryable, err);
      }
      if (err instanceof LlmError) throw err; // carries its own code
      if (signal.aborted) throw this.error("Google Hotels search was cancelled or timed out", "timeout", true, err);
      throw this.error(`Google Hotels search failed: ${message(err)}`, "provider", false, err);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.release(acquired);
    }
  }

  private error(text: string, code: HotelProviderError["code"], retryable: boolean, cause?: unknown): HotelProviderError {
    return new HotelProviderError(text, {
      provider: this.name,
      code,
      retryable,
      ...(cause !== undefined && { cause }),
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
