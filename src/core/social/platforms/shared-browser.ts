import type { Page } from "playwright";
import { log as defaultLog, type Logger } from "../../../log.js";
import type { SocialItem, SocialPlatform, SocialSearchQuery } from "../../../schemas/social.js";
import { RecipeError } from "../../browser/recipes/types.js";
import type { SocialRecipe } from "../../browser/recipes/social-common.js";
import type { BrowserSession } from "../../browser/types.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "../../llm/types.js";
import { SocialProviderError, type SocialHooks, type SocialPlatformProvider, type SocialProviderErrorCode } from "../types.js";

/**
 * Common base of the browser social platforms (PLAN.md 14.5, 14.8; WP18b).
 * Acquires a page from the shared session, runs the platform's recipe under a
 * per-call deadline, closes the page on abort, passes caveats and the cost
 * meter through the hooks, and maps `RecipeError` (with `needsLogin`) and
 * `LlmError` onto `SocialProviderError`.
 */

/** Default time budget for one browser platform call, PLAN.md 14.5 ("60 s for browser platforms"). */
export const BROWSER_SOCIAL_DEFAULT_TIMEOUT_MS = 60_000;

export interface BrowserSocialProviderOptions {
  /** Shared browser session. Without it the provider is not configured. */
  browser?: BrowserSession;
  /** Used by recipes that extract with the model. Without it those paths fail with code `config`. */
  llm?: LlmClient;
  /** Whole-call budget in ms. Default 60000. */
  timeoutMs?: number;
  log?: Logger;
}

/** An LlmClient that refuses every call with a `config` error naming the key. Used when no client was configured. */
export function unavailableLlm(platform: string): LlmClient {
  return {
    complete(_req: LlmRequest): Promise<LlmResponse> {
      return Promise.reject(
        new LlmError("config", "not_configured", `${platform} extraction needs the Claude API; set ANTHROPIC_API_KEY`, { retryable: false }),
      );
    },
  };
}

export abstract class BrowserSocialProvider implements SocialPlatformProvider {
  abstract readonly name: SocialPlatform;
  readonly access = "browser" as const;
  protected readonly browser: BrowserSession | undefined;
  protected readonly llm: LlmClient | undefined;
  protected readonly timeoutMs: number;
  protected readonly log: Logger;
  protected readonly recipe: SocialRecipe;
  /** Human name for messages, e.g. "X". */
  protected abstract readonly siteName: string;
  /** True when the recipe cannot do anything without the model (Facebook). */
  protected readonly requiresLlm: boolean = false;

  protected constructor(recipe: SocialRecipe, options: BrowserSocialProviderOptions) {
    this.recipe = recipe;
    this.browser = options.browser;
    this.llm = options.llm;
    this.timeoutMs = options.timeoutMs ?? BROWSER_SOCIAL_DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? defaultLog;
  }

  isConfigured(): boolean {
    return this.browser !== undefined;
  }

  abstract ownsUrl(url: string): boolean;

  search(q: SocialSearchQuery, signal: AbortSignal, hooks: SocialHooks = {}): Promise<SocialItem[]> {
    if (q.query === undefined) {
      return Promise.reject(this.error("search needs a query", "invalid_input", false));
    }
    return this.run({ ...q, mode: "search" }, signal, hooks, (items) => items.slice(0, q.per_platform));
  }

  thread(url: string, q: SocialSearchQuery, signal: AbortSignal, hooks: SocialHooks = {}): Promise<SocialItem[]> {
    if (!this.ownsUrl(url)) {
      return Promise.reject(this.error(`${url} is not a ${this.siteName} post or thread URL`, "invalid_input", false));
    }
    // The post first, then at most per_platform comments.
    return this.run({ ...q, mode: "thread", url, kind: "comments" }, signal, hooks, (items) => {
      const post = items.find((i) => i.kind === "post");
      const comments = items.filter((i) => i.kind !== "post").slice(0, q.per_platform);
      return post === undefined ? comments : [post, ...comments];
    });
  }

  private async run(
    params: SocialSearchQuery,
    signal: AbortSignal,
    hooks: SocialHooks,
    finish: (items: SocialItem[]) => SocialItem[],
  ): Promise<SocialItem[]> {
    const browser = this.browser;
    if (browser === undefined) throw this.error("no browser session is available", "config", false);
    if (this.requiresLlm && this.llm === undefined) {
      throw this.error(`the LLM client is not available; ${this.siteName} extraction needs ANTHROPIC_API_KEY`, "config", false);
    }
    if (signal.aborted) throw this.error(`${this.siteName} call aborted before it started`, "timeout", true);

    let page: Page;
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
    const surface = (): void => {
      if (hooks.caveats !== undefined) for (const c of caveats) if (!hooks.caveats.includes(c)) hooks.caveats.push(c);
    };
    try {
      const items = await this.recipe.run(acquired, params, {
        llm: this.llm ?? unavailableLlm(this.siteName),
        log: this.log,
        deadline: Date.now() + this.timeoutMs,
        signal,
        caveats,
        ...(hooks.meter !== undefined && { meter: hooks.meter }),
      });
      surface();
      return finish(items);
    } catch (err) {
      surface();
      throw this.mapError(err, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.release(acquired);
    }
  }

  private mapError(err: unknown, signal: AbortSignal): SocialProviderError {
    if (err instanceof SocialProviderError) return err;
    if (err instanceof RecipeError) {
      return new SocialProviderError(err.message, {
        platform: this.name,
        code: err.code,
        retryable: err.retryable,
        needsLogin: err.needsLogin,
        cause: err,
      });
    }
    if (err instanceof LlmError) {
      // budget_exceeded and internal have no social code: they surface as a non-retryable provider error with the original message.
      const code: SocialProviderErrorCode = err.code === "config" ? "config" : err.code === "timeout" ? "timeout" : "provider";
      return this.error(err.message, code, code === "provider" ? false : err.retryable, err);
    }
    if (signal.aborted) return this.error(`${this.siteName} call was cancelled or timed out`, "timeout", true, err);
    return this.error(`${this.siteName} call failed: ${message(err)}`, "provider", false, err);
  }

  protected error(text: string, code: SocialProviderErrorCode, retryable: boolean, cause?: unknown): SocialProviderError {
    return new SocialProviderError(text, {
      platform: this.name,
      code,
      retryable,
      ...(cause !== undefined && { cause }),
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
