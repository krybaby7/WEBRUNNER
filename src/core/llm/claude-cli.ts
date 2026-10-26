import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { log, type Logger } from "../../log.js";
import { REQUEST_TIMEOUT_MS } from "./client.js";
import { computeCost, type CostMeter } from "./cost.js";
import { resolveModel, ROLE_DEFAULTS } from "./models.js";
import { runProcess, Slots, withoutVars, type RunProcess, type RunResult } from "./process.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type Usage } from "./types.js";

/**
 * The `claude-cli` backend (PLAN.md 15.3): one `claude -p` process per call,
 * signed in with the owner's Claude subscription. The process gets no tools, no
 * MCP servers and no settings, so it answers the one prompt and exits.
 */

/** A JSON Schema longer than this would crowd the command line, which Windows caps at 32,767 characters. */
export const MAX_SCHEMA_CHARS = 24_000;
/** Variables that would make `claude` bill an API key instead of using the subscription. */
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
/** Used when a request has no system prompt: an empty file would bring back Claude Code's own. */
const EMPTY_SYSTEM_PROMPT = "Answer the user's request.";
const PLAN_STATUS_OK = new Set(["allowed", "allowed_warning"]);

/** What Claude last reported about the subscription's usage windows. */
export interface PlanStatus {
  status: string;
  /** Epoch seconds. */
  resetsAt?: number;
  windows: Record<string, { utilization: number; resetsAt?: number }>;
}

export interface ClaudeCliClient extends LlmClient {
  /** The latest plan status, or undefined before the first call. */
  planStatus(): PlanStatus | undefined;
}

export interface ClaudeCliOptions {
  /** The resolved `claude` executable. */
  command: string;
  /** Client-wide meter (the daily cap). */
  meter?: CostMeter;
  logger?: Logger;
  /** Replaces the real process runner, for tests. */
  run?: RunProcess;
  /** Base environment of the child; default process.env. API key variables are always removed. */
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout. Default REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Shared limit on concurrent CLI processes. Default: a private one of `config.llm_concurrency ?? 4`. */
  slots?: Slots;
  /** Where each call's empty working directory is made. Default `<cache_dir>/llm-cli`. */
  workDir?: string;
}

/** The fields of claude's final `result` event this client reads. */
interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  stop_reason?: string | null;
  total_cost_usd?: number;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { outputTokens?: number }>;
}

