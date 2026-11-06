import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunOptions, RunProcess, RunResult } from "../../../src/core/llm/process.js";
import { TOOL_NAMES } from "../../../src/tools/index.js";
import {
  NO_CLAUDE_PATH,
  OFF_FEATURES,
  SMOKE_TOOLS,
  WEBRUNNER_TOOLS,
  codexArgs,
  describeArm,
  tomlString,
  type ArmOptions,
} from "../../evals/codex/arms.js";
import {
  answerText,
  formatReveal,
  inlineCitations,
  maskNames,
  parseCsv,
  perplexityTemplate,
  readAnswer,
  reveal,
  shuffled,
  writeBlind,
  writePerplexityTemplates,
  type BlindKey,
} from "../../evals/codex/blind.js";
import { countTools, readEvents } from "../../evals/codex/events.js";
import {
  formatSummary,
  readRecord,
  runBatch,
  runOne,
  smokeProblems,
  type RunRecord,
} from "../../evals/codex/run.js";
import { QuestionsFileSchema, loadQuestions, selectQuestions, type Question } from "../../evals/codex/schema.js";

/**
 * The Codex question-set runner (PLAN.md 17.4, WP55). Nothing here starts a
 * real codex process: every run goes through a fake RunProcess.
 */

const tmp = mkdtempSync(join(tmpdir(), "webrunner-codex-evals-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;
function freshDir(): string {
  const dir = join(tmp, `d${++dirs}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const BASE: Omit<ArmOptions, "serverLlm"> & { serverLlm: ArmOptions["serverLlm"] } = {
  workDir: "W",
  lastMessageFile: "W/last.md",
  model: "gpt-test",
  effort: "high",
  webrunnerEntry: "C:\\repo\\dist\\index.js",
  serverLlm: "config",
};

/** The value of each `-c key=value` override, by key. */
function overrides(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  args.forEach((a, i) => {
    if (a !== "-c") return;
    const kv = args[i + 1] ?? "";
    const eq = kv.indexOf("=");
    map.set(kv.slice(0, eq), kv.slice(eq + 1));
  });
  return map;
}

function line(event: unknown): string {
  return JSON.stringify(event);
}

// ---------------------------------------------------------------------------
// questions.json
// ---------------------------------------------------------------------------

describe("codex questions.json", () => {
  const questions = loadQuestions();

  it("holds the owner's four questions and twelve probes", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("../../evals/codex/questions.json", import.meta.url), "utf8"));
    expect(QuestionsFileSchema.safeParse(raw).success).toBe(true);
    expect(questions.filter((q) => q.group === "owner").map((q) => q.id)).toEqual(["U1", "U2", "U3", "U4"]);
    expect(questions.filter((q) => q.group === "probe")).toHaveLength(12);
  });

  it("keeps the owner's prompts short and plain", () => {
    for (const q of questions) expect(q.prompt.length, q.id).toBeLessThan(140);
  });

  it("rejects a probe without a check, a mislabelled group and a duplicate id", () => {
    const probe = { id: "P1", group: "probe", prompt: "A prompt long enough", good: "A good answer does this", probes: "x" };
    expect(QuestionsFileSchema.safeParse([probe]).success).toBe(false);
    const owner = { id: "U1", group: "probe", prompt: "A prompt long enough", good: "A good answer does this", probes: "x", check: "y" };
    expect(QuestionsFileSchema.safeParse([owner]).success).toBe(false);
    const ok = { id: "U1", group: "owner", prompt: "A prompt long enough", good: "A good answer does this" };
    expect(QuestionsFileSchema.safeParse([ok]).success).toBe(true);
    expect(QuestionsFileSchema.safeParse([ok, ok]).success).toBe(false);
  });

  it("selects questions by id, in file order, and refuses an unknown id", () => {
    expect(selectQuestions(questions, ["p3", " U1"]).map((q) => q.id)).toEqual(["U1", "P3"]);
    expect(selectQuestions(questions, undefined)).toHaveLength(questions.length);
    expect(() => selectQuestions(questions, ["U9"])).toThrow(/U9/);
  });
});

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

describe("codexArgs", () => {
  it("isolates both arms from the owner's config and switches every agent tool off", () => {
    for (const arm of ["alone", "webrunner"] as const) {
      const args = codexArgs(arm, BASE);
      expect(args[0]).toBe("exec");
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ephemeral");
      expect(args.join(" ")).toContain("-s read-only");
      expect(args).toContain("--json");
      expect(args.at(-1)).toBe("-");
      const c = overrides(args);
      for (const f of OFF_FEATURES) expect(c.get(`features.${f}`), `${arm} ${f}`).toBe("false");
      expect(c.get("model_reasoning_effort")).toBe('"high"');
      expect(args[args.indexOf("-o") + 1]).toBe("W/last.md");
      expect(args[args.indexOf("-C") + 1]).toBe("W");
    }
  });

  it("gives the alone arm Codex's live web search and no MCP server", () => {
    const c = overrides(codexArgs("alone", BASE));
    expect(c.get("web_search")).toBe('"live"');
    expect([...c.keys()].some((k) => k.startsWith("mcp_servers"))).toBe(false);
  });

  it("gives the webrunner arm only webrunner's reach tools, with Codex's own search off", () => {
    const c = overrides(codexArgs("webrunner", BASE));
    expect(c.get("web_search")).toBe('"disabled"');
    expect(c.get("mcp_servers.webrunner.command")).toBe('"node"');
    expect(c.get("mcp_servers.webrunner.args")).toBe('["C:/repo/dist/index.js"]');
    const tools = JSON.parse(c.get("mcp_servers.webrunner.enabled_tools") ?? "[]") as string[];
    expect(tools).toEqual([...WEBRUNNER_TOOLS]);
    for (const t of tools) expect(TOOL_NAMES as readonly string[]).toContain(t);
    for (const t of ["deep_research", "accounts", "resume", "health", "ping"]) expect(tools).not.toContain(t);
    expect(c.get("mcp_servers.webrunner.default_tools_approval_mode")).toBe('"approve"');
    expect(c.get("mcp_servers.webrunner.tool_timeout_sec")).toBe("900");
    expect(c.has("mcp_servers.webrunner.env.BROWSER_CDP_URL")).toBe(false);
    expect(c.has("mcp_servers.webrunner.env.WEBRUNNER_LLM_BACKEND")).toBe(false);
  });

  it("adds the owner's Chrome, the no-model server and the smoke tools only when asked", () => {
    const c = overrides(codexArgs("webrunner", { ...BASE, cdpUrl: "http://127.0.0.1:9222", serverLlm: "none", smoke: true }));
    expect(c.get("mcp_servers.webrunner.env.BROWSER_CDP_URL")).toBe('"http://127.0.0.1:9222"');
    expect(c.get("mcp_servers.webrunner.env.WEBRUNNER_LLM_BACKEND")).toBe('"claude-cli"');
    expect(c.get("mcp_servers.webrunner.env.WEBRUNNER_CLAUDE_PATH")).toBe(tomlString(NO_CLAUDE_PATH));
    expect(c.get("mcp_servers.webrunner.env.WEBRUNNER_LLM_FALLBACK")).toBe('"none"');
    const tools = JSON.parse(c.get("mcp_servers.webrunner.enabled_tools") ?? "[]") as string[];
    for (const t of SMOKE_TOOLS) expect(tools).toContain(t);
  });

  it("leaves a feature on when enabled, in both arms", () => {
    for (const arm of ["alone", "webrunner"] as const) {
      const c = overrides(codexArgs(arm, { ...BASE, enable: ["multi_agent"] }));
      expect(c.has("features.multi_agent")).toBe(false);
      expect(c.get("features.shell_tool")).toBe("false");
    }
    expect(describeArm("alone", { serverLlm: "config", enable: ["multi_agent"] })).toContain("multi_agent");
  });

  it("writes TOML strings with quotes and backslashes escaped", () => {
    expect(tomlString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

describe("readEvents", () => {
  it("reads the plan's usage limit from a real codex stream, once", () => {
    const stream = readFileSync(new URL("../../fixtures/evals/codex-limit.events.jsonl", import.meta.url), "utf8");
    const events = readEvents(stream);
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]).toMatch(/usage limit/);
    expect(events.answer).toBeUndefined();
    expect(events.toolCalls).toEqual([]);
  });

  it("collects tool calls, the last answer and usage summed over turns", () => {
    const stream = [
      line({ type: "thread.started", thread_id: "t" }),
      line({ type: "item.started", item: { id: "1", type: "web_search", query: "egx30" } }),
      line({ type: "item.completed", item: { id: "1", type: "web_search", query: "egx30" } }),
      line({ type: "item.completed", item: { id: "2", type: "mcp_tool_call", server: "webrunner", tool: "fetch_page", status: "completed" } }),
      line({ type: "item.completed", item: { id: "3", type: "mcp_tool_call", server: "webrunner", tool: "fetch_page", status: "failed", error: { message: "blocked" } } }),
      line({ type: "item.completed", item: { id: "4", type: "command_execution", command: "curl x", status: "completed" } }),
      line({ type: "item.completed", item: { id: "5", type: "reasoning", text: "thinking" } }),
      line({ type: "item.completed", item: { id: "6", type: "agent_message", text: "first" } }),
      line({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }),
      "not json",
      line({ type: "item.completed", item: { id: "7", type: "agent_message", text: "final answer" } }),
      line({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 5 } }),
    ].join("\n");
    const events = readEvents(stream);
    expect(events.answer).toBe("final answer");
    expect(events.usage).toEqual({ input_tokens: 150, cached_input_tokens: 40, output_tokens: 15 });
    expect(events.badLines).toBe(1);
    expect(countTools(events.toolCalls)).toEqual({ web_search: 1, "webrunner.fetch_page": 2, command_execution: 1 });
    expect(events.toolCalls.filter((c) => c.error !== undefined)).toEqual([
      { kind: "mcp", name: "webrunner.fetch_page", status: "failed", error: "blocked" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

interface FakeCall {
  opts: RunOptions;
}

/** A RunProcess that answers from `reply` and writes the -o file when told to. */
function fakeRun(reply: (opts: RunOptions) => Partial<RunResult> & { lastMessage?: string }, calls: FakeCall[] = []): RunProcess {
  return (opts) => {
    calls.push({ opts });
    const r = reply(opts);
    if (r.lastMessage !== undefined) {
      const file = opts.args[opts.args.indexOf("-o") + 1] as string;
      writeFileSync(file, r.lastMessage, "utf8");
    }
    return Promise.resolve({ exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.killed !== undefined && { killed: r.killed }) });
  };
}

const ARM_OPTIONS = { model: "gpt-test", effort: "high", webrunnerEntry: "dist/index.js", serverLlm: "config" as const };
const Q1 = { id: "U1", prompt: "Which crypto platforms have the lowest fees?" };
const Q2 = { id: "P1", prompt: "Who is Egypt's Minister of Finance right now?" };

const answered = (text: string, tools: unknown[] = []): Partial<RunResult> & { lastMessage?: string } => ({
  stdout: [
    ...tools.map((item) => line({ type: "item.completed", item })),
    line({ type: "item.completed", item: { type: "agent_message", text } }),
    line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join("\n"),
  lastMessage: text,
});

describe("runOne", () => {
  it("sends the prompt as written, without API keys, and writes the answer, the events and the record", async () => {
    const out = freshDir();
    const calls: FakeCall[] = [];
    const run = fakeRun(() => answered("The answer.", [{ type: "web_search", query: "q" }]), calls);
    const env = { PATH: "x", OPENAI_API_KEY: "sk-test", codex_api_key: "k" };
    const record = await runOne({ question: Q1, arm: "alone", out, codex: "codex-fake", armOptions: ARM_OPTIONS, timeoutMs: 1000, run, env });

    expect(record.outcome).toBe("answered");
    expect(record.tools).toEqual({ web_search: 1 });
    expect(record.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    const sent = calls[0]?.opts as RunOptions;
    expect(sent.stdin).toBe(Q1.prompt);
    expect(sent.command).toBe("codex-fake");
    expect(Object.keys(sent.env)).toEqual(["PATH"]);
    expect(readFileSync(join(out, "alone", "U1.md"), "utf8")).toBe("The answer.\n");
    expect(readFileSync(join(out, "alone", "U1.events.jsonl"), "utf8")).toContain("agent_message");
    expect(readRecord(out, "alone", "U1")?.outcome).toBe("answered");
    // The empty working directory is removed afterwards.
    expect(existsSync(sent.cwd)).toBe(false);
  });

  it("falls back to the last agent message when there is no -o file", async () => {
    const out = freshDir();
    const run = fakeRun(() => ({ stdout: line({ type: "item.completed", item: { type: "agent_message", text: "from events" } }) }));
    const record = await runOne({ question: Q1, arm: "webrunner", out, codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run });
    expect(record.outcome).toBe("answered");
    expect(readFileSync(join(out, "webrunner", "U1.md"), "utf8")).toBe("from events\n");
  });

  it("names the usage limit, a timeout, a sign-in problem and a process that could not start", async () => {
    const limitStream = readFileSync(new URL("../../fixtures/evals/codex-limit.events.jsonl", import.meta.url), "utf8");
    const cases: [RunProcess, RunRecord["outcome"]][] = [
      [fakeRun(() => ({ stdout: limitStream, exitCode: 1 })), "limit"],
      [fakeRun(() => ({ ...answered("partial"), killed: "timeout", exitCode: null })), "timeout"],
      [fakeRun(() => ({ stderr: "Error: not logged in; run codex login", exitCode: 1 })), "auth"],
      [fakeRun(() => ({ exitCode: 0 })), "no_answer"],
      [() => Promise.reject(new Error("spawn ENOENT")), "failed"],
    ];
    for (const [run, outcome] of cases) {
      const record = await runOne({ question: Q1, arm: "alone", out: freshDir(), codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run });
      expect(record.outcome).toBe(outcome);
    }
  });

  it("does not take a server's log line about a limit for Codex's own limit when there is an answer", async () => {
    const run = fakeRun(() => ({ ...answered("fine"), stderr: "webrunner: claude-cli hit your limit, falling back" }));
    const record = await runOne({ question: Q1, arm: "webrunner", out: freshDir(), codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run });
    expect(record.outcome).toBe("answered");
  });
});

describe("runBatch", () => {
  it("runs both arms per question, alternating which goes first", async () => {
    const order: string[] = [];
    const run = fakeRun((opts) => {
      order.push(opts.args.includes('web_search="live"') ? "alone" : "webrunner");
      return answered("ok");
    });
    const result = await runBatch({ questions: [Q1, Q2], arms: ["alone", "webrunner"], out: freshDir(), codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run });
    expect(order).toEqual(["alone", "webrunner", "webrunner", "alone"]);
    expect(result.records).toHaveLength(4);
    expect(result.stoppedBy).toBeUndefined();
  });

  it("skips answered questions on a rerun unless forced, and stops at the usage limit", async () => {
    const out = freshDir();
    let n = 0;
    const ok = fakeRun(() => {
      n += 1;
      return answered("ok");
    });
    await runBatch({ questions: [Q1], arms: ["alone"], out, codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run: ok });
    const skipped: string[] = [];
    await runBatch({ questions: [Q1], arms: ["alone"], out, codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run: ok, onSkip: (id) => skipped.push(id) });
    expect(n).toBe(1);
    expect(skipped).toEqual(["U1"]);
    await runBatch({ questions: [Q1], arms: ["alone"], out, codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run: ok, force: true });
    expect(n).toBe(2);

    const limitStream = readFileSync(new URL("../../fixtures/evals/codex-limit.events.jsonl", import.meta.url), "utf8");
    let calls = 0;
    const limited = fakeRun(() => {
      calls += 1;
      return { stdout: limitStream, exitCode: 1 };
    });
    const result = await runBatch({ questions: [Q1, Q2], arms: ["alone", "webrunner"], out: freshDir(), codex: "c", armOptions: ARM_OPTIONS, timeoutMs: 1000, run: limited });
    expect(result.stoppedBy).toBe("limit");
    expect(calls).toBe(1);
  });

  it("summarises the records as a table", () => {
    const rec = (id: string, arm: "alone" | "webrunner", tools: Record<string, number>): RunRecord => ({
      id, arm, outcome: "answered", startedAt: "", durationMs: 61_000, exitCode: 0, answerChars: 900, tools, toolErrors: [], usage: { input_tokens: 5, output_tokens: 1 }, errors: [],
    });
    const table = formatSummary([rec("P1", "webrunner", { "webrunner.fetch_page": 2 }), rec("U1", "alone", { web_search: 3 })]);
    const rows = table.split("\n");
    expect(rows[2]).toContain("| P1 | webrunner | answered | 61 s | 900 | 5 | 1 | fetch_page 2 |");
    expect(rows[3]).toContain("web_search 3");
  });
});

describe("smokeProblems", () => {
  const rec = (tools: Record<string, number>, outcome: RunRecord["outcome"] = "answered"): RunRecord => ({
    id: "SMOKE", arm: "alone", outcome, startedAt: "", durationMs: 0, exitCode: 0, answerChars: 10, tools, toolErrors: [], usage: {}, errors: [],
  });

  it("passes an arm that reached the web only through its own tools", () => {
    expect(smokeProblems("alone", rec({ web_search: 1 }))).toEqual([]);
    expect(smokeProblems("webrunner", rec({ "webrunner.health": 1, "webrunner.web_search": 1 }))).toEqual([]);
  });

  it("flags an arm that used the other arm's way to the web, or none", () => {
    expect(smokeProblems("alone", rec({}))).toHaveLength(1);
    expect(smokeProblems("alone", rec({ web_search: 1, "perplexity.perplexity_ask": 1 }))[0]).toMatch(/MCP tool/);
    expect(smokeProblems("webrunner", rec({ web_search: 1, "webrunner.health": 1, "webrunner.fetch_page": 1 }))[0]).toMatch(/should be off/);
    expect(smokeProblems("webrunner", rec({ "webrunner.health": 1 }))[0]).toMatch(/no webrunner search/);
    expect(smokeProblems("webrunner", rec({ "webrunner.health": 1, "webrunner.web_search": 1 }, "limit"))[0]).toMatch(/no answer/);
  });
});

// ---------------------------------------------------------------------------
// blind grading
// ---------------------------------------------------------------------------

const QUESTIONS: Question[] = [
  { id: "U1", group: "owner", prompt: "Which crypto platforms have the lowest fees?", good: "Names platforms with fees." },
  { id: "P1", group: "probe", prompt: "Who is Egypt's Minister of Finance?", good: "Right name, dated source.", probes: "stale facts", check: "The ministry's site." },
];

function writeAnswer(out: string, source: string, id: string, text: string): void {
  mkdirSync(join(out, source), { recursive: true });
  writeFileSync(join(out, source, `${id}.md`), text, "utf8");
}

describe("Perplexity templates", () => {
  it("writes one empty template per question with the prompt, and never overwrites a pasted answer", () => {
    const out = freshDir();
    expect(writePerplexityTemplates(out, QUESTIONS).written).toEqual(["U1", "P1"]);
    expect(readAnswer(out, "perplexity", "U1")).toBeUndefined();
    expect(readFileSync(join(out, "perplexity", "U1.md"), "utf8")).toContain(QUESTIONS[0]?.prompt);
    writeFileSync(join(out, "perplexity", "U1.md"), perplexityTemplate(QUESTIONS[0] as Question) + "Pasted answer [1].\n", "utf8");
    const again = writePerplexityTemplates(out, QUESTIONS);
    expect(again.kept).toEqual(["U1", "P1"]);
    expect(readAnswer(out, "perplexity", "U1")).toBe("Pasted answer [1].");
    expect(readFileSync(join(out, "perplexity", "prompts.md"), "utf8")).toContain("P1: Who is");
  });

  it("keeps the answer's own lines, including a comment that is not at the top", () => {
    expect(answerText("\uFEFF<!-- a -->\n<!-- b -->\n\nLine 1\n<!-- kept -->\nLine 2\n")).toBe("Line 1\n<!-- kept -->\nLine 2");
  });
});

describe("writeBlind and reveal", () => {
  it("shuffles each question's answers under letters, masks the product's name and keeps the key apart", () => {
    const out = freshDir();
    for (const id of ["U1", "P1"]) {
      writeAnswer(out, "alone", id, `alone answer ${id}`);
      writeAnswer(out, "webrunner", id, `webrunner fetch said ${id}`);
      writeAnswer(out, "perplexity", id, `<!-- template -->\nperplexity answer ${id}`);
    }
    const result = writeBlind(out, QUESTIONS, 42);
    expect(Object.keys(result.key)).toEqual(["U1", "P1"]);
    for (const id of ["U1", "P1"]) {
      expect(Object.keys(result.key[id] ?? {})).toEqual(["A", "B", "C"]);
      expect(new Set(Object.values(result.key[id] ?? {}))).toEqual(new Set(["alone", "webrunner", "perplexity"]));
    }
    const file = readFileSync(join(out, "blind", "P1.md"), "utf8");
    expect(file).not.toMatch(/webrunner/i);
    expect(file).toContain("[tool] fetch said P1");
    expect(file).toContain("**How to check it:** The ministry's site.");
    expect(file).not.toContain("<!-- template -->");
    expect(readFileSync(join(out, "blind", "grades.csv"), "utf8").trim().split("\n")).toHaveLength(7);

    // The same seed gives the same letters; grades already typed are never overwritten.
    writeFileSync(join(out, "blind", "grades.csv"), "question,answer,score,notes\nU1,A,5,\n", "utf8");
    expect(writeBlind(out, QUESTIONS, 42).key).toEqual(result.key);
    expect(readFileSync(join(out, "blind", "grades.csv"), "utf8")).toContain("U1,A,5,");
  });

  it("leaves out a question fewer than two sources answered and says who is missing", () => {
    const out = freshDir();
    writeAnswer(out, "alone", "U1", "only one");
    writeAnswer(out, "alone", "P1", "a");
    writeAnswer(out, "webrunner", "P1", "b");
    const result = writeBlind(out, QUESTIONS, 1);
    expect(result.skipped).toEqual(["U1"]);
    expect(result.missing["P1"]).toEqual(["perplexity"]);
    expect(existsSync(join(out, "blind", "U1.md"))).toBe(false);
  });

  it("shuffles deterministically per seed and question", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(shuffled(items, 7, "U1")).toEqual(shuffled(items, 7, "U1"));
    expect([...shuffled(items, 7, "U1")].sort()).toEqual(items);
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => shuffled(items, seed, "U1").join("")));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("joins grades with the key: means, wins shared on a tie, and ungraded rows listed", () => {
    const key: BlindKey = { U1: { A: "webrunner", B: "alone", C: "perplexity" }, P1: { A: "perplexity", B: "webrunner", C: "alone" } };
    const csv = 'question,answer,score,notes\nU1,A,5,"thorough, dated"\nU1,B,3,\nU1,C,4,\nP1,A,4,\nP1,B,4,"said ""none"""\nP1,C,\n';
    const r = reveal(csv, key);
    expect(r.ungraded).toEqual(["P1 C"]);
    expect(r.bySource["webrunner"]).toEqual({ graded: 2, mean: 4.5, wins: 1.5 });
    expect(r.bySource["perplexity"]).toEqual({ graded: 2, mean: 4, wins: 0.5 });
    expect(r.bySource["alone"]).toEqual({ graded: 1, mean: 3, wins: 0 });
    expect(r.grades.find((g) => g.question === "P1" && g.source === "webrunner")?.notes).toBe('said "none"');
    const table = formatReveal(r);
    expect(table).toContain("| webrunner | 2 | 4.50 | 1.5 |");
    expect(table).toContain("Not graded yet: P1 C");
  });

  it("refuses a score outside 1 to 5 and a letter the key does not have", () => {
    const key: BlindKey = { U1: { A: "alone", B: "webrunner" } };
    expect(() => reveal("question,answer,score\nU1,A,6\n", key)).toThrow(/between 1 and 5/);
    expect(() => reveal("question,answer,score\nU1,Z,3\n", key)).toThrow(/key does not have/);
  });

  it("parses quoted CSV cells with commas, quotes and newlines", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });

  it("masks only the products' names", () => {
    expect(maskNames("Webrunner's fetch_page and WEBRUNNER")).toBe("[tool]'s fetch_page and [tool]");
    expect(maskNames("Perplexity says so; perplexity.ai")).toBe("[tool] says so; [tool].ai");
  });
});

describe("inlineCitations", () => {
  const list = (...entries: [number, string][]): string => ["", "Citations:", ...entries.map(([n, u]) => `[${n}] ${u}`)].join("\n");

  it("turns markers into inline links named after the site and drops the list", () => {
    const text = "The rate is **53.87** as of today. [web:2][web:1]\nIt was set on 5 Nov.[web:3]" + list([1, "https://www.cbe.org.eg/en/rates"], [2, "https://news.example.com/a"], [3, "https://cbe.org.eg/b"]);
    expect(inlineCitations(text)).toBe(
      "The rate is **53.87** as of today. [news.example.com](https://news.example.com/a) · [cbe.org.eg](https://www.cbe.org.eg/en/rates)\n" +
        "It was set on 5 Nov. [cbe.org.eg](https://cbe.org.eg/b)",
    );
  });

  it("reads a list out of order, plain [n] markers and markers in a table, and drops a marker with no entry", () => {
    const text = "| Fuel | Price |\n|---|---|\n| 92 | 22.25 [3] |\n\nSummary [web:9] [1]." + list([3, "https://a.example/x"], [1, "https://b.example/y"]);
    expect(inlineCitations(text)).toBe("| Fuel | Price |\n|---|---|\n| 92 | 22.25 [a.example](https://a.example/x) |\n\nSummary [b.example](https://b.example/y).");
  });

  it("skips a link the line already holds and repeats none within one run", () => {
    const text = "[X: @EgxEgyptian](https://x.com/egxegyptian) [web:1] · Facebook [web:2][web:2]" + list([1, "https://x.com/egxegyptian"], [2, "https://facebook.com/egx"]);
    expect(inlineCitations(text)).toBe("[X: @EgxEgyptian](https://x.com/egxegyptian) · Facebook [facebook.com](https://facebook.com/egx)");
  });

  it("wraps a URL with spaces or brackets so the link still parses", () => {
    expect(inlineCitations("See this. [1]" + list([1, "https://e.example/a (b) c"]))).toBe("See this. [e.example](<https://e.example/a (b) c>)");
  });

  it("leaves text alone without a citation list, with other lines under the heading, or with [n](url) links", () => {
    expect(inlineCitations("Pasted answer [1].")).toBe("Pasted answer [1].");
    const notAList = "Answer [1].\n\nSources:\n- [CBE](https://cbe.org.eg)";
    expect(inlineCitations(notAList)).toBe(notAList);
    expect(inlineCitations("See [1](https://a.example) and [2]." + list([2, "https://b.example/"]))).toBe(
      "See [1](https://a.example) and [b.example](https://b.example/).",
    );
  });

  it("is used on the blind sheet, where the saved answer keeps its own form", () => {
    const out = freshDir();
    const pasted = "<!-- template -->\nThe minister is Ahmed Kouchouk. [web:1]\n\nCitations:\n[1] https://mof.gov.eg/en/about-ministry/minister";
    writeAnswer(out, "perplexity", "P1", pasted);
    writeAnswer(out, "alone", "P1", "Ahmed Kouchouk. [Ministry](https://mof.gov.eg/en/about-ministry/minister)");
    writeBlind(out, QUESTIONS, 3);
    const sheet = readFileSync(join(out, "blind", "P1.md"), "utf8");
    expect(sheet).toContain("The minister is Ahmed Kouchouk. [mof.gov.eg](https://mof.gov.eg/en/about-ministry/minister)");
    expect(sheet).not.toMatch(/Citations:|\[web:/);
    expect(readAnswer(out, "perplexity", "P1")).toContain("Citations:\n[1] https://mof.gov.eg");
  });
});
