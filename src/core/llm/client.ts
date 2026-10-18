import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Config } from "../../config.js";
import { log, type Logger } from "../../log.js";
import { computeCost, CostMeter } from "./cost.js";
import { resolveModel, ROLE_DEFAULTS } from "./models.js";
import {
  LlmError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type Usage,
} from "./types.js";

/** Beta flag that enables `fallbacks: "default"` (server-side refusal fallback). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Per-request timeout, in milliseconds (the TS SDK takes milliseconds). */
export const REQUEST_TIMEOUT_MS = 180_000;
export const MAX_RETRIES = 2;
/** Above this many output tokens the call is streamed to stay clear of HTTP timeouts. */
export const STREAM_THRESHOLD_TOKENS = 16_000;

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type RequestOpts = { signal?: AbortSignal };

/** The slice of the Anthropic SDK this client uses. Tests inject a fake with this shape. */
export interface AnthropicLike {
  beta: {
    messages: {
      create(params: BetaCreateParams, options?: RequestOpts): PromiseLike<BetaMessage>;
      stream(
        params: BetaCreateParams,
        options?: RequestOpts,
      ): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

export interface LlmClientOptions {
  /** Replaces the real SDK, for tests. */
  sdk?: AnthropicLike;
  /** Client-wide meter. Every call is recorded here and blocked when its cap is reached. */
  meter?: CostMeter;
  /** Server-side refusal fallbacks. Default true; turn off if the API rejects the beta. */
  fallbacks?: boolean;
  logger?: Logger;
}

export function createLlmClient(config: Config, opts: LlmClientOptions = {}): LlmClient {
  const logger = opts.logger ?? log;
  const useFallbacks = opts.fallbacks ?? true;
  let sdk: AnthropicLike | undefined = opts.sdk;

  // Constructed on first use so a missing key never builds an SDK client.
  function getSdk(apiKey: string): AnthropicLike {
    sdk ??= new Anthropic({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
    return sdk;
  }

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = config.anthropic_api_key;
    if (apiKey === undefined) {
      throw new LlmError(
        "config",
        "not_configured",
        "ANTHROPIC_API_KEY is not set; this operation needs the Claude API",
        { retryable: false },
      );
    }

    opts.meter?.check();
    req.meter?.check();

    const model = resolveModel(req.role, config);
    const defaults = ROLE_DEFAULTS[req.role];
    const effort = req.effort ?? defaults.effort;
    const maxTokens = req.maxTokens ?? defaults.maxTokens;
    const stream = maxTokens > STREAM_THRESHOLD_TOKENS;

    const params: BetaCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: req.messages,
      output_config: {
        effort,
        ...(req.schema !== undefined && { format: jsonSchemaFormat(req.schema) }),
      },
      ...(req.system !== "" && {
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      }),
      ...(useFallbacks && { betas: [FALLBACK_BETA], fallbacks: "default" as const }),
    };
    const requestOptions: RequestOpts = req.signal !== undefined ? { signal: req.signal } : {};

    const started = Date.now();
    let message: BetaMessage;
    try {
      const client = getSdk(apiKey);
      message = stream
        ? await client.beta.messages.stream(params, requestOptions).finalMessage()
        : await client.beta.messages.create(params, requestOptions);
    } catch (err) {
      const mapped = mapSdkError(err);
      logger.debug("llm call failed", {
        role: req.role,
        model,
        effort,
        elapsed_ms: Date.now() - started,
        code: mapped.code,
        kind: mapped.kind,
      });
      throw mapped;
    }
    const elapsedMs = Date.now() - started;

    const servedBy = message.model;
    const usage = readUsage(message);
    const costUsd = computeCost(servedBy, usage, logger);
    opts.meter?.record(usage, costUsd);
    req.meter?.record(usage, costUsd);
    logger.debug("llm call", {
      role: req.role,
      model: servedBy,
      effort,
      stream,
      stop_reason: message.stop_reason,
      usage,
      cost_usd: costUsd,
      elapsed_ms: elapsedMs,
    });

    // Refusals are checked before the content is read.
    if (message.stop_reason === "refusal") {
      throw new LlmError("provider", "refusal", "The model declined the request (stop_reason: refusal)", {
        retryable: false,
        details: { stop_details: message.stop_details, model: servedBy },
      });
    }

    const text = extractText(message);
    const response: LlmResponse = {
      usage,
      costUsd,
      model: servedBy,
      stopReason: message.stop_reason,
      ...(text !== undefined && { text }),
    };

    if (req.schema !== undefined) {
      response.parsed = parseStructured(req.schema, text, message.stop_reason);
    }
    return response;
  }

  return { complete };
}

/** JSON schema for `output_config.format`. The SDK helper strips keywords the API rejects. */
function jsonSchemaFormat(schema: NonNullable<LlmRequest["schema"]>): { type: "json_schema"; schema: Record<string, unknown> } {
  const format = zodOutputFormat(schema);
  return { type: "json_schema", schema: format.schema };
}

function readUsage(message: BetaMessage): Usage {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function extractText(message: BetaMessage): string | undefined {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function parseStructured(schema: NonNullable<LlmRequest["schema"]>, text: string | undefined, stopReason: string | null): unknown {
  const truncated = stopReason === "max_tokens";
  const fail = (why: string, details?: unknown): LlmError =>
    new LlmError(
      "provider",
      "schema",
      `Structured output ${why}${truncated ? " (response was cut off at max_tokens)" : ""}`,
      { retryable: false, details: { stop_reason: stopReason, ...(details !== undefined && { issues: details }) } },
    );

  if (text === undefined) throw fail("was empty");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw fail("was not valid JSON");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message }));
    throw fail("did not match the expected schema", issues);
  }
  return result.data;
}

/**
 * Map SDK errors to LlmError. Only the SDK's own classes are handled; anything
 * else (a bug in this code, for example) propagates unchanged.
 * Order matters: the timeout and abort classes extend the connection and API classes.
 */
export function mapSdkError(err: unknown): LlmError | never {
  if (err instanceof LlmError) return err;
  if (err instanceof APIUserAbortError) {
    return new LlmError("timeout", "network", "The request was aborted", { retryable: false, cause: err });
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new LlmError("timeout", "network", "The request to the Claude API timed out", {
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof APIConnectionError) {
    return new LlmError("provider", "network", `Could not reach the Claude API: ${err.message}`, {
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof RateLimitError) {
    return new LlmError("provider", "rate_limit", "The Claude API rate limit was hit", {
      retryable: true,
      details: { status: err.status, request_id: err.requestID },
      cause: err,
    });
  }
  if (err instanceof APIError) {
    const status = err.status;
    const details = { status, request_id: err.requestID };
    if (status === 401) {
      return new LlmError("config", "api", "The Claude API rejected ANTHROPIC_API_KEY (HTTP 401)", {
        retryable: false,
        details,
        cause: err,
      });
    }
    if (status === 408) {
      return new LlmError("timeout", "api", "The Claude API reported a request timeout (HTTP 408)", {
        retryable: true,
        details,
        cause: err,
      });
    }
    const serverSide = status !== undefined && status >= 500;
    return new LlmError("provider", "api", `Claude API error${status !== undefined ? ` (HTTP ${status})` : ""}: ${err.message}`, {
      retryable: serverSide,
      details,
      cause: err,
    });
  }
  if (err instanceof AnthropicError) {
    return new LlmError("internal", "api", `Claude SDK error: ${err.message}`, { retryable: false, cause: err });
  }
  throw err;
}
