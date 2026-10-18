/**
 * Owner-facing entry point for the research evals (PLAN.md WP9).
 *
 *   npm run eval:research -- --depth standard --only recent-nodejs-latest-release --out eval-results/run.json
 *
 * This is a CLI, not the MCP server, so writing the table to stdout is fine.
 * Exit codes: 0 done, 1 refused or bad usage or bad config, 2 research engine not available yet.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, ConfigError } from "../../../src/config.js";
import { createLlmClient } from "../../../src/core/llm/client.js";
import { log } from "../../../src/log.js";
import { DEPTHS, DepthSchema, loadQuestions, type Depth, type DeepResearchResult } from "./schema.js";
import { formatTable, runEvals, writeJsonReport, type ResearchFn } from "./run.js";

const USAGE = `Usage: npm run eval:research -- [options]

  --depth <quick|standard|deep|hint>  Depth for every question. "hint" uses each question's own depth hint. Default: standard.
  --only <id,id,...>                  Run only these question ids.
  --out <path>                        Write the full JSON report (rows, judgements, reports) to this path.
  --concurrency <n>                   Questions in flight at once. Default: 3.
  --help                              Show this message.

Requires RUN_EVALS=1 (the npm script sets it), ANTHROPIC_API_KEY, and the research engine (WP7).
Each run spends real money: roughly the deep_research cost for the chosen depth, times the number of questions.`;

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

const ENGINE_DIR = new URL("../../../src/core/research/", import.meta.url);

/** Names the research engine may export its entry point under. WP7 owns the real one. */
const ENGINE_EXPORTS = ["runDeepResearch", "deepResearch", "runResearch", "research"] as const;

interface EngineDeps {
  config: ReturnType<typeof loadConfig>;
  llm: ReturnType<typeof createLlmClient>;
  log: typeof log;
}

type EngineFn = (
  input: { question: string; depth: Depth; max_cost_usd?: number },
  deps: EngineDeps,
) => Promise<DeepResearchResult>;

/**
 * Loads the research engine, or returns undefined when WP7 has not landed.
 * The specifier is built at runtime so this file does not need the module to
 * exist in order to compile.
 */
async function loadEngine(): Promise<EngineFn | undefined> {
  const present = ["engine.ts", "engine.js"].some((f) => existsSync(new URL(f, ENGINE_DIR)));
  if (!present) return undefined;
  const mod = (await import(new URL("engine.js", ENGINE_DIR).href)) as Record<string, unknown>;
  for (const name of ENGINE_EXPORTS) {
    const fn = mod[name];
    if (typeof fn === "function") return fn as EngineFn;
  }
  fail(
    2,
    `src/core/research/engine exists but exports none of: ${ENGINE_EXPORTS.join(", ")}.\n` +
      "Update loadEngine() in test/evals/research/cli.ts to match the engine's real entry point.",
  );
}

async function main(): Promise<void> {
  let values: {
    depth?: string | undefined;
    only?: string | undefined;
    out?: string | undefined;
    concurrency?: string | undefined;
    help?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      options: {
        depth: { type: "string" },
        only: { type: "string" },
        out: { type: "string" },
        concurrency: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    fail(1, `${(e as Error).message}\n\n${USAGE}`);
  }
  if (values.help === true) {
    out(USAGE);
    return;
  }

  if (process.env["RUN_EVALS"] !== "1") {
    fail(
      1,
      "Refusing to run: RUN_EVALS is not set to 1.\n" +
        "These evals call the Claude API and the web search providers and cost real money (several dollars per full run at standard depth).\n" +
        "Run them deliberately with: npm run eval:research   (or RUN_EVALS=1 node --import tsx test/evals/research/cli.ts)",
    );
  }

  const depthArg = values.depth ?? "standard";
  let depth: Depth | undefined;
  if (depthArg === "hint") {
    depth = undefined;
  } else {
    const parsed = DepthSchema.safeParse(depthArg);
    if (!parsed.success) fail(1, `Invalid --depth "${depthArg}". Use one of: ${DEPTHS.join(", ")}, hint.`);
    depth = parsed.data;
  }

  const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail(1, `Invalid --concurrency "${values.concurrency}". Use a positive integer.`);
  }

  let items = loadQuestions();
  if (values.only !== undefined) {
    const wanted = values.only.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const known = new Set(items.map((i) => i.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      fail(1, `Unknown question id(s): ${unknown.join(", ")}\nKnown ids:\n  ${[...known].join("\n  ")}`);
    }
    items = items.filter((i) => wanted.includes(i.id));
  }

  const engine = await loadEngine();
  if (engine === undefined) {
    fail(
      2,
      "The research engine is not available yet: src/core/research/engine does not exist.\n" +
        "It is delivered by WP7 (research engine) and WP8 (deep_research tool). Merge those, then re-run.\n" +
        "Until then the runner is exercised in CI against a mocked engine (test/unit/evals/run.test.ts).",
    );
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) fail(1, e.message);
    throw e;
  }
  if (config.anthropic_api_key === undefined) {
    fail(1, "ANTHROPIC_API_KEY is not set. The research engine and the judge both need the Claude API.");
  }

  const llm = createLlmClient(config);
  const research: ResearchFn = (question, d) =>
    engine({ question, depth: d, max_cost_usd: config.research_max_cost_usd }, { config, llm, log });

  err(
    `Running ${items.length} question(s) at depth ${depth ?? "per-question hint"}, concurrency ${concurrency}.`,
  );
  const result = await runEvals({
    research,
    llm,
    items,
    ...(depth !== undefined && { depth }),
    concurrency,
    onProgress: (e) => {
      if (e.type === "start") err(`[${e.index + 1}/${e.total}] start  ${e.id} (${e.depth})`);
      else {
        const note = e.row.error !== undefined ? `ERROR ${e.row.error}` : `rubric ${(e.row.weighted_score * 100).toFixed(0)}%, overall ${e.row.overall_score.toFixed(1)}`;
        err(`[${e.index + 1}/${e.total}] done   ${e.id}: ${note}`);
      }
    },
  });

  out(formatTable(result));
  if (values.out !== undefined) {
    writeJsonReport(result, values.out);
    err(`Wrote JSON report to ${values.out}`);
  }
}

main().catch((e: unknown) => {
  err(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
