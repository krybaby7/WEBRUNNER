import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LlmClient } from "../../../src/core/llm/types.js";
import {
  judgeReport,
  type CitationCheck,
  type CitationQuality,
  type HallucinationRisk,
  type Judgement,
} from "./judge.js";
import {
  DeepResearchResultSchema,
  loadQuestions,
  type Depth,
  type DeepResearchResult,
  type QuestionItem,
  type QuestionType,
  type ResearchStats,
} from "./schema.js";

export const DEFAULT_CONCURRENCY = 3;

export type ResearchFn = (question: string, depth: Depth) => Promise<DeepResearchResult>;

export interface EvalRow {
  id: string;
  type: QuestionType;
  question: string;
  depth: Depth;
  /** Weight of met rubric criteria over total weight, 0 to 1. Zero when the run failed. */
  weighted_score: number;
  /** The judge's holistic score, 0 to 10. Zero when the run failed. */
  overall_score: number;
  hallucination_risk: HallucinationRisk | null;
  citation_quality: CitationQuality | null;
  /** From the research result. Null when the research call threw or returned an invalid result. */
  stats: ResearchStats | null;
  /** Research elapsed_ms when known, otherwise the wall time the runner measured. */
  elapsed_ms: number;
  judge_cost_usd: number;
  citation_check: CitationCheck | null;
  /** Set when the research call threw, returned an invalid result, or the judge failed. */
  error?: string;
  /** Full judgement, for the JSON report. */
  judgement?: Judgement;
  /** The report itself, so the owner can read it next to a competitor's answer. */
  report_markdown?: string;
}

export interface EvalTotals {
  /** Mean of the rows' weighted scores, 0 to 1. Failed rows count as 0. */
  weighted_score: number;
  /** Mean of the rows' overall scores, 0 to 10. Failed rows count as 0. */
  mean_overall: number;
  /** Research cost, from each result's stats. */
  total_cost_usd: number;
  total_elapsed_ms: number;
  judge_cost_usd: number;
}

export interface EvalResult {
  rows: EvalRow[];
  totals: EvalTotals;
}

export type EvalProgress =
  | { type: "start"; index: number; total: number; id: string; depth: Depth }
  | { type: "done"; index: number; total: number; id: string; row: EvalRow };

export interface RunEvalsOptions {
  research: ResearchFn;
  llm: LlmClient;
  /** Defaults to the questions in questions.json. */
  items?: QuestionItem[];
  /** Overrides every item's depth hint. */
  depth?: Depth;
  /** Default 3. */
  concurrency?: number;
  onProgress?: (e: EvalProgress) => void;
  /** Today's date for the judge, YYYY-MM-DD. Defaults to the system date. */
  today?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function evalOne(item: QuestionItem, depth: Depth, opts: RunEvalsOptions): Promise<EvalRow> {
  const base = {
    id: item.id,
    type: item.type,
    question: item.question,
    depth,
  };
  const failed = (error: string, elapsedMs: number, extra: Partial<EvalRow> = {}): EvalRow => ({
    ...base,
    weighted_score: 0,
    overall_score: 0,
    hallucination_risk: null,
    citation_quality: null,
    stats: null,
    elapsed_ms: elapsedMs,
    judge_cost_usd: 0,
    citation_check: null,
    error,
    ...extra,
  });

  const started = Date.now();
  let result: DeepResearchResult;
  try {
    const raw = await opts.research(item.question, depth);
    const parsed = DeepResearchResultSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return failed(`research returned an invalid result: ${issues.join("; ")}`, Date.now() - started);
    }
    result = parsed.data;
  } catch (err) {
    return failed(errorMessage(err), Date.now() - started);
  }

  try {
    const judgement = await judgeReport(
      opts.llm,
      item,
      result,
      opts.today !== undefined ? { today: opts.today } : {},
    );
    return {
      ...base,
      weighted_score: judgement.weighted_score,
      overall_score: judgement.overall_score,
      hallucination_risk: judgement.hallucination_risk,
      citation_quality: judgement.citation_quality,
      stats: result.stats,
      elapsed_ms: result.stats.elapsed_ms,
      judge_cost_usd: judgement.cost_usd,
      citation_check: judgement.citation_check,
      judgement,
      report_markdown: result.report_markdown,
    };
  } catch (err) {
    // The research output is still worth keeping, so its stats and report stay on the row.
    return failed(`judge failed: ${errorMessage(err)}`, result.stats.elapsed_ms, {
      stats: result.stats,
      report_markdown: result.report_markdown,
    });
  }
}

