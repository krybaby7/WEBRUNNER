import type { SocialItem, SocialPlatform, SocialSearchQuery } from "../../schemas/social.js";
import type { CostMeter } from "../llm/cost.js";

export type { SocialItem, SocialPlatform, SocialSearchQuery };

/** Caveat sink and shared LLM budget, PLAN.md 14.8. */
export interface SocialHooks {
  caveats?: string[];
  meter?: CostMeter;
}

/**
 * One social platform, PLAN.md 14.5 and 14.8. `search` returns at most
 * `q.per_platform` items validated by `SocialItemSchema`, tagged
 * `platform: name`, in the platform's own order. `thread` returns a thread's
 * post (first, `kind: "post"`) followed by its comments. Browser platforms
 * only navigate, scroll and read; they never type, log in or interact.
 * Failures are `SocialProviderError`; a login wall sets `needsLogin`.
 */
export interface SocialPlatformProvider {
  readonly name: SocialPlatform;
  readonly access: "api" | "browser";
  isConfigured(): boolean;
  /** True when `url` is a post, thread or video on this platform. */
  ownsUrl(url: string): boolean;
  search(q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]>;
  thread(url: string, q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]>;
}

export type SocialProviderErrorCode = "provider" | "timeout" | "config" | "blocked" | "invalid_input";

export interface SocialProviderErrorOptions {
  platform: SocialPlatform;
  code: SocialProviderErrorCode;
  retryable: boolean;
  /** The platform wants a logged-in session; the tool reports `needs_login: true` and names the `accounts` tool. */
  needsLogin?: boolean;
  status?: number;
  cause?: unknown;
}

/** Failure of a social platform. `code` maps onto the error envelope (PLAN.md 3.6). */
export class SocialProviderError extends Error {
  readonly platform: SocialPlatform;
  readonly code: SocialProviderErrorCode;
  readonly retryable: boolean;
  readonly needsLogin: boolean;
  readonly status?: number;

  constructor(message: string, options: SocialProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SocialProviderError";
    this.platform = options.platform;
    this.code = options.code;
    this.retryable = options.retryable;
    this.needsLogin = options.needsLogin ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}
