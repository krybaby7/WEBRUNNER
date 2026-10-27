import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { log, type Logger } from "../../log.js";
import { REQUEST_TIMEOUT_MS } from "./client.js";
import { computeCost, type CostMeter } from "./cost.js";
import { DEFAULT_CODEX_MODEL, ROLE_DEFAULTS } from "./models.js";
import { runProcess, Slots, withoutVars, type RunProcess, type RunResult } from "./process.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type Usage } from "./types.js";

/**
 * The `codex-cli` fallback (PLAN.md 15.4): one `codex exec` process per call,
 * signed in with the owner's ChatGPT plan. `--ignore-user-config` keeps the
 * owner's config.toml, and so its MCP servers, out of the call, and every agent
 * tool is switched off, so the process answers the one prompt and exits.
 */

/** Variables that would make codex bill an API key instead of using the ChatGPT plan. */
const API_KEY_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"];

/**
 * Codex features switched off for every call: no shell, apps, plugins,
 * subagents, browser or image tools. They go in as `-c features.<name>=false`,
 * which a Codex release without that feature ignores; `--disable` would fail.
 */
export const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "multi_agent",
  "browser_use",
  "computer_use",
  "image_generation",
  "goals",
  "skill_search",
  "tool_suggest",
  "view_image",
  "sleep_tool",
  "hooks",
  "workspace_dependencies",
] as const;

