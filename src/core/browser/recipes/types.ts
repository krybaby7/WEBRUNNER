import type { Page } from "playwright";
import type { z } from "zod";
import type { Logger } from "../../../log.js";
import type { HandoffReason } from "../../../schemas/handoff.js";
import type { CostMeter } from "../../llm/cost.js";
import type { LlmClient } from "../../llm/types.js";

/**
 * Recipe framework, PLAN.md section 4.5.
 *
 * A recipe knows how to drive one site: navigate, wait, then hand the page's
 * text to the LLM with the result schema (schema-driven extraction is DECIDED,
 * so recipes survive page redesigns).
 */
export interface Recipe<TParams, TResult> {
  /** Stable site id, for example "google_flights". */
  readonly site: string;
  readonly paramsSchema: z.ZodType<TParams>;
  readonly resultSchema: z.ZodType<TResult>;
  /** Direct-URL shortcut when the site accepts the query in the URL. Null when it cannot. */
  buildUrl?(params: TParams): string | null;
  run(page: Page, params: TParams, ctx: RecipeContext): Promise<TResult>;
}

export interface RecipeContext {
  llm: LlmClient;
  log: Logger;
  /** Epoch milliseconds. The recipe must finish, or throw a `timeout` RecipeError, by then. */
  deadline: number;
  /** Budget meter shared with the caller, passed as `meter` on every LLM call. */
  meter?: CostMeter;
  /** Cancels the run (for example when the tool call is aborted). */
  signal?: AbortSignal;
  /**
   * Sink for things the caller should tell the user, for example "a consent
   * dialog was dismissed" or "more flights were not expanded". The recipe pushes
   * short plain-English sentences; the caller dedupes and surfaces them.
   */
  caveats?: string[];
  /**
   * Hand the page to the owner (PLAN.md 16.4). Present only when the hosting tool supports
   * handoff and a human can see the window. Parks the page with `reason` and `whatToDo`, then
   * waits up to the host's budget for the wall to clear: "cleared" means navigate again and
   * re-probe; "timeout" means throw the wall as `RecipeError("blocked", ..., { wall: reason })`.
   * In the original tool call the budget is 0, so the recipe sees "timeout" and the tool
   * returns `paused` instead of `blocked`. `step` names where the recipe stopped.
   */
  pause?(reason: HandoffReason, whatToDo: string, step: string): Promise<"cleared" | "timeout">;
}

export type RecipeErrorCode = "blocked" | "timeout" | "provider" | "invalid_input" | "config";

export interface RecipeErrorOptions {
  retryable?: boolean;
  /** The site wants a logged-in session (PLAN.md 14.8). The owning tool reports `needs_login` and names the `accounts` tool. */
  needsLogin?: boolean;
  /** What kind of wall a `blocked` error is, when a human could clear it (PLAN.md 16.4). Absent for IP-level refusals. */
  wall?: HandoffReason;
  cause?: unknown;
}

/** Failure of a recipe. `code` maps onto the tool error envelope (PLAN.md 3.6). */
export class RecipeError extends Error {
  readonly code: RecipeErrorCode;
  readonly retryable: boolean;
  readonly needsLogin: boolean;
  readonly wall: HandoffReason | undefined;

  constructor(code: RecipeErrorCode, message: string, options: RecipeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RecipeError";
    this.code = code;
    this.retryable = options.retryable ?? (code === "timeout" || code === "provider");
    this.needsLogin = options.needsLogin ?? false;
    this.wall = options.wall;
  }
}
