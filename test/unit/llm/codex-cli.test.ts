import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildPrompt, createCodexCliClient, DISABLED_FEATURES, dropOptionalNulls, strictSchema, type CodexCliOptions } from "../../../src/core/llm/codex-cli.js";
import { computeCost, CostMeter } from "../../../src/core/llm/cost.js";
import { DEFAULT_CODEX_MODEL } from "../../../src/core/llm/models.js";
import { Slots } from "../../../src/core/llm/process.js";
import { LlmError, type LlmRequest } from "../../../src/core/llm/types.js";
import { makeConfig, makeLogger } from "./helpers.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "llm", "fake-codex.mjs");

interface Scenario {
  events?: object[];
  delayMs?: number;
  exitCode?: number;
  stderr?: string;
  grandchild?: boolean;
}

interface StartRecord {
  pid: number;
  phase: "start";
  at: number;
  argv: string[];
  cwd: string;
  stdin: string;
  schema: Record<string, unknown> | null;
  images: Array<{ file: string; base64: string | null }>;
  grandchildPid: number | null;
  env: { OPENAI_API_KEY: string | null; CODEX_API_KEY: string | null };
}

const message = (text: string) => ({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
const usageEvent = (over: Record<string, number> = {}) => ({
  type: "turn.completed",
  usage: { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10, ...over },
});
const ok = (text = "hello"): Scenario => ({
  events: [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, message(text), usageEvent()],
});
const failed = (msg: string, exitCode = 1): Scenario => ({
  events: [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "turn.failed", error: { message: msg } }],
  exitCode,
});

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  role: "extractor",
  system: "You extract.",
  messages: [{ role: "user", content: "Read this page." }],
  ...over,
});

let dir: string;
let recordFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-codex-cli-"));
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

function client(scenario: Scenario, over: Partial<CodexCliOptions> = {}, config = makeConfig()) {
  return createCodexCliClient(config, {
    command: FAKE,
    workDir: join(dir, "work"),
    logger: makeLogger(),
    env: {
      ...process.env,
      FAKE_CODEX_SCENARIO: JSON.stringify(scenario),
      FAKE_CODEX_RECORD: recordFile,
      OPENAI_API_KEY: "sk-must-not-reach-codex",
      codex_api_key: "lower-case-must-not-reach-codex-either",
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

describe("codex-cli backend: how codex is started (PLAN.md 15.4)", () => {
  it("passes exactly the isolating flags: no user config, no rules, no tools, an empty working directory", async () => {
    await client(ok()).complete(req());
    const [rec] = starts();
    const cwd = rec?.cwd as string;
    expect(rec?.argv).toEqual([
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s", "read-only",
      "--json",
      "-C", cwd,
      "-m", DEFAULT_CODEX_MODEL,
      "-c", 'model_reasoning_effort="medium"',
      "-c", 'web_search="disabled"',
      "-c", "project_doc_max_bytes=0",
      ...DISABLED_FEATURES.flatMap((f) => ["-c", `features.${f}=false`]),
      "-",
    ]);
    // Every agent tool that could run a command or reach outside the prompt is off.
    expect(DISABLED_FEATURES).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "browser_use", "computer_use"]));
    // --disable fails on a feature the installed Codex does not know; -c features.* does not.
    expect(rec?.argv).not.toContain("--disable");
    // The call's own directory, removed afterwards.
    expect(dirname(cwd)).toBe(join(dir, "work"));
    expect(existsSync(cwd)).toBe(false);
  });

  it("uses codex_model when set and the request's effort, else the role default", async () => {
    await client(ok(), {}, makeConfig({ codex_model: "gpt-6.1-terra" })).complete(req({ role: "scorer" }));
    await client(ok()).complete(req({ role: "writer", effort: "xhigh" }));
    const [a, b] = starts();
    expect(a?.argv.slice(a.argv.indexOf("-m"), a.argv.indexOf("-m") + 4)).toEqual(["-m", "gpt-6.1-terra", "-c", 'model_reasoning_effort="low"']);
    expect(b?.argv).toContain('model_reasoning_effort="xhigh"');
  });

  it("never hands codex an OpenAI API key, so the ChatGPT plan is used", async () => {
    await client(ok()).complete(req());
    expect(starts()[0]?.env).toEqual({ OPENAI_API_KEY: null, CODEX_API_KEY: null });
  });

  it("sends the system prompt and then the user text on stdin", async () => {
    await client(ok()).complete(req({ messages: [{ role: "user", content: [{ type: "text", text: "Part one." }, { type: "text", text: "Part two." }] }] }));
    await client(ok()).complete(req({ system: "" }));
    expect(starts().map((r) => r.stdin)).toEqual(["You extract.\n\nPart one.\n\nPart two.", "Read this page."]);
  });

  it("writes base64 images to files passed with --image before every other flag", async () => {
    const png = Buffer.from("not really a png").toString("base64");
    await client(ok()).complete(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What does it show?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } },
            ],
          },
        ],
      }),
    );
    const [rec] = starts();
    expect(rec?.argv.slice(0, 5)).toEqual(["exec", "--image", rec?.images[0]?.file, "--image", rec?.images[1]?.file]);
    expect(rec?.images.map((i) => [i.file.slice(-11), i.base64])).toEqual([
      ["image-1.png", png],
      ["image-2.jpg", png],
    ]);
    expect(rec?.stdin).toBe("You extract.\n\nWhat does it show?");
  });
});

