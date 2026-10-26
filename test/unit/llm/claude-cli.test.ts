import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClaudeCliClient, MAX_SCHEMA_CHARS, stdinMessage, type ClaudeCliOptions } from "../../../src/core/llm/claude-cli.js";
import { CostMeter } from "../../../src/core/llm/cost.js";
import { Slots } from "../../../src/core/llm/process.js";
import { LlmError, type LlmRequest } from "../../../src/core/llm/types.js";
import { makeConfig, makeLogger } from "./helpers.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "llm", "fake-claude.mjs");

interface Scenario {
  events?: object[];
  delayMs?: number;
  exitCode?: number;
  stderr?: string;
}

interface StartRecord {
  pid: number;
  phase: "start";
  at: number;
  argv: string[];
  cwd: string;
  stdin: string;
  systemPrompt: string | null;
  env: { ANTHROPIC_API_KEY: string | null; ANTHROPIC_AUTH_TOKEN: string | null; CLAUDE_CODE_MAX_OUTPUT_TOKENS: string | null };
}

const init = { type: "system", subtype: "init", apiKeySource: "none", tools: ["StructuredOutput"], mcp_servers: [] };
const rateEvent = (status: string) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status,
    resetsAt: 1793060400,
    rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: 0.04, resetsAt: 1793060400 }, seven_day: { utilization: 0.6, resetsAt: 1793214000 } },
  },
});
const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hello",
  stop_reason: "end_turn",
  total_cost_usd: 0.0123,
  api_error_status: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
  modelUsage: { "claude-haiku-5-5": { outputTokens: 2 }, "claude-sonnet-5-5": { outputTokens: 18 } },
  ...over,
});
const ok = (over: Record<string, unknown> = {}): Scenario => ({ events: [init, rateEvent("allowed"), result(over)] });

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  role: "extractor",
  system: "You extract.",
  messages: [{ role: "user", content: "Read this page." }],
  ...over,
});

let dir: string;
let recordFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-claude-cli-"));
  recordFile = join(dir, "record.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function records(): Array<StartRecord | { pid: number; phase: "end"; at: number }> {
  try {
    return readFileSync(recordFile, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const starts = (): StartRecord[] => records().filter((r): r is StartRecord => r.phase === "start");

function client(scenario: Scenario, over: Partial<ClaudeCliOptions> = {}) {
  return createClaudeCliClient(makeConfig(), {
    command: FAKE,
    workDir: join(dir, "work"),
    logger: makeLogger(),
    env: {
      ...process.env,
      FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario),
      FAKE_CLAUDE_RECORD: recordFile,
      ANTHROPIC_API_KEY: "sk-ant-must-not-reach-claude",
      anthropic_auth_token: "lower-case-must-not-reach-claude-either",
    },
    ...over,
  });
}

async function caught(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error("expected the call to fail");
}

describe("claude-cli backend: how claude is started (PLAN.md 15.3)", () => {
  it("passes exactly the isolating flags, the role's model and effort, and the system prompt as a file", async () => {
    await client(ok()).complete(req());
    const [rec] = starts();
    const file = rec?.argv[rec.argv.indexOf("--system-prompt-file") + 1] as string;
    expect(rec?.argv).toEqual([
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "claude-sonnet-5-5",
      "--effort", "medium",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      "--system-prompt-file", file,
    ]);
    expect(rec?.argv).not.toContain("--bare");
    expect(rec?.systemPrompt).toBe("You extract.");
    // The working directory is the call's own empty directory, removed afterwards.
    expect(rec?.cwd).toBe(dirname(file));
  });

  it("never hands claude an API key, so the subscription is used, and caps output tokens", async () => {
    await client(ok()).complete(req({ maxTokens: 1234 }));
    expect(starts()[0]?.env).toEqual({ ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1234" });
  });

  it("uses the role defaults for effort and output tokens, and honours an explicit effort", async () => {
    await client(ok()).complete(req({ role: "writer" }));
    await client(ok()).complete(req({ role: "scorer", effort: "high" }));
    const [writer, scorer] = starts();
    expect(writer?.argv.slice(writer.argv.indexOf("--model"), writer.argv.indexOf("--model") + 4)).toEqual(["--model", "claude-opus-5-5", "--effort", "high"]);
    expect(writer?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
    expect(scorer?.argv).toContain("claude-haiku-5-5");
    expect(scorer?.argv[scorer.argv.indexOf("--effort") + 1]).toBe("high");
  });

  it("writes a neutral system prompt when the request has none (an empty file would restore Claude Code's own)", async () => {
    await client(ok()).complete(req({ system: "" }));
    expect(starts()[0]?.systemPrompt).toBe("Answer the user's request.");
  });

  it("sends every user content block on stdin in order, images included", async () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" } };
    await client(ok()).complete(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "Step 3. What is on the page?" }, image] },
          { role: "user", content: "And then?" },
        ],
      }),
    );
    const sent = JSON.parse(starts()[0]?.stdin ?? "{}");
    expect(sent).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Step 3. What is on the page?" }, image, { type: "text", text: "And then?" }] },
    });
  });

  it("passes the schema as JSON Schema and validates the structured output against the zod schema", async () => {
    const schema = z.object({ score: z.number().int().min(0).max(10), reason: z.string() });
    const res = await client(ok({ structured_output: { score: 8, reason: "close match" }, result: '{"score":8,"reason":"close match"}', stop_reason: "tool_use" })).complete(
      req({ role: "scorer", schema }),
    );
    expect(res.parsed).toEqual({ score: 8, reason: "close match" });
    const argv = starts()[0]?.argv ?? [];
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1] as string)).toEqual(zodOutputFormat(schema).schema);
  });

  it("reports structured output that does not match as provider / schema", async () => {
    const schema = z.object({ score: z.number().int().max(10) });
    const err = await caught(client(ok({ structured_output: { score: 99 } })).complete(req({ schema })));
    expect(err).toMatchObject({ code: "provider", kind: "schema", retryable: false });
  });

  it("refuses a schema too large for the Windows command line before starting claude", async () => {
    const big = z.object(Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`field_with_a_long_name_${i}`, z.string()])));
    expect(JSON.stringify(zodOutputFormat(big).schema).length).toBeGreaterThan(MAX_SCHEMA_CHARS);
    const err = await caught(client(ok()).complete(req({ schema: big })));
    expect(err).toMatchObject({ code: "internal", kind: "schema" });
    expect(starts()).toHaveLength(0);
  });
});