export function createClaudeCliClient(config: Config, opts: ClaudeCliOptions): ClaudeCliClient {
  const logger = opts.logger ?? log;
  const run = opts.run ?? runProcess;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const slots = opts.slots ?? new Slots(config.llm_concurrency ?? 4);
  const workDir = opts.workDir ?? join(config.cache_dir, "llm-cli");
  let plan: PlanStatus | undefined;
  let warnedApiKey = false;

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    opts.meter?.check();
    req.meter?.check();

    const model = resolveModel(req.role, config);
    const defaults = ROLE_DEFAULTS[req.role];
    const effort = req.effort ?? defaults.effort;
    const maxTokens = req.maxTokens ?? defaults.maxTokens;
    const schema = req.schema !== undefined ? JSON.stringify(zodOutputFormat(req.schema).schema) : undefined;
    if (schema !== undefined && schema.length > MAX_SCHEMA_CHARS) {
      throw new LlmError("internal", "schema", `The output schema is ${schema.length} characters as JSON Schema, more than the ${MAX_SCHEMA_CHARS} the claude command line allows`, {
        retryable: false,
      });
    }

    let release: () => void;
    try {
      release = await slots.acquire(req.signal);
    } catch (err) {
      throw new LlmError("timeout", "network", "The request was aborted while waiting for a free claude process", { retryable: false, cause: err });
    }
    const started = Date.now();
    let dir: string | undefined;
    let out: RunResult;
    try {
      mkdirSync(workDir, { recursive: true });
      dir = await mkdtemp(join(workDir, "call-"));
      const systemFile = join(dir, "system.txt");
      await writeFile(systemFile, req.system !== "" ? req.system : EMPTY_SYSTEM_PROMPT, "utf8");
      const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", model,
        "--effort", effort,
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--system-prompt-file", systemFile,
        ...(schema !== undefined ? ["--json-schema", schema] : []),
      ];
      const env = { ...withoutVars(opts.env ?? process.env, API_KEY_VARS), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
      try {
        out = await run({
          command: opts.command,
          args,
          cwd: dir,
          env,
          stdin: stdinMessage(req.messages),
          timeoutMs,
          ...(req.signal !== undefined && { signal: req.signal }),
        });
      } catch (err) {
        throw startError(err, opts.command);
      }
    } finally {
      release();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    const elapsedMs = Date.now() - started;

    const events = parseEvents(out.stdout);
    let callPlan: PlanStatus | undefined;
    for (const e of events) {
      if (e["type"] === "rate_limit_event") callPlan = readPlanStatus(e["rate_limit_info"]) ?? callPlan;
      if (e["type"] === "system" && e["subtype"] === "init" && !warnedApiKey && typeof e["apiKeySource"] === "string" && e["apiKeySource"] !== "none") {
        warnedApiKey = true;
        logger.warn("claude is using an API key, not the Claude subscription; calls may be billed", { api_key_source: e["apiKeySource"] });
      }
    }
    if (callPlan !== undefined) plan = callPlan;
    const result = [...events].reverse().find((e): e is ResultEvent & Record<string, unknown> => e["type"] === "result");

    // Only this call's own plan status counts: an earlier rejection must not fail a call that worked.
    const failure = callError(out, result, callPlan, timeoutMs);
    if (failure !== undefined) {
      logger.debug("llm call failed", { backend: "claude-cli", role: req.role, model, effort, elapsed_ms: elapsedMs, code: failure.code, kind: failure.kind });
      throw failure;
    }
    const final = result as ResultEvent;

    const usage = readUsage(final);
    const servedBy = servingModel(final) ?? model;
    const costUsd = typeof final.total_cost_usd === "number" ? final.total_cost_usd : computeCost(servedBy, usage, logger);
    opts.meter?.record(usage, costUsd);
    req.meter?.record(usage, costUsd);
    const stopReason = final.stop_reason ?? null;
    logger.debug("llm call", { backend: "claude-cli", role: req.role, model: servedBy, effort, stop_reason: stopReason, usage, cost_usd: costUsd, elapsed_ms: elapsedMs });

    if (stopReason === "refusal") {
      throw new LlmError("provider", "refusal", "The model declined the request (stop_reason: refusal)", { retryable: false, details: { model: servedBy } });
    }
    const text = typeof final.result === "string" && final.result !== "" ? final.result : undefined;
    const response: LlmResponse = { usage, costUsd, model: servedBy, stopReason, ...(text !== undefined && { text }) };
    if (req.schema !== undefined) response.parsed = parseStructured(req.schema, final.structured_output, text);
    return response;
  }

  return { complete, planStatus: () => plan };
}

/** One stream-json user message carrying every user content block in order (PLAN.md 15.3). */
export function stdinMessage(messages: readonly Anthropic.MessageParam[]): string {
  let content: Anthropic.ContentBlockParam[];
  if (messages.every((m) => m.role === "user")) {
    content = messages.flatMap((m) => (typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content));
  } else {
    // No caller sends an assistant turn today; should one, the conversation travels as a transcript.
    const transcript = messages
      .map((m) => {
        const parts = typeof m.content === "string" ? [m.content] : m.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
        return `${m.role === "user" ? "User" : "Assistant"}:\n${parts.join("\n")}`;
      })
      .join("\n\n");
    const images = messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "image")));
    content = [{ type: "text", text: transcript }, ...images];
  }
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

function parseEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === "object") events.push(value as Record<string, unknown>);
    } catch {
      // Not an event (a stray diagnostic line).
    }
  }
  return events;
}

export function readPlanStatus(info: unknown): PlanStatus | undefined {
  if (info === null || typeof info !== "object") return undefined;
  const i = info as { status?: unknown; resetsAt?: unknown; unifiedWindows?: unknown };
  if (typeof i.status !== "string") return undefined;
  const windows: PlanStatus["windows"] = {};
  if (i.unifiedWindows !== null && typeof i.unifiedWindows === "object") {
    for (const [name, w] of Object.entries(i.unifiedWindows as Record<string, unknown>)) {
      const win = w as { utilization?: unknown; resetsAt?: unknown } | null;
      if (win !== null && typeof win.utilization === "number") {
        windows[name] = { utilization: win.utilization, ...(typeof win.resetsAt === "number" && { resetsAt: win.resetsAt }) };
      }
    }
  }
  return { status: i.status, ...(typeof i.resetsAt === "number" && { resetsAt: i.resetsAt }), windows };
}