describe("codex-cli backend: structured output (PLAN.md 15.4)", () => {
  const Schema = z.object({
    title: z.string(),
    url: z.url().optional(),
    note: z.string().nullable(),
    tags: z.array(z.object({ name: z.string(), weight: z.number().optional() })),
  });

  it("hands codex a strict schema: all properties required, optional ones nullable, objects closed, no uri format", async () => {
    await client(ok('{"title":"t","url":null,"note":null,"tags":[]}')).complete(req({ schema: Schema }));
    const [rec] = starts();
    expect(rec?.argv.slice(-3)).toEqual(["--output-schema", join(rec?.cwd as string, "schema.json"), "-"]);
    const s = rec?.schema as { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
    expect(s.required).toEqual(["title", "url", "note", "tags"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties["url"]).toEqual({ type: ["string", "null"] });
    const tagItems = (s.properties["tags"] as { items: { required: string[]; additionalProperties: boolean } }).items;
    expect(tagItems).toMatchObject({ required: ["name", "weight"], additionalProperties: false });
  });

  it("drops the nulls the model wrote for optional fields and keeps those of nullable required fields", async () => {
    const res = await client(ok('{"title":"t","url":null,"note":null,"tags":[{"name":"a","weight":null}]}')).complete(req({ schema: Schema }));
    expect(res.parsed).toEqual({ title: "t", note: null, tags: [{ name: "a" }] });
  });

  it("reports output that does not match, or is not JSON, as provider / schema", async () => {
    expect(await caught(client(ok('{"title":1}')).complete(req({ schema: Schema })))).toMatchObject({ code: "provider", kind: "schema", retryable: false });
    expect(await caught(client(ok("not json")).complete(req({ schema: Schema })))).toMatchObject({ code: "provider", kind: "schema" });
  });

  it("wraps a root that is not an object and unwraps the answer", async () => {
    const Union = z.union([z.object({ kind: z.literal("a"), a: z.string() }), z.object({ kind: z.literal("b"), b: z.number() })]);
    const res = await client(ok('{"value":{"kind":"b","b":2}}')).complete(req({ schema: Union }));
    expect(res.parsed).toEqual({ kind: "b", b: 2 });
    expect(starts()[0]?.schema).toMatchObject({ type: "object", required: ["value"], additionalProperties: false });
  });
});

describe("strictSchema and dropOptionalNulls", () => {
  it("makes an optional $ref nullable through anyOf, keeps supported formats and drops the $schema dialect", () => {
    const Item = z.object({ at: z.iso.datetime(), mode: z.enum(["x", "y"]).optional() });
    const { schema, wrapped } = strictSchema(zodOutputFormat(z.object({ first: Item, second: Item.optional() })).schema);
    expect(wrapped).toBe(false);
    const props = schema["properties"] as Record<string, unknown>;
    expect(props["second"]).toEqual({ anyOf: [props["first"], { type: "null" }] });
    const def = Object.values(schema["$defs"] as Record<string, { properties: Record<string, Record<string, unknown>>; required: string[] }>)[0];
    expect(def?.required).toEqual(["at", "mode"]);
    expect(def?.properties["at"]?.["format"]).toBe("date-time");
    expect(def?.properties["mode"]?.["type"]).toEqual(["string", "null"]);
    expect(schema["$schema"]).toBeUndefined();
  });

  it("follows $refs and leaves nulls of keys a branch does not know alone", () => {
    const original = {
      type: "object",
      properties: { a: { $ref: "#/$defs/A" }, b: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["a", "b"],
      $defs: { A: { type: "object", properties: { x: { type: "string" } }, required: [] } },
    };
    expect(dropOptionalNulls({ a: { x: null, extra: null }, b: null }, original, original.$defs)).toEqual({ a: { extra: null }, b: null });
  });
});

describe("codex-cli backend: reading the reply", () => {
  it("maps text, usage (cached and written tokens kept apart), the API-equivalent cost and the model, and records both meters", async () => {
    const meter = new CostMeter();
    const clientMeter = new CostMeter();
    const res = await client(ok("the answer"), { meter: clientMeter }).complete(req({ meter }));
    const usage = { inputTokens: 700, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 100 };
    expect(res).toEqual({ text: "the answer", usage, costUsd: computeCost(DEFAULT_CODEX_MODEL, usage), model: DEFAULT_CODEX_MODEL, stopReason: null });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(meter.calls).toBe(1);
    expect(clientMeter.calls).toBe(1);
  });

  it("checks the meters before starting codex", async () => {
    const meter = new CostMeter({ maxCostUsd: 0.000001 });
    meter.record({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1);
    await expect(client(ok()).complete(req({ meter }))).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(starts()).toHaveLength(0);
  });

  it("takes the last agent message and ignores warning items", async () => {
    const scenario = ok("final");
    scenario.events?.splice(2, 0, message("draft"), { type: "item.completed", item: { id: "w", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting" } });
    expect((await client(scenario).complete(req())).text).toBe("final");
  });
});

describe("codex-cli backend: errors", () => {
  it("an executable that does not exist is config / not_configured naming codex_path", async () => {
    const err = await caught(client(ok(), { command: join(dir, "no-such-codex.exe") }).complete(req()));
    expect(err).toMatchObject({ code: "config", kind: "not_configured", retryable: false });
    expect(err.message).toContain("codex_path");
  });

  it("the ChatGPT plan's usage limit is a plan-limit rate_limit", async () => {
    const err = await caught(client(failed("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")).complete(req()));
    expect(err).toMatchObject({ code: "provider", kind: "rate_limit", retryable: false, details: { plan_limit: true } });
  });

  it("a codex that is not signed in is config, telling the owner to run codex login", async () => {
    const err = await caught(client(failed("unexpected status 401 Unauthorized: token expired")).complete(req()));
    expect(err).toMatchObject({ code: "config", kind: "api", retryable: false });
    expect(err.message).toContain("codex login");
  });

  it("a 429 is a retryable rate limit without plan_limit, and a server error a retryable provider error", async () => {
    const rate = await caught(client(failed("exceeded retry limit, last status: 429 Too Many Requests")).complete(req()));
    expect(rate).toMatchObject({ code: "provider", kind: "rate_limit", retryable: true });
    expect((rate.details as Record<string, unknown>)["plan_limit"]).toBeUndefined();
    const server = await caught(client(failed("stream disconnected before completion: 503 Service Unavailable")).complete(req()));
    expect(server).toMatchObject({ code: "provider", kind: "api", retryable: true });
    const client400 = await caught(client({ events: [{ type: "error", message: "invalid_json_schema: bad schema" }], exitCode: 1 }).complete(req()));
    expect(client400).toMatchObject({ code: "provider", kind: "api", retryable: false });
  });

  it("a non-zero exit without events is a provider error with the last stderr line, secrets redacted", async () => {
    const err = await caught(client({ exitCode: 2, stderr: "Error: config failed\nrequest sent with Bearer abc.def" }).complete(req()));
    expect(err).toMatchObject({ code: "provider", kind: "api", retryable: false, details: { stderr: "request sent with Bearer [redacted]" } });
  });

  it("an exit without an answer is a provider error", async () => {
    const err = await caught(client({ events: [{ type: "turn.started" }, usageEvent()] }).complete(req()));
    expect(err).toMatchObject({ code: "provider", kind: "api", message: "codex finished without an answer" });
  });

  it("a codex that does not answer in time is killed and reported as a retryable timeout", async () => {
    const err = await caught(client({ ...ok(), delayMs: 20_000 }, { timeoutMs: 300 }).complete(req()));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect(isAlive(starts()[0]?.pid)).toBe(false);
  });

  it("an abort kills codex and anything it started, and is a timeout that is not retried", async () => {
    const controller = new AbortController();
    const pending = client({ ...ok(), delayMs: 20_000, grandchild: true }).complete(req({ signal: controller.signal }));
    await vi.waitFor(() => expect(starts()).toHaveLength(1), { timeout: 10_000 });
    controller.abort();
    const err = await caught(pending);
    expect(err).toMatchObject({ code: "timeout", retryable: false });
    const [rec] = starts();
    expect(isAlive(rec?.pid)).toBe(false);
    await vi.waitFor(() => expect(isAlive(rec?.grandchildPid ?? undefined)).toBe(false), { timeout: 5_000 });
  }, 30_000);
});

describe("codex-cli backend: concurrency", () => {
  it("runs no more codex processes at once than the slots allow", async () => {
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

describe("buildPrompt", () => {
  it("renders a conversation with an assistant turn as a transcript, and a URL image as text", () => {
    const p = buildPrompt("Sys.", [
      { role: "user", content: "Question?" },
      { role: "assistant", content: "Answer." },
      { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] },
    ]);
    expect(p).toEqual({ text: "Sys.\n\nUser:\nQuestion?\n\nAssistant:\nAnswer.\n\nUser:\n[image: https://example.com/a.png]", images: [] });
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