describe("claude-cli backend: reading the reply", () => {
  it("maps text, usage, the API-equivalent cost and the model that wrote most of the output, and records both meters", async () => {
    const clientMeter = new CostMeter();
    const callMeter = new CostMeter();
    const res = await client(ok(), { meter: clientMeter }).complete(req({ meter: callMeter }));
    expect(res).toMatchObject({
      text: "hello",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7 },
      costUsd: 0.0123,
      model: "claude-sonnet-5-5",
      stopReason: "end_turn",
    });
    expect(clientMeter.totalCostUsd).toBeCloseTo(0.0123);
    expect(callMeter.calls).toBe(1);
  });

  it("checks the meters before starting claude", async () => {
    const meter = new CostMeter({ maxCostUsd: 0.01 });
    meter.record({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.02);
    const err = await caught(client(ok()).complete(req({ meter })));
    expect(err.code).toBe("budget_exceeded");
    expect(starts()).toHaveLength(0);
  });

  it("keeps the plan status Claude reports", async () => {
    const c = client(ok());
    expect(c.planStatus()).toBeUndefined();
    await c.complete(req());
    expect(c.planStatus()).toEqual({
      status: "allowed",
      resetsAt: 1793060400,
      windows: { five_hour: { utilization: 0.04, resetsAt: 1793060400 }, seven_day: { utilization: 0.6, resetsAt: 1793214000 } },
    });
  });

  it("warns when claude says it is signed in with an API key", async () => {
    const logger = makeLogger();
    await client({ events: [{ ...init, apiKeySource: "ANTHROPIC_API_KEY" }, result()] }, { logger }).complete(req());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("API key"), expect.objectContaining({ api_key_source: "ANTHROPIC_API_KEY" }));
  });

  it("maps a refusal like the API client does", async () => {
    const err = await caught(client(ok({ stop_reason: "refusal" })).complete(req()));
    expect(err).toMatchObject({ code: "provider", kind: "refusal" });
  });
});