const LIMIT_RE = /usage limit|limit reached|hit your limit|out of (?:extra )?usage/i;
const AUTH_RE = /not logged in|please run \/login|log ?in again|invalid api key|authentication|oauth token/i;

/** The LlmError for a call that did not produce a usable result, or undefined when it did. */
function callError(out: RunResult, result: ResultEvent | undefined, plan: PlanStatus | undefined, timeoutMs: number): LlmError | undefined {
  if (out.killed === "abort") return new LlmError("timeout", "network", "The request was aborted", { retryable: false });
  if (out.killed === "timeout") {
    return new LlmError("timeout", "network", `claude did not answer within ${Math.round(timeoutMs / 1000)} s`, { retryable: true });
  }
  const message = typeof result?.result === "string" ? result.result : "";
  const stderrLine = lastLine(out.stderr);
  const said = `${message}\n${stderrLine}`;
  const failed = result === undefined || result.is_error === true || (out.exitCode !== null && out.exitCode !== 0);
  if (!failed) return undefined;

  const rejected = plan !== undefined && !PLAN_STATUS_OK.has(plan.status);
  if (rejected || LIMIT_RE.test(said)) {
    const resetsAt = plan?.resetsAt;
    const when = resetsAt !== undefined ? `; it resets at ${new Date(resetsAt * 1000).toISOString()}` : "";
    return new LlmError("provider", "rate_limit", `The Claude subscription's usage limit was reached${when}`, {
      retryable: false,
      details: { plan_limit: true, ...(resetsAt !== undefined && { resets_at: resetsAt }), ...(plan !== undefined && { status: plan.status }) },
    });
  }
  if (AUTH_RE.test(said)) {
    return new LlmError("config", "api", "The claude CLI is not signed in to a Claude subscription; run `claude` once and sign in", {
      retryable: false,
      details: { message: redactLine(message || stderrLine) },
    });
  }
  if (result === undefined) {
    return new LlmError("provider", "api", `claude exited${out.exitCode !== null ? ` with code ${out.exitCode}` : ""} without a result`, {
      retryable: false,
      details: { stderr: redactLine(stderrLine) },
    });
  }
  const status = result.api_error_status ?? undefined;
  const details = { subtype: result.subtype, ...(status !== undefined && { status }), stderr: redactLine(stderrLine) };
  if (status === 429) {
    return new LlmError("provider", "rate_limit", "The Claude API rate limit was hit (HTTP 429)", { retryable: true, details });
  }
  return new LlmError("provider", "api", `claude reported an error${status !== undefined ? ` (HTTP ${status})` : ""}: ${redactLine(message || result.subtype || "no message")}`, {
    retryable: status !== undefined && status >= 500,
    details,
  });
}

function startError(err: unknown, command: string): LlmError {
  const code = (err as NodeJS.ErrnoException).code;
  const why = code === "ENOENT" ? "was not found" : `could not be started (${code ?? String(err)})`;
  return new LlmError(
    "config",
    "not_configured",
    `The claude CLI at "${command}" ${why}. Install Claude Code and sign in, or set claude_path (WEBRUNNER_CLAUDE_PATH)`,
    { retryable: false, cause: err },
  );
}

function readUsage(result: ResultEvent): Usage {
  const u = result.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** The model that produced most of the output. */
function servingModel(result: ResultEvent): string | undefined {
  let best: string | undefined;
  let most = -1;
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    const n = u.outputTokens ?? 0;
    if (n > most) {
      most = n;
      best = model;
    }
  }
  return best;
}

function parseStructured(schema: NonNullable<LlmRequest["schema"]>, structured: unknown, text: string | undefined): unknown {
  let value = structured;
  if (value === undefined && text !== undefined) {
    try {
      value = JSON.parse(text);
    } catch {
      // Reported below as missing.
    }
  }
  if (value === undefined) {
    throw new LlmError("provider", "schema", "Structured output was empty", { retryable: false });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new LlmError("provider", "schema", "Structured output did not match the expected schema", { retryable: false, details: { issues } });
  }
  return parsed.data;
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== "");
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

function redactLine(s: string): string {
  return s
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi, "$1[redacted]");
}
