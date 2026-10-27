import type { Config } from "../../config.js";
import { log, type Logger } from "../../log.js";
import { createClaudeCliClient, type ClaudeCliClient, type PlanStatus } from "./claude-cli.js";
import { createLlmClient } from "./client.js";
import { createCodexCliClient } from "./codex-cli.js";
import type { CostMeter } from "./cost.js";
import { DEFAULT_CODEX_MODEL } from "./models.js";
import { resolveExecutable, Slots, type RunProcess } from "./process.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./types.js";

/**
 * Which backend serves model calls, and the fallback router (PLAN.md 15.2).
 * `createLlmClient` stays the Claude API client; this module decides whether
 * that, the `claude -p` client or nothing serves a server's calls.
 */

export type LlmBackendName = "api" | "claude-cli" | "none";
export type LlmFallbackName = "codex-cli" | "none";

export interface LlmInfo {
  backend: LlmBackendName;
  fallback: LlmFallbackName;
}

/** How long a primary that hit its plan limit is skipped when Claude gave no reset time. */
export const DEFAULT_LIMITED_MS = 15 * 60_000;

export const NO_BACKEND_MESSAGE =
  "No model backend is available: set ANTHROPIC_API_KEY for the Claude API, or install Claude Code, sign in, and set llm_backend to claude-cli (WEBRUNNER_LLM_BACKEND) to use your Claude subscription";

export interface BackendChoice {
  backend: LlmBackendName;
  /** The resolved claude executable, for `claude-cli`. */
  claudePath?: string;
  /** Why there is no backend, or why the choice differs from the setting. */
  note?: string;
}

/** The backend `config` selects. `which` finds executables (injected by tests). */
export function resolveBackend(config: Config, which: (name: string) => string | undefined = resolveExecutable): BackendChoice {
  const setting = config.llm_backend ?? "auto";
  const claudeName = config.claude_path ?? "claude";
  if (setting === "api") {
    return config.anthropic_api_key !== undefined
      ? { backend: "api" }
      : { backend: "none", note: "llm_backend is api but ANTHROPIC_API_KEY is not set" };
  }
  if (setting === "claude-cli") {
    const claudePath = which(claudeName);
    return claudePath !== undefined
      ? { backend: "claude-cli", claudePath }
      : { backend: "none", note: `llm_backend is claude-cli but no claude executable was found at "${claudeName}"` };
  }
  if (config.anthropic_api_key !== undefined) return { backend: "api" };
  const claudePath = which(claudeName);
  if (claudePath !== undefined) return { backend: "claude-cli", claudePath };
  return { backend: "none", note: "ANTHROPIC_API_KEY is not set and no claude executable was found" };
}

export interface ModelClientOptions {
  /** Client-wide meter (the daily cap). */
  meter?: CostMeter;
  logger?: Logger;
  which?: (name: string) => string | undefined;
  /** Replaces the process runner of the CLI backends, for tests. */
  run?: RunProcess;
  env?: NodeJS.ProcessEnv;
}