/** String formats OpenAI structured outputs accept; any other `format` is dropped from the schema. */
const OPENAI_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export interface CodexCliOptions {
  /** The resolved `codex` executable. */
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

/** What one `codex exec --json` run reported. */
interface CodexRun {
  /** The last agent message. */
  text?: string;
  usage?: Record<string, unknown>;
  /** Messages of `turn.failed` and `error` events. */
  errors: string[];
}

export function createCodexCliClient(config: Config, opts: CodexCliOptions): LlmClient {
  const logger = opts.logger ?? log;
  const run = opts.run ?? runProcess;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const slots = opts.slots ?? new Slots(config.llm_concurrency ?? 4);
  const workDir = opts.workDir ?? join(config.cache_dir, "llm-cli");
  const model = config.codex_model ?? DEFAULT_CODEX_MODEL;

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    opts.meter?.check();
    req.meter?.check();

    const effort = req.effort ?? ROLE_DEFAULTS[req.role].effort;
    const original = req.schema !== undefined ? zodOutputFormat(req.schema).schema : undefined;
    const output = original !== undefined ? strictSchema(original) : undefined;
    const prompt = buildPrompt(req.system, req.messages);

    let release: () => void;
    try {
      release = await slots.acquire(req.signal);
    } catch (err) {
      throw new LlmError("timeout", "network", "The request was aborted while waiting for a free codex process", { retryable: false, cause: err });
    }
    const started = Date.now();
    let dir: string | undefined;
    let out: RunResult;
    try {
      mkdirSync(workDir, { recursive: true });
      dir = await mkdtemp(join(workDir, "codex-"));
      const images: string[] = [];
      for (const [i, image] of prompt.images.entries()) {
        const file = join(dir, `image-${i + 1}.${image.ext}`);
        await writeFile(file, Buffer.from(image.data, "base64"));
        images.push(file);
      }
      let schemaFile: string | undefined;
      if (output !== undefined) {
        schemaFile = join(dir, "schema.json");
        await writeFile(schemaFile, JSON.stringify(output.schema), "utf8");
      }
      const args = [
        "exec",
        // Images first: --image takes several values, so a positional argument must not follow it.
        ...images.flatMap((file) => ["--image", file]),
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s", "read-only",
        "--json",
        "-C", dir,
        "-m", model,
        "-c", `model_reasoning_effort="${effort}"`,
        "-c", 'web_search="disabled"',
        "-c", "project_doc_max_bytes=0",
        ...DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
        ...(schemaFile !== undefined ? ["--output-schema", schemaFile] : []),
        "-",
      ];
      try {
        out = await run({
          command: opts.command,
          args,
          cwd: dir,
          env: withoutVars(opts.env ?? process.env, API_KEY_VARS),
          stdin: prompt.text,
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

    const result = readEvents(out.stdout, logger);
    const failure = callError(out, result, timeoutMs);
    if (failure !== undefined) {
      logger.debug("llm call failed", { backend: "codex-cli", role: req.role, model, effort, elapsed_ms: elapsedMs, code: failure.code, kind: failure.kind });
      throw failure;
    }

    const usage = readUsage(result.usage ?? {});
    const costUsd = computeCost(model, usage, logger);
    opts.meter?.record(usage, costUsd);
    req.meter?.record(usage, costUsd);
    logger.debug("llm call", { backend: "codex-cli", role: req.role, model, effort, usage, cost_usd: costUsd, elapsed_ms: elapsedMs });

    // Codex reports no stop reason.
    const response: LlmResponse = { usage, costUsd, model, stopReason: null, ...(result.text !== undefined && { text: result.text }) };
    if (req.schema !== undefined && original !== undefined && output !== undefined) {
      response.parsed = parseStructured(req.schema, original, output.wrapped, result.text);
    }
    return response;
  }

  return { complete };
}

/** The stdin prompt (system prompt, then the user turns) and the images to pass with `--image`. */
export function buildPrompt(
  system: string,
  messages: readonly Anthropic.MessageParam[],
): { text: string; images: Array<{ data: string; ext: string }> } {
  const images: Array<{ data: string; ext: string }> = [];
  const partsOf = (m: Anthropic.MessageParam): string[] => {
    if (typeof m.content === "string") return [m.content];
    return m.content.flatMap((b) => {
      if (b.type === "text") return [b.text];
      if (b.type !== "image") return [];
      if (b.source.type === "base64") {
        images.push({ data: b.source.data, ext: IMAGE_EXTENSIONS[b.source.media_type] ?? "png" });
        return [];
      }
      return b.source.type === "url" ? [`[image: ${b.source.url}]`] : [];
    });
  };
  // No caller sends an assistant turn today; should one, the conversation travels as a transcript.
  const body = messages.every((m) => m.role === "user")
    ? messages.flatMap(partsOf).join("\n\n")
    : messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${partsOf(m).join("\n")}`).join("\n\n");
  return { text: system !== "" ? `${system}\n\n${body}` : body, images };
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `schema` in the subset OpenAI structured outputs accept (PLAN.md 15.4): every
 * property required, with optional ones made nullable; `additionalProperties:
 * false` on every object; unsupported string formats dropped. A root that is not
 * a plain object is wrapped as `{ value: ... }`, and `wrapped` says so.
 */
export function strictSchema(schema: Json): { schema: Json; wrapped: boolean } {
  const { $schema: _dialect, $defs, definitions, ...body } = schema;
  const wrapped = body["type"] !== "object" || body["anyOf"] !== undefined;
  const root: Json = wrapped ? { type: "object", properties: { value: body }, required: ["value"] } : body;
  const strict = strictNode({ ...root, ...($defs !== undefined && { $defs }), ...(definitions !== undefined && { definitions }) }) as Json;
  return { schema: strict, wrapped };
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!isRecord(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "format" && typeof value === "string" && !OPENAI_FORMATS.has(value)) continue;
    out[key] = key === "properties" || key === "$defs" || key === "definitions" ? strictMap(value) : strictNode(value);
  }
  const props = out["properties"];
  if (isRecord(props)) {
    const required = new Set(Array.isArray(node["required"]) ? node["required"] : []);
    for (const key of Object.keys(props)) if (!required.has(key)) props[key] = nullable(props[key]);
    out["required"] = Object.keys(props);
    out["additionalProperties"] = false;
  } else if (out["type"] === "object" && out["additionalProperties"] === undefined) {
    out["additionalProperties"] = false;
  }
  return out;
}

function strictMap(map: unknown): unknown {
  return isRecord(map) ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, strictNode(v)])) : map;
}

function nullable(schema: unknown): unknown {
  if (!isRecord(schema) || allowsNull(schema)) return schema;
  if (typeof schema["type"] === "string" && schema["enum"] === undefined && schema["const"] === undefined) {
    return { ...schema, type: [schema["type"], "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function allowsNull(schema: Json): boolean {
  const t = schema["type"];
  if (t === "null" || (Array.isArray(t) && t.includes("null"))) return true;
  return Array.isArray(schema["anyOf"]) && schema["anyOf"].some((b) => isRecord(b) && allowsNull(b));
}

/**
 * `value` without the nulls the model put in properties that `schema` (the
 * original, non-strict one) marks optional. Required nullable properties keep
 * their nulls.
 */
export function dropOptionalNulls(value: unknown, schema: unknown, defs: Json, depth = 0): unknown {
  if (!isRecord(schema) || depth > 64) return value;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)?.[1];
    return name !== undefined ? dropOptionalNulls(value, defs[name], defs, depth + 1) : value;
  }
  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) return anyOf.reduce((v: unknown, branch) => dropOptionalNulls(v, branch, defs, depth + 1), value);
  if (Array.isArray(value)) return value.map((item) => dropOptionalNulls(item, schema["items"], defs, depth + 1));
  const props = schema["properties"];
  if (!isRecord(value) || !isRecord(props)) return value;
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"] : []);
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null && key in props && !required.has(key)) continue;
    out[key] = dropOptionalNulls(v, props[key], defs, depth + 1);
  }
  return out;
}

function parseStructured(schema: NonNullable<LlmRequest["schema"]>, original: Json, wrapped: boolean, text: string | undefined): unknown {
  if (text === undefined) throw new LlmError("provider", "schema", "Structured output was empty", { retryable: false });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LlmError("provider", "schema", "Structured output was not valid JSON", { retryable: false });
  }
  if (wrapped) value = isRecord(value) ? value["value"] : undefined;
  let parsed = schema.safeParse(value);
  if (!parsed.success) {
    const { $defs, definitions } = original;
    const defs = { ...(isRecord(definitions) ? definitions : {}), ...(isRecord($defs) ? $defs : {}) };
    const retry = schema.safeParse(dropOptionalNulls(value, original, defs));
    if (retry.success) parsed = retry;
  }
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new LlmError("provider", "schema", "Structured output did not match the expected schema", { retryable: false, details: { issues } });
  }
  return parsed.data;
}

function readEvents(stdout: string, logger: Logger): CodexRun {
  const result: CodexRun = { errors: [] };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let e: Json;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) continue;
      e = value;
    } catch {
      continue; // Not an event (a stray diagnostic line).
    }
    const item = e["item"];
    if (e["type"] === "item.completed" && isRecord(item)) {
      if (item["type"] === "agent_message" && typeof item["text"] === "string") result.text = item["text"];
      // Warnings, such as a feature this Codex release does not know.
      else if (item["type"] === "error" && typeof item["message"] === "string") logger.debug("codex warning", { message: item["message"].slice(0, 300) });
    } else if (e["type"] === "turn.completed" && isRecord(e["usage"])) {
      result.usage = e["usage"];
    } else if (e["type"] === "turn.failed") {
      const err = e["error"];
      result.errors.push(isRecord(err) && typeof err["message"] === "string" ? err["message"] : "the turn failed");
    } else if (e["type"] === "error") {
      result.errors.push(typeof e["message"] === "string" ? e["message"] : "error");
    }
  }
  return result;
}

const LIMIT_RE = /usage limit|hit your (?:usage )?limit|out of (?:usage|credits)|quota exceeded|insufficient_quota/i;
const AUTH_RE = /not logged in|codex login|log ?in again|\b401\b|unauthori[sz]ed|authentication|refresh token/i;
const RATE_RE = /\b429\b|too many requests|rate limit/i;
const SERVER_RE = /\b5\d\d\b|overloaded|server error|stream disconnected/i;

/** The LlmError for a call that did not produce a usable answer, or undefined when it did. */
function callError(out: RunResult, result: CodexRun, timeoutMs: number): LlmError | undefined {
  if (out.killed === "abort") return new LlmError("timeout", "network", "The request was aborted", { retryable: false });
  if (out.killed === "timeout") {
    return new LlmError("timeout", "network", `codex did not answer within ${Math.round(timeoutMs / 1000)} s`, { retryable: true });
  }
  const failed = result.errors.length > 0 || (out.exitCode !== null && out.exitCode !== 0) || result.text === undefined;
  if (!failed) return undefined;

  const stderrLine = lastLine(out.stderr);
  const message = redactLine(result.errors[result.errors.length - 1] ?? stderrLine);
  const said = `${result.errors.join("\n")}\n${stderrLine}`;
  if (LIMIT_RE.test(said)) {
    return new LlmError("provider", "rate_limit", `The Codex (ChatGPT) plan's usage limit was reached: ${message}`, {
      retryable: false,
      details: { plan_limit: true },
    });
  }
  if (AUTH_RE.test(said)) {
    return new LlmError("config", "api", "The codex CLI is not signed in to ChatGPT; run `codex login`", { retryable: false, details: { message } });
  }
  if (RATE_RE.test(said)) {
    return new LlmError("provider", "rate_limit", `Codex hit a rate limit: ${message}`, { retryable: true, details: { message } });
  }
  if (result.errors.length > 0) {
    return new LlmError("provider", "api", `codex reported an error: ${message}`, { retryable: SERVER_RE.test(said), details: { message } });
  }
  if (out.exitCode !== null && out.exitCode !== 0) {
    return new LlmError("provider", "api", `codex exited with code ${out.exitCode}`, { retryable: false, details: { stderr: redactLine(stderrLine) } });
  }
  return new LlmError("provider", "api", "codex finished without an answer", { retryable: false, details: { stderr: redactLine(stderrLine) } });
}

function startError(err: unknown, command: string): LlmError {
  const code = (err as NodeJS.ErrnoException).code;
  const why = code === "ENOENT" ? "was not found" : `could not be started (${code ?? String(err)})`;
  return new LlmError(
    "config",
    "not_configured",
    `The codex CLI at "${command}" ${why}. Install Codex (npm install -g @openai/codex) and run codex login, or set codex_path (WEBRUNNER_CODEX_PATH)`,
    { retryable: false, cause: err },
  );
}

/** OpenAI counts cached and cache-written tokens inside `input_tokens`; Usage keeps them apart. */
function readUsage(u: Json): Usage {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cached = n(u["cached_input_tokens"]);
  const written = n(u["cache_write_input_tokens"]);
  return {
    inputTokens: Math.max(0, n(u["input_tokens"]) - cached - written),
    outputTokens: n(u["output_tokens"]),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== "");
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

function redactLine(s: string): string {
  return s
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi, "$1[redacted]");
}