describe("claude-cli backend: errors (PLAN.md 15.3)", () => {
  it("an executable that does not exist is config / not_configured naming claude_path", async () => {
    const err = await caught(client(ok(), { command: join(dir, "no-such-claude.exe") }).complete(req()));
    expect(err).toMatchObject({ code: "config", kind: "not_configured", retryable: false });
    expect(err.message).toContain("claude_path");
  });

  it("a claude that is not signed in is config", async () => {
    const err = await caught(
      client({ events: [init, result({ is_error: true, subtype: "success", result: "Not logged in · Please run /login" })], exitCode: 1 }).complete(req()),
    );
    expect(err).toMatchObject({ code: "config", kind: "api", retryable: false });
  });

  it("a rejected plan status is a plan-limit rate_limit carrying the reset time", async () => {
    const err = await caught(
      client({ events: [init, rateEvent("rejected"), result({ is_error: true, result: "You've hit your limit · resets 5pm" })], exitCode: 1 }).complete(req()),
    );
    expect(err).toMatchObject({ code: "provider", kind: "rate_limit", retryable: false, details: { plan_limit: true, resets_at: 1793060400, status: "rejected" } });
    expect(err.message).toContain(new Date(1793060400 * 1000).toISOString());
  });

  it("a usage-limit message is a plan limit even without a rate limit event", async () => {
    const err = await caught(client({ events: [init, result({ is_error: true, result: "Claude AI usage limit reached|1793060400" })], exitCode: 1 }).complete(req()));
    expect(err).toMatchObject({ kind: "rate_limit", details: { plan_limit: true } });
  });

  it("an earlier rejection does not fail a later call that worked", async () => {
    const c = client({ events: [init, rateEvent("rejected"), result({ is_error: true, result: "usage limit reached" })], exitCode: 1 });
    await caught(c.complete(req()));
    // The same client, now with a scenario that succeeds and reports no rate limit event.
    const c2 = client({ events: [init, result()] });
    await expect(c2.complete(req())).resolves.toMatchObject({ text: "hello" });
  });

  it("an HTTP 429 is a retryable rate limit, not the plan limit", async () => {
    const err = await caught(client({ events: [init, result({ is_error: true, api_error_status: 429, result: "API Error: 429" })], exitCode: 1 }).complete(req()));
    expect(err).toMatchObject({ code: "provider", kind: "rate_limit", retryable: true });
    expect((err.details as { plan_limit?: boolean }).plan_limit).toBeUndefined();
  });

  it("a server-side API error is a retryable provider error; a client-side one is not", async () => {
    const overloaded = await caught(client({ events: [init, result({ is_error: true, api_error_status: 529, result: "Overloaded" })], exitCode: 1 }).complete(req()));
    expect(overloaded).toMatchObject({ code: "provider", kind: "api", retryable: true, details: { status: 529 } });
    const bad = await caught(client({ events: [init, result({ is_error: true, api_error_status: 400, result: "bad request" })], exitCode: 1 }).complete(req()));
    expect(bad).toMatchObject({ code: "provider", kind: "api", retryable: false });
  });

  it("an exit without a result is a provider error with the last stderr line, secrets redacted", async () => {
    const err = await caught(client({ events: [init], exitCode: 3, stderr: "boom\nfatal: token=abc123secret" }).complete(req()));
    expect(err).toMatchObject({ code: "provider", kind: "api" });
    expect(JSON.stringify(err.details)).toContain("[redacted]");
    expect(JSON.stringify(err.details)).not.toContain("abc123secret");
  });

  it("a claude that does not answer in time is killed and reported as a retryable timeout", async () => {
    const err = await caught(client({ ...ok(), delayMs: 20_000 }, { timeoutMs: 1500 }).complete(req()));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect(isAlive(starts()[0]?.pid)).toBe(false);
  });

  it("an abort kills claude and is a timeout that is not retried", async () => {
    const controller = new AbortController();
    const pending = client({ ...ok(), delayMs: 20_000 }).complete(req({ signal: controller.signal }));
    await vi.waitFor(() => expect(starts()).toHaveLength(1), { timeout: 10_000 });
    controller.abort();
    const err = await caught(pending);
    expect(err).toMatchObject({ code: "timeout", retryable: false });
    expect(isAlive(starts()[0]?.pid)).toBe(false);
  });
});

describe("claude-cli backend: concurrency", () => {
  it("runs no more claude processes at once than the slots allow", async () => {
    const slots = new Slots(2);
    const c = client({ ...ok(), delayMs: 400 }, { slots });
    await Promise.all(Array.from({ length: 5 }, () => c.complete(req())));
    const events = records()
      .map((r) => ({ at: r.at, delta: r.phase === "start" ? 1 : -1 }))
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let running = 0;
    let peak = 0;
    for (const e of events) {
      running += e.delta;
      peak = Math.max(peak, running);
    }
    expect(events.filter((e) => e.delta === 1)).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(2);
    expect(slots.inUse).toBe(0);
  }, 30_000);
});

describe("stdinMessage", () => {
  it("renders a conversation with an assistant turn as a transcript and keeps its images", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" } };
    const sent = JSON.parse(
      stdinMessage([
        { role: "user", content: [{ type: "text", text: "first" }, image] },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    );
    expect(sent.message.content).toEqual([{ type: "text", text: "User:\nfirst\n\nAssistant:\nreply\n\nUser:\nsecond" }, image]);
  });
});

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
