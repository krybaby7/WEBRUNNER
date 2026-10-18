import { googleFlightsRecipe } from "../../browser/recipes/google-flights.js";
import { RecipeError, type Recipe } from "../../browser/recipes/types.js";
import type { BrowserSession } from "../../browser/types.js";
import type { CostMeter } from "../../llm/cost.js";
import { LlmError, type LlmClient } from "../../llm/types.js";
import { log as defaultLog, type Logger } from "../../../log.js";
import { MAX_OFFERS, type FlightOffer, type NormalizedFlightsQuery } from "../../../schemas/flights.js";
import { FlightProviderError, type FlightProvider } from "../types.js";

/** Default time budget for one Google Flights search, page load and extraction included. */
export const GOOGLE_FLIGHTS_DEFAULT_TIMEOUT_MS = 60_000;

export interface GoogleFlightsProviderOptions {
  /** Shared browser session. Without it the provider is not configured. */
  browser?: BrowserSession;
  /** Used by the recipe for extraction. Without it `search` fails with code `config`. */
  llm?: LlmClient;
  /** For tests. Defaults to the live Google Flights recipe. */
  recipe?: Recipe<NormalizedFlightsQuery, FlightOffer[]>;
  /** Whole-search budget in ms. Default 60000. */
  timeoutMs?: number;
  logger?: Logger;
  /** Cost meter for the extraction call. */
  meter?: CostMeter;
}

/**
 * Optional third argument of `GoogleFlightsProvider.search`: a sink for the
 * recipe's user-facing notes (consent dialog dismissed, more flights not
 * expanded, ...). `search_flights` passes one and turns the notes into caveats.
 */
export interface SearchHooks {
  caveats?: string[];
}

/** Google Flights through a real browser and the recipe in `core/browser/recipes/google-flights.ts`. */
export class GoogleFlightsProvider implements FlightProvider {
  readonly name = "google_flights" as const;
  private readonly browser: BrowserSession | undefined;
  private readonly llm: LlmClient | undefined;
  private readonly recipe: Recipe<NormalizedFlightsQuery, FlightOffer[]>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly meter: CostMeter | undefined;

  constructor(options: GoogleFlightsProviderOptions = {}) {
    this.browser = options.browser;
    this.llm = options.llm;
    this.recipe = options.recipe ?? googleFlightsRecipe;
    this.timeoutMs = options.timeoutMs ?? GOOGLE_FLIGHTS_DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? defaultLog;
    this.meter = options.meter;
  }

  isConfigured(): boolean {
    return this.browser !== undefined;
  }

  async search(query: NormalizedFlightsQuery, signal: AbortSignal, hooks: SearchHooks = {}): Promise<FlightOffer[]> {
    const browser = this.browser;
    if (browser === undefined) {
      throw this.error("no browser session is available", "config", false);
    }
    const llm = this.llm;
    if (llm === undefined) {
      throw this.error("the LLM client is not available; Google Flights extraction needs ANTHROPIC_API_KEY", "config", false);
    }
    if (signal.aborted) throw this.error("Google Flights search aborted before it started", "timeout", true);

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
    try {
      const offers = await this.recipe.run(acquired, query, {
        llm,
        log: this.logger,
        deadline: Date.now() + this.timeoutMs,
        signal,
        caveats,
        ...(this.meter !== undefined && { meter: this.meter }),
      });
      if (hooks.caveats !== undefined) for (const c of caveats) if (!hooks.caveats.includes(c)) hooks.caveats.push(c);
      return [...offers].sort((a, b) => a.price.amount - b.price.amount).slice(0, MAX_OFFERS);
    } catch (err) {
      if (hooks.caveats !== undefined) for (const c of caveats) if (!hooks.caveats.includes(c)) hooks.caveats.push(c);
      if (err instanceof RecipeError) {
        throw this.error(err.message, err.code, err.retryable, err);
      }
      if (err instanceof LlmError) throw err; // carries its own code
      if (signal.aborted) throw this.error("Google Flights search was cancelled or timed out", "timeout", true, err);
      throw this.error(`Google Flights search failed: ${message(err)}`, "provider", false, err);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.release(acquired);
    }
  }

  private error(
    text: string,
    code: FlightProviderError["code"],
    retryable: boolean,
    cause?: unknown,
  ): FlightProviderError {
    return new FlightProviderError(text, {
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