function sum(rows: EvalRow[], pick: (r: EvalRow) => number): number {
  return rows.reduce((total, r) => total + pick(r), 0);
}

export function computeTotals(rows: EvalRow[]): EvalTotals {
  const n = rows.length;
  return {
    weighted_score: n === 0 ? 0 : sum(rows, (r) => r.weighted_score) / n,
    mean_overall: n === 0 ? 0 : sum(rows, (r) => r.overall_score) / n,
    total_cost_usd: sum(rows, (r) => r.stats?.cost_usd ?? 0),
    total_elapsed_ms: sum(rows, (r) => r.elapsed_ms),
    judge_cost_usd: sum(rows, (r) => r.judge_cost_usd),
  };
}

/**
 * Runs every item through `research`, grades each report, and returns one row
 * per item in input order. A research call that throws becomes a row with score
 * 0 and the error message; it never aborts the suite.
 */
export async function runEvals(opts: RunEvalsOptions): Promise<EvalResult> {
  const items = opts.items ?? loadQuestions();
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const rows = new Array<EvalRow>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      const depth = opts.depth ?? item.depth;
      opts.onProgress?.({ type: "start", index, total: items.length, id: item.id, depth });
      const row = await evalOne(item, depth, opts);
      rows[index] = row;
      opts.onProgress?.({ type: "done", index, total: items.length, id: item.id, row });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return { rows, totals: computeTotals(rows) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const usd = (n: number, digits = 4): string => `$${n.toFixed(digits)}`;
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const secs = (ms: number): string => (ms / 1000).toFixed(1);

/** Fixed-width text table, one row per question, followed by any errors and a totals line. */
export function formatTable(result: EvalResult): string {
  const header = ["id", "type", "depth", "rubric", "overall", "halluc", "cites", "cost", "srch", "pages", "iter", "secs", "judge$"];
  const body = result.rows.map((r) => [
    r.id,
    r.type,
    r.depth,
    r.error !== undefined && r.judgement === undefined ? "ERROR" : pct(r.weighted_score),
    r.error !== undefined && r.judgement === undefined ? "-" : r.overall_score.toFixed(1),
    r.hallucination_risk ?? "-",
    r.citation_quality ?? "-",
    r.stats !== null ? usd(r.stats.cost_usd) : "-",
    r.stats !== null ? String(r.stats.searches) : "-",
    r.stats !== null ? String(r.stats.pages_read) : "-",
    r.stats !== null ? String(r.stats.iterations) : "-",
    secs(r.elapsed_ms),
    usd(r.judge_cost_usd),
  ]);
  const widths = header.map((h, col) => Math.max(h.length, ...body.map((row) => (row[col] ?? "").length)));
  // Text columns are left-aligned, numeric columns right-aligned.
  const leftCols = new Set([0, 1, 2, 5, 6]);
  const fmt = (cells: string[]): string =>
    cells
      .map((c, col) => (leftCols.has(col) ? c.padEnd(widths[col] ?? 0) : c.padStart(widths[col] ?? 0)))
      .join("  ")
      .trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");

  const lines = [fmt(header), rule, ...body.map(fmt)];

  const errors = result.rows.filter((r) => r.error !== undefined);
  if (errors.length > 0) {
    lines.push("", "Errors:");
    for (const r of errors) lines.push(`  ${r.id}: ${r.error}`);
  }

  const t = result.totals;
  lines.push(
    "",
    `TOTAL  n=${result.rows.length}  weighted_score=${pct(t.weighted_score)}  mean_overall=${t.mean_overall.toFixed(2)}/10  ` +
      `research_cost=${usd(t.total_cost_usd)}  judge_cost=${usd(t.judge_cost_usd)}  elapsed=${secs(t.total_elapsed_ms)}s`,
  );
  return lines.join("\n");
}

/** Writes the full result (rows, judgements, reports, totals) as pretty JSON, creating parent directories. */
export function writeJsonReport(result: EvalResult, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n", "utf8");
}
