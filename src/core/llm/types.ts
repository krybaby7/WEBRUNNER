import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { CostMeter } from "./cost.js";

/** Model roles, PLAN.md section 4.6. */
export const ROLES = ["planner", "extractor", "scorer", "writer"] as const;
export type Role = (typeof ROLES)[number];

export type Effort = "low" | "medium" | "high" | "xhigh";

/** Token usage for one response. Cached tokens are reported separately from `inputTokens`. */
export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens: number;
}

export interface LlmRequest {
  role: Role;
  /** Stable system prompt. Sent as a cached block so repeated calls share the prefix. */
  system: string;
  messages: Anthropic.MessageParam[];
  /** Structured output: the response is constrained to this schema and validated against it. */
  schema?: z.ZodType;
  effort?: Effort;
  /** Defaults per role: 8192 for planner, scorer and extractor; 32000 for writer. */
  maxTokens?: number;
  /** Additive to the client-wide meter: also records this call, and blocks it when exhausted. */
  meter?: CostMeter;
  /** Cancels the request. Surfaces as an LlmError with code "timeout". */
  signal?: AbortSignal;
}

export interface LlmResponse {
  /** Concatenated text blocks. Present when the model produced text. */
  text?: string;
  /** Validated structured output. Present exactly when the request carried a schema. */
  parsed?: unknown;
  usage: Usage;
  costUsd: number;
  /** The model that served the response (differs from the routed model after a server-side fallback). */
  model: string;
  stopReason: string | null;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorCode = "config" | "provider" | "timeout" | "budget_exceeded" | "internal";
export type LlmErrorKind = "refusal" | "rate_limit" | "api" | "network" | "not_configured" | "schema";

export interface LlmErrorInit {
  retryable: boolean;
  details?: unknown;
  cause?: unknown;
}

/**
 * The only error type the LLM client throws for provider, config and budget
 * problems. `code` maps one-to-one onto the tool error envelope (PLAN.md 3.6),
 * so a tool can do `toolError(err.code, err.message, err.retryable, err.details)`.
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: LlmErrorCode, kind: LlmErrorKind, message: string, init: LlmErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "LlmError";
    this.code = code;
    this.kind = kind;
    this.retryable = init.retryable;
    if (init.details !== undefined) this.details = init.details;
  }
}
