/**
 * Owner-facing entry point for the Codex question set (PLAN.md 17.4, WP55).
 *
 *   npm run eval:codex -- smoke
 *   npm run eval:codex -- run --only U1,P3
 *   npm run eval:codex -- perplexity
 *   npm run eval:codex -- blind
 *   npm run eval:codex -- reveal
 *
 * This is a CLI, not the MCP server, so writing to stdout is fine.
 * Exit codes: 0 done, 1 refused or bad usage, 2 a smoke check or a run failed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveExecutable, runProcess } from "../../../src/core/llm/process.js";
import {
  ARMS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  OFF_FEATURES,
  SERVER_LLMS,
  codexArgs,
  describeArm,
  type Arm,
  type ArmOptions,
  type ServerLlm,
} from "./arms.js";
import { BLIND_DIR, GRADES_FILE, KEY_FILE, formatReveal, reveal, writeBlind, writePerplexityTemplates, type BlindKey } from "./blind.js";
import { SMOKE_PROMPTS, formatSummary, readRecord, runBatch, runOne, smokeProblems, type RunRecord } from "./run.js";
import { loadQuestions, selectQuestions } from "./schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RESULTS = join(ROOT, "eval-results", "codex");
const ENTRY = join(ROOT, "dist", "index.js");
const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MIN = 30;

const USAGE = `Usage: npm run eval:codex -- <command> [options]

Commands:
  smoke        One short prompt per arm, to check each arm reaches the web the way it should.
  run          Run the question set through the Codex arms. Rerun the same command to resume:
               questions already answered are skipped (--force reruns them). To resume on a
               later day, pass the first day's folder with --out.
  perplexity   Write an empty answer file per question for the Perplexity arm, which you fill by hand.
  blind        Put every answer to a question in one file under shuffled letters, key kept apart.
  reveal       Join your grades (blind/grades.csv) with the key and print the result.

Options:
  --out <dir>             Results folder. Default: eval-results/codex/<today> for smoke and run,
                          the newest folder there for the other commands.
  --only <id,id,...>      Only these questions (U1-U4 are yours, P1-P12 are probes).
  --arms <arm,arm>        alone, webrunner. Default: both.
  --model <name>          Codex model. Default: ${DEFAULT_MODEL}.
  --effort <level>        Reasoning effort, the same for both arms. Default: ${DEFAULT_EFFORT}.
  --timeout-min <n>       Per question and arm. Default: ${DEFAULT_TIMEOUT_MIN}.
  --cdp <url|none>        Chrome webrunner attaches to. Default: BROWSER_CDP_URL, else ${DEFAULT_CDP}.
                          "none" lets webrunner start its own browser.
  --server-llm <mode>     config: webrunner's own model calls use your config.json (claude-cli, the Claude plan).
                          none: no server model, so nothing touches the Claude plan (browse_task and some
                          recipe steps then fail). Default: config.
  --enable <feature,...>  Codex features to leave on in both arms (all agent tools are off by default):
                          ${OFF_FEATURES.join(", ")}.
  --force                 Rerun questions that already have an answer.
  --seed <n>              blind: the shuffle's seed. Default: random, saved in blind/key.json.
  --dry-run               smoke, run: print each arm's codex command and stop. Spends nothing.
  --help                  Show this message.

smoke and run spend Codex plan quota and need RUN_EVALS=1 (the npm script sets it).
Both arms ignore your ~/.codex/config.toml, so none of your other MCP servers (Perplexity among them) loads.`;

function out(text: string): void {
  process.stdout.write(text + "\n");
}

function err(text: string): void {
  process.stderr.write(text + "\n");
}

function fail(code: number, message: string): never {
  err(message);
  process.exit(code);
}

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The most recently changed folder under eval-results/codex. */
function newestResults(): string | undefined {
  if (!existsSync(RESULTS)) return undefined;
  const dirs = readdirSync(RESULTS)
    .map((name) => join(RESULTS, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0];
}

function list(value: string | undefined): string[] | undefined {
  return value?.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function oneLine(args: readonly string[]): string {
  return args.map((a) => (/[\s"'{}[\]]/.test(a) ? `'${a}'` : a)).join(" ");
}

function gitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

async function codexVersion(codex: string): Promise<string | undefined> {
  const r = await runProcess({ command: codex, args: ["--version"], cwd: ROOT, env: process.env, stdin: "", timeoutMs: 30_000 }).catch(() => undefined);
  return r?.exitCode === 0 ? r.stdout.trim() : undefined;
}

async function cdpReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/json/version", url), { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function appendManifest(dir: string, entry: Record<string, unknown>): void {
  const file = join(dir, "manifest.json");
  let runs: unknown[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: unknown[] };
      runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch {
      runs = [];
    }
  }
  runs.push(entry);
  writeFileSync(file, JSON.stringify({ runs }, null, 2) + "\n", "utf8");
}

const OPTIONS = {
  out: { type: "string" },
  only: { type: "string" },
  arms: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  "timeout-min": { type: "string" },
  cdp: { type: "string" },
  "server-llm": { type: "string" },
  enable: { type: "string" },
  force: { type: "boolean" },
  seed: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function parseCli() {
  try {
    return parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (e) {
    fail(1, `${(e as Error).message}

${USAGE}`);
  }
}

type Values = ReturnType<typeof parseCli>["values"];

async function main(): Promise<void> {
  const parsed = parseCli();
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    out(USAGE);
    return;
  }
  if (positionals.length > 1) fail(1, `One command at a time; got: ${positionals.join(" ")}\n\n${USAGE}`);

  let questions;
  try {
    questions = selectQuestions(loadQuestions(), list(values.only));
  } catch (e) {
    fail(1, (e as Error).message);
  }

  switch (command) {
    case "smoke":
    case "run":
      await spend(command, values, questions);
      return;
    case "perplexity": {
      const dir = values.out ?? newestResults() ?? join(RESULTS, today());
      const { written, kept } = writePerplexityTemplates(dir, questions);
      out(`Perplexity templates in ${join(dir, "perplexity")}: ${written.length} written${kept.length > 0 ? `, ${kept.length} already there and kept` : ""}.`);
      out("Type each prompt into Perplexity exactly as written (they are also in prompts.md), in the mode you normally use,");
      out("and paste the whole answer, citations included, below the comment lines of its file.");
      return;
    }
    case "blind": {
      const dir = values.out ?? newestResults();
      if (dir === undefined) fail(1, "No results folder yet; run the question set first or pass --out.");
      const seed = values.seed !== undefined ? Number(values.seed) : Math.floor(Math.random() * 2 ** 31);
      if (!Number.isInteger(seed)) fail(1, `--seed must be an integer, got "${values.seed ?? ""}"`);
      const result = writeBlind(dir, questions, seed);
      const blindDir = join(dir, BLIND_DIR);
      out(`Blind files for ${Object.keys(result.key).length} question(s) in ${blindDir}. Grade them in ${GRADES_FILE}; do not open ${KEY_FILE}.`);
      for (const [id, sources] of Object.entries(result.missing)) out(`  ${id}: no answer from ${sources.join(", ")}`);
      if (result.skipped.length > 0) out(`Left out (fewer than two answers): ${result.skipped.join(", ")}`);
      return;
    }
    case "reveal": {
      const dir = values.out ?? newestResults();
      if (dir === undefined) fail(1, "No results folder yet; pass --out.");
      const blindDir = join(dir, BLIND_DIR);
      if (!existsSync(join(blindDir, KEY_FILE)) || !existsSync(join(blindDir, GRADES_FILE))) fail(1, `No blind key or grades in ${blindDir}; run blind first.`);
      const key = (JSON.parse(readFileSync(join(blindDir, KEY_FILE), "utf8")) as { key: BlindKey }).key;
      let table: string;
      try {
        table = formatReveal(reveal(readFileSync(join(blindDir, GRADES_FILE), "utf8"), key));
      } catch (e) {
        fail(1, (e as Error).message);
      }
      writeFileSync(join(blindDir, "results.md"), table + "\n", "utf8");
      out(table);
      return;
    }
    default:
      fail(1, `Unknown command "${command}"\n\n${USAGE}`);
  }
}

async function spend(command: "smoke" | "run", values: Values, questions: ReturnType<typeof selectQuestions>): Promise<void> {
  const arms = (list(values.arms) ?? [...ARMS]) as Arm[];
  const badArm = arms.find((a) => !(ARMS as readonly string[]).includes(a));
  if (badArm !== undefined) fail(1, `Unknown arm "${badArm}"; arms are ${ARMS.join(", ")}`);
  const serverLlm = (values["server-llm"] ?? "config") as ServerLlm;
  if (!(SERVER_LLMS as readonly string[]).includes(serverLlm)) fail(1, `--server-llm must be one of ${SERVER_LLMS.join(", ")}`);
  const enable = list(values.enable) ?? [];
  const badFeature = enable.find((f) => !(OFF_FEATURES as readonly string[]).includes(f));
  if (badFeature !== undefined) fail(1, `Unknown feature "${badFeature}"; one of ${OFF_FEATURES.join(", ")}`);
  const timeoutMin = Number(values["timeout-min"] ?? DEFAULT_TIMEOUT_MIN);
  if (!(timeoutMin > 0)) fail(1, "--timeout-min must be a positive number");
  const cdpArg = values.cdp ?? process.env["BROWSER_CDP_URL"] ?? DEFAULT_CDP;
  const cdpUrl = cdpArg === "none" ? undefined : cdpArg;
  const armOptions: Omit<ArmOptions, "workDir" | "lastMessageFile"> = {
    model: values.model ?? DEFAULT_MODEL,
    effort: values.effort ?? DEFAULT_EFFORT,
    webrunnerEntry: ENTRY,
    serverLlm,
    enable,
    ...(cdpUrl !== undefined && { cdpUrl }),
  };
  const dir = values.out ?? join(RESULTS, today());

  if (values["dry-run"] === true) {
    for (const arm of arms) {
      out(`# ${arm}: ${describeArm(arm, armOptions)}`);
      out(`codex ${oneLine(codexArgs(arm, { ...armOptions, workDir: "<empty temp dir>", lastMessageFile: "<temp>/last-message.md" }))}`);
      out("");
    }
    const n = command === "smoke" ? arms.length : questions.length * arms.length;
    out(`${n} run(s) into ${command === "smoke" ? join(dir, "smoke") : dir}. Prompts go on stdin exactly as written.`);
    return;
  }

  if (process.env["RUN_EVALS"] !== "1") {
    fail(
      1,
      "Refusing to run: RUN_EVALS is not set to 1.\n" +
        "smoke and run start real Codex sessions on your ChatGPT plan and use its quota.\n" +
        "Run them deliberately with: npm run eval:codex -- " + command + "   (--dry-run shows the commands without spending)",
    );
  }
  const codex = resolveExecutable(process.env["WEBRUNNER_CODEX_PATH"] ?? "codex");
  if (codex === undefined) fail(1, "No codex executable on PATH (or at WEBRUNNER_CODEX_PATH). Install the Codex CLI and sign in.");
  if (arms.includes("webrunner")) {
    if (!existsSync(ENTRY)) fail(1, `${ENTRY} does not exist; run npm run build first.`);
    if (cdpUrl !== undefined && !(await cdpReachable(cdpUrl))) {
      fail(
        1,
        `No Chrome is listening at ${cdpUrl}, so webrunner's browser tools would fail.\n` +
          "Start your Chrome with --remote-debugging-port=9222 (README, Browser setup), or pass --cdp none to let webrunner start its own browser.",
      );
    }
  }

  const target = command === "smoke" ? join(dir, "smoke") : dir;
  mkdirSync(target, { recursive: true });
  const timeoutMs = timeoutMin * 60_000;
  appendManifest(target, {
    command,
    startedAt: new Date().toISOString(),
    codex: await codexVersion(codex),
    webrunnerCommit: gitCommit(),
    model: armOptions.model,
    effort: armOptions.effort,
    timeoutMin,
    arms: Object.fromEntries(arms.map((a) => [a, describeArm(a, armOptions)])),
    questions: command === "smoke" ? [] : questions.map((q) => q.id),
  });

  if (command === "smoke") {
    let failed = false;
    for (const arm of arms) {
      err(`smoke: ${arm} ...`);
      const smokeOptions = { ...armOptions, smoke: true };
      const record = await runOne({ question: { id: "SMOKE", prompt: SMOKE_PROMPTS[arm] }, arm, out: target, codex, armOptions: smokeOptions, timeoutMs, run: runProcess });
      if (record.outcome === "limit") {
        out(`STOPPED ${arm}: ${record.errors[0] ?? "Codex reports the plan's usage limit"}`);
        process.exit(2);
      }
      const problems = smokeProblems(arm, record);
      failed ||= problems.length > 0;
      out(`${problems.length === 0 ? "PASS" : "FAIL"} ${arm} (${Math.round(record.durationMs / 1000)} s; tools: ${JSON.stringify(record.tools)})`);
      for (const p of problems) out(`  - ${p}`);
      for (const e of record.toolErrors) out(`  - tool error: ${e}`);
    }
    out(`Details in ${target}.`);
    if (failed) process.exit(2);
    return;
  }

  const total = questions.length * arms.length;
  let n = 0;
  const result = await runBatch({
    questions,
    arms,
    out: target,
    codex,
    armOptions,
    timeoutMs,
    run: runProcess,
    ...(values.force === true && { force: true }),
    onSkip: (id, arm) => err(`[${++n}/${total}] ${id} ${arm}: already answered, skipped`),
    onStart: (id, arm) => err(`[${++n}/${total}] ${id} ${arm} ...`),
    onDone: (r) => err(`        ${r.outcome} in ${Math.round(r.durationMs / 1000)} s`),
  });
  const all = questions.flatMap((q) => arms.map((a) => readRecord(target, a, q.id)).filter((r): r is RunRecord => r !== undefined));
  const summary = formatSummary(all);
  writeFileSync(join(target, "summary.md"), summary + "\n", "utf8");
  out(summary);
  if (result.stoppedBy === "limit") {
    out("\nStopped: Codex reports the plan's usage limit. Rerun the same command after it resets; answered questions are skipped.");
    process.exit(2);
  }
  if (all.some((r) => r.outcome !== "answered")) process.exit(2);
}

void main();