/** The client a server uses for every model call, and what it is. */
export function createModelClient(config: Config, opts: ModelClientOptions = {}): { client: LlmClient; info: LlmInfo } {
  const logger = opts.logger ?? log;
  const choice = resolveBackend(config, opts.which);
  // One limit on CLI processes for the whole server, whichever backend runs them.
  const cli = {
    logger,
    slots: new Slots(config.llm_concurrency ?? 4),
    ...(opts.meter !== undefined && { meter: opts.meter }),
    ...(opts.run !== undefined && { run: opts.run }),
    ...(opts.env !== undefined && { env: opts.env }),
  };
  let primary: LlmClient;
  if (choice.backend === "api") {
    primary = createLlmClient(config, { logger, ...(opts.meter !== undefined && { meter: opts.meter }) });
  } else if (choice.backend === "claude-cli") {
    primary = createClaudeCliClient(config, { command: choice.claudePath as string, ...cli });
  } else {
    logger.warn(`${choice.note ?? "no model backend"}; deep_research, browse_task and LLM extraction will be unavailable`, {
      llm_backend: config.llm_backend ?? "auto",
    });
    primary = unavailableClient();
  }
  if (choice.backend !== "none") logger.info("model backend", { backend: choice.backend, ...(choice.claudePath !== undefined && { claude_path: choice.claudePath }) });

  if (config.llm_fallback !== "codex-cli") return { client: primary, info: { backend: choice.backend, fallback: "none" } };
  const codexName = config.codex_path ?? "codex";
  const codexPath = (opts.which ?? resolveExecutable)(codexName);
  if (choice.backend === "none" || codexPath === undefined) {
    logger.warn(
      choice.backend === "none"
        ? "llm_fallback is codex-cli, but Codex only stands in for a primary backend and there is none"
        : `llm_fallback is codex-cli, but no codex executable was found at "${codexName}"; a call that hits Claude's plan limit fails instead`,
    );
    return { client: primary, info: { backend: choice.backend, fallback: "none" } };
  }
  const fallback = createCodexCliClient(config, { command: codexPath, ...cli });
  logger.info("model fallback", { fallback: "codex-cli", codex_path: codexPath, model: config.codex_model ?? DEFAULT_CODEX_MODEL });
  const client = createFallbackClient(primary, fallback, {
    logger,
    ...(config.claude_max_utilization !== undefined && { maxUtilization: config.claude_max_utilization }),
  });
  return { client, info: { backend: choice.backend, fallback: "codex-cli" } };
}

/** A client for a server with no backend: every call is a `config` error naming both ways to get one. */
export function unavailableClient(): LlmClient {
  return {
    complete: () => Promise.reject(new LlmError("config", "not_configured", NO_BACKEND_MESSAGE, { retryable: false })),
  };
}

export interface FallbackOptions {
  /** `claude_max_utilization`: at or above this share of a plan window the primary is skipped. 1 means only on the limit. */
  maxUtilization?: number;
  logger?: Logger;
  now?: () => number;
}

/**
 * Sends each call to `primary` unless it is limited, and replays a call that
 * hits the primary's plan limit on `fallback` (PLAN.md 15.2). Errors other
 * than a plan limit are not retried on the fallback.
 */
export function createFallbackClient(
  primary: LlmClient & { planStatus?: () => PlanStatus | undefined },
  fallback: LlmClient,
  opts: FallbackOptions = {},
): LlmClient & { limitedUntil(): number | undefined } {
  const logger = opts.logger ?? log;
  const now = opts.now ?? Date.now;
  const maxUtilization = opts.maxUtilization ?? 1;
  let limitedUntil: number | undefined;

  const markLimited = (untilMs: number, why: string): void => {
    if (limitedUntil === undefined || untilMs > limitedUntil) {
      limitedUntil = untilMs;
      logger.warn("the primary model backend is limited; using the fallback", { until: new Date(untilMs).toISOString(), reason: why });
    }
  };

  const isLimited = (): boolean => {
    const t = now();
    if (limitedUntil !== undefined && t < limitedUntil) return true;
    if (limitedUntil !== undefined) limitedUntil = undefined;
    if (maxUtilization < 1) {
      for (const [name, w] of Object.entries(primary.planStatus?.()?.windows ?? {})) {
        if (w.utilization >= maxUtilization) {
          const until = w.resetsAt !== undefined ? w.resetsAt * 1000 : t + DEFAULT_LIMITED_MS;
          if (until > t) {
            markLimited(until, `the ${name} window is at ${Math.round(w.utilization * 100)} %`);
            return true;
          }
        }
      }
    }
    return false;
  };

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    if (isLimited()) return fallback.complete(req);
    try {
      return await primary.complete(req);
    } catch (err) {
      if (!isPlanLimit(err)) throw err;
      const resetsAt = (err.details as { resets_at?: unknown }).resets_at;
      markLimited(typeof resetsAt === "number" ? resetsAt * 1000 : now() + DEFAULT_LIMITED_MS, "plan limit reached");
      return fallback.complete(req);
    }
  }

  return { complete, limitedUntil: () => limitedUntil };
}

function isPlanLimit(err: unknown): err is LlmError {
  return (
    err instanceof LlmError &&
    err.kind === "rate_limit" &&
    err.details !== null &&
    typeof err.details === "object" &&
    (err.details as { plan_limit?: unknown }).plan_limit === true
  );
}

export type { ClaudeCliClient };
