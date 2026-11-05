import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcess, RunResult } from "../../../src/core/llm/process.js";
import { withoutVars } from "../../../src/core/llm/process.js";
import { API_KEY_VARS, codexArgs, type Arm, type ArmOptions } from "./arms.js";
import { countTools, readEvents, type RunEvents } from "./events.js";
import type { Question } from "./schema.js";

/**
 * Runs the question set through each Codex arm (PLAN.md 17.4, WP55) and keeps
 * everything a grader needs. Per question and arm, under `<out>/<arm>/`:
 *   <id>.md            the final answer, exactly as Codex gave it
 *   <id>.events.jsonl  Codex's --json event stream
 *   <id>.json          the run record (RunRecord)
 * A question whose record says it finished is skipped on the next run with the
 * same `out`, so a run stopped by the plan's usage limit can be resumed.
 */

/** Codex's plan limit: no later run can succeed, so the batch stops. */
export const LIMIT_RE = /usage limit|hit your (?:usage )?limit|out of (?:usage|credits)|quota exceeded|insufficient_quota/i;
const AUTH_RE = /not logged in|codex login|log ?in again|\b401\b|unauthori[sz]ed|refresh token/i;

/** How much of Codex's stderr a record keeps, for diagnosing a failed run. */
const STDERR_TAIL_CHARS = 2000;

export interface RunRecord {
  id: string;
  arm: Arm;
  /** "answered": a final answer was written. "limit": the plan's usage limit. */
  outcome: "answered" | "no_answer" | "timeout" | "limit" | "auth" | "failed";
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  answerChars: number;
  /** Tool calls by tool: "web_search" is Codex's own, "webrunner.<tool>" is webrunner's. */
  tools: Record<string, number>;
  /** MCP tool calls that came back as errors, "<server>.<tool>: <message>". */
  toolErrors: string[];
  usage: Record<string, number>;
  errors: string[];
  stderrTail?: string;
}

export interface RunOneOptions {
  question: Pick<Question, "id" | "prompt">;
  arm: Arm;
  out: string;
  /** The resolved `codex` executable. */
  codex: string;
  armOptions: Omit<ArmOptions, "workDir" | "lastMessageFile">;
  timeoutMs: number;
  run: RunProcess;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function armDir(out: string, arm: Arm): string {
  return join(out, arm);
}

export function recordPath(out: string, arm: Arm, id: string): string {
  return join(armDir(out, arm), `${id}.json`);
}

/** The saved record of a run, if there is one. */
export function readRecord(out: string, arm: Arm, id: string): RunRecord | undefined {
  const file = recordPath(out, arm, id);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  } catch {
    return undefined;
  }
}

function outcomeOf(result: RunResult, events: RunEvents, answer: string): RunRecord["outcome"] {
  if (LIMIT_RE.test(events.errors.join("\n"))) return "limit";
  if (result.killed === "timeout") return "timeout";
  if (answer !== "") return "answered";
  // Codex's stderr also carries its MCP servers' logs, so it is read only when there is no answer.
  const text = [...events.errors, result.stderr].join("\n");
  if (LIMIT_RE.test(text)) return "limit";
  if (AUTH_RE.test(text)) return "auth";
  return result.exitCode === 0 ? "no_answer" : "failed";
}

/** Runs one question through one arm and writes its three files. */
export async function runOne(o: RunOneOptions): Promise<RunRecord> {
  const now = o.now ?? Date.now;
  const dir = armDir(o.out, o.arm);
  mkdirSync(dir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "webrunner-codex-eval-"));
  const lastMessageFile = join(work, "last-message.md");
  const started = now();
  let result: RunResult;
  let lastMessage = "";
  try {
    const args = codexArgs(o.arm, { ...o.armOptions, workDir: work, lastMessageFile });
    try {
      result = await o.run({
        command: o.codex,
        args,
        cwd: work,
        env: withoutVars(o.env ?? process.env, API_KEY_VARS),
        stdin: o.question.prompt,
        timeoutMs: o.timeoutMs,
      });
    } catch (err) {
      result = { exitCode: null, stdout: "", stderr: `could not start ${o.codex}: ${(err as Error).message}` };
    }
    if (existsSync(lastMessageFile)) lastMessage = readFileSync(lastMessageFile, "utf8").trim();
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  const durationMs = now() - started;

  const events = readEvents(result.stdout);
  const answer = lastMessage !== "" ? lastMessage : (events.answer ?? "").trim();
  writeFileSync(join(dir, `${o.question.id}.events.jsonl`), result.stdout, "utf8");
  if (answer !== "") writeFileSync(join(dir, `${o.question.id}.md`), answer + "\n", "utf8");

  const stderrTail = result.stderr.trim().slice(-STDERR_TAIL_CHARS);
  const record: RunRecord = {
    id: o.question.id,
    arm: o.arm,
    outcome: outcomeOf(result, events, answer),
    startedAt: new Date(started).toISOString(),
    durationMs,
    exitCode: result.exitCode,
    answerChars: answer.length,
    tools: countTools(events.toolCalls),
    toolErrors: events.toolCalls.filter((c) => c.error !== undefined).map((c) => `${c.name ?? c.kind}: ${c.error ?? ""}`),
    usage: events.usage,
    errors: events.errors,
    ...(stderrTail !== "" && { stderrTail }),
  };
  writeFileSync(recordPath(o.out, o.arm, o.question.id), JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

export interface BatchOptions extends Omit<RunOneOptions, "question" | "arm"> {
  questions: readonly Pick<Question, "id" | "prompt">[];
  arms: readonly Arm[];
  /** Rerun questions that already have an answer. */
  force?: boolean;
  onStart?: (id: string, arm: Arm) => void;
  onDone?: (record: RunRecord) => void;
  onSkip?: (id: string, arm: Arm) => void;
}

export interface BatchResult {
  records: RunRecord[];
  /** Set when the plan's usage limit stopped the batch. */
  stoppedBy?: "limit";
}

/**
 * Runs every question through every arm, one at a time. Both arms answer a
 * question back to back, so they see the web at nearly the same moment; the
 * arm that goes first alternates from question to question.
 */
export async function runBatch(o: BatchOptions): Promise<BatchResult> {
  const records: RunRecord[] = [];
  for (const [i, question] of o.questions.entries()) {
    const order = i % 2 === 0 ? o.arms : [...o.arms].reverse();
    for (const arm of order) {
      const previous = readRecord(o.out, arm, question.id);
      if (o.force !== true && previous?.outcome === "answered") {
        o.onSkip?.(question.id, arm);
        records.push(previous);
        continue;
      }
      o.onStart?.(question.id, arm);
      const record = await runOne({ ...o, question, arm });
      records.push(record);
      o.onDone?.(record);
      if (record.outcome === "limit") return { records, stoppedBy: "limit" };
    }
  }
  return { records };
}

/** One short prompt per arm for the smoke check: the webrunner arm also calls `health`. */
export const SMOKE_PROMPTS: Record<Arm, string> = {
  alone: "Search the web for today's USD to EGP exchange rate. Answer in one sentence with the rate and the URL you got it from.",
  webrunner:
    "First call the health tool and say in one line whether the browser is reachable. Then search the web for today's USD to EGP exchange rate and answer in one sentence with the rate and the URL you got it from.",
};

/** What is wrong with a smoke run of `arm`: it must answer, and reach the web only through the arm's own tools. */
export function smokeProblems(arm: Arm, r: RunRecord): string[] {
  const problems: string[] = [];
  if (r.outcome !== "answered") problems.push(`no answer (outcome ${r.outcome}${r.errors[0] !== undefined ? `: ${r.errors[0]}` : ""})`);
  const names = Object.keys(r.tools);
  if (arm === "alone") {
    if ((r.tools["web_search"] ?? 0) === 0) problems.push("Codex's own web search was never called");
    const mcp = names.filter((n) => n.includes("."));
    if (mcp.length > 0) problems.push(`an MCP tool was called: ${mcp.join(", ")}`);
  } else {
    if (r.tools["web_search"] !== undefined) problems.push("Codex's own web search was called; it should be off");
    if (r.tools["webrunner.health"] === undefined) problems.push("webrunner's health tool was not called (did the server start?)");
    if (!names.some((n) => n.startsWith("webrunner.") && n !== "webrunner.health")) problems.push("no webrunner search or read tool was called");
    const other = names.filter((n) => n.includes(".") && !n.startsWith("webrunner."));
    if (other.length > 0) problems.push(`another MCP server's tool was called: ${other.join(", ")}`);
  }
  return problems;
}

function fmtSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function fmtTools(tools: Record<string, number>): string {
  const parts = Object.entries(tools)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name.replace(/^webrunner\./, "")} ${n}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** A Markdown table of the records: one row per question and arm. */
export function formatSummary(records: readonly RunRecord[]): string {
  const rows = [...records].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }) || a.arm.localeCompare(b.arm));
  const lines = [
    "| Question | Arm | Outcome | Time | Answer chars | Input tokens | Output tokens | Tool calls |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.arm} | ${r.outcome} | ${fmtSeconds(r.durationMs)} | ${r.answerChars} | ${r.usage["input_tokens"] ?? 0} | ${r.usage["output_tokens"] ?? 0} | ${fmtTools(r.tools)} |`,
    );
  }
  return lines.join("\n");
}
