import { z } from "zod";
import type { LlmClient } from "../../../src/core/llm/types.js";
import type { Criterion, DeepResearchResult, QuestionItem } from "./schema.js";

/** The report is cut at this many characters so the judge prompt stays well under 100K tokens. */
export const MAX_REPORT_CHARS = 60_000;

export const HALLUCINATION_RISKS = ["low", "medium", "high"] as const;
export const CITATION_QUALITIES = ["good", "weak", "missing"] as const;
export type HallucinationRisk = (typeof HALLUCINATION_RISKS)[number];
export type CitationQuality = (typeof CITATION_QUALITIES)[number];

/** What the judge model returns. Structured output, validated by the LLM client. */
export const VerdictSchema = z.object({
  criteria: z.array(
    z.object({
      id: z.string(),
      met: z.boolean(),
      evidence: z.string(),
    }),
  ),
  // Bounds are not part of the schema: the API may not enforce them, and a stray 11 should be clamped, not fail the run.
  overall_score: z.number().describe("0 to 10"),
  hallucination_risk: z.enum(HALLUCINATION_RISKS),
  citation_quality: z.enum(CITATION_QUALITIES),
  summary: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Facts about citations that are computed locally, so the judge does not have to count. */
export interface CitationCheck {
  /** Distinct citation numbers used in the report, ascending. */
  cited: number[];
  /** Cited numbers that have no entry in `sources`. */
  dangling: number[];
  /** Source ids the report never cites. */
  uncited_sources: number[];
  /** Source ids named by `findings` that have no entry in `sources`. */
  findings_with_missing_sources: number[];
}

export interface JudgedCriterion extends Criterion {
  met: boolean;
  evidence: string;
}

export interface Judgement {
  criteria: JudgedCriterion[];
  /** Weight of met criteria divided by total weight, 0 to 1. Computed here, not by the model. */
  weighted_score: number;
  /** The model's holistic score, 0 to 10. */
  overall_score: number;
  hallucination_risk: HallucinationRisk;
  citation_quality: CitationQuality;
  summary: string;
  citation_check: CitationCheck;
  /** True when the report was cut at MAX_REPORT_CHARS before it reached the judge. */
  report_truncated: boolean;
  cost_usd: number;
}

export interface JudgeOptions {
  /** Today's date, YYYY-MM-DD, given to the judge for recency criteria. Defaults to the system date. */
  today?: string;
}

const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Citation numbers used in a report, accepting `[3]` and `[1, 2]`. */
export function extractCitations(markdown: string): number[] {
  const found = new Set<number>();
  for (const match of markdown.matchAll(CITATION_RE)) {
    for (const part of (match[1] ?? "").split(",")) found.add(Number(part.trim()));
  }
  return [...found].sort((a, b) => a - b);
}

export function checkCitations(result: DeepResearchResult): CitationCheck {
  const sourceIds = new Set(result.sources.map((s) => s.id));
  const cited = extractCitations(result.report_markdown);
  const citedSet = new Set(cited);
  const findingIds = new Set(result.findings.flatMap((f) => f.source_ids));
  return {
    cited,
    dangling: cited.filter((n) => !sourceIds.has(n)),
    uncited_sources: [...sourceIds].filter((id) => !citedSet.has(id)).sort((a, b) => a - b),
    findings_with_missing_sources: [...findingIds].filter((id) => !sourceIds.has(id)).sort((a, b) => a - b),
  };
}

/** Cuts the report at `max` characters and appends a visible marker. */
export function truncateReport(markdown: string, max: number = MAX_REPORT_CHARS): { text: string; truncated: boolean } {
  if (markdown.length <= max) return { text: markdown, truncated: false };
  const omitted = markdown.length - max;
  return {
    text:
      markdown.slice(0, max) +
      `\n\n[... REPORT TRUNCATED FOR THE JUDGE: ${omitted} of ${markdown.length} characters omitted ...]`,
    truncated: true,
  };
}

/** Share of rubric weight that was met, 0 to 1. A criterion the judge did not return counts as not met. */
export function weightedScore(rubric: readonly Criterion[], met: ReadonlyMap<string, boolean>): number {
  const total = rubric.reduce((sum, c) => sum + c.weight, 0);
  if (total === 0) return 0;
  const earned = rubric.reduce((sum, c) => sum + (met.get(c.id) === true ? c.weight : 0), 0);
  return earned / total;
}

export const JUDGE_SYSTEM_PROMPT = `You are a strict, impartial grader of research reports produced by an automated research tool. You grade the report against a rubric written for one specific question.

What you can and cannot do:
- You cannot browse. Judge only what the report, its source list, its findings and its gaps show you. Do not use your own memory to supply facts the report fails to establish, and do not reward a specific figure, date or name just because it sounds plausible.
- Today's date is given in the task. Use it for any criterion about recency or about things that cannot have happened yet.

Rubric rules:
- Each criterion has an id, a kind and a weight. Return one entry per criterion, using the exact ids given.
- "met" means the criterion is satisfied. For a must_not_claim criterion, met is true when the report does NOT make the forbidden claim, and false when it does.
- "evidence" is one or two sentences pointing at what the report says (quote a short phrase) or at what is missing. Never leave it empty.
- When in doubt, mark the criterion as not met. A claim that is correct but unsourced does not satisfy a must_cite criterion.

Citation rules:
- The report cites sources with bracketed numbers such as [3]. Every cited number must exist in the sources list. A citation number with no matching source is a dangling citation and is a serious defect: the claim it supports is unsupported.
- The task includes a locally computed citation check. Treat it as ground truth about which numbers are dangling.
- Penalize factual claims, figures and dates that carry no citation, and sources whose "used_for" line does not plausibly support the claim they are cited for.
- A source must be a plausible primary or authoritative source for the claim. Aggregators and marketing pages for official facts are weaker.

Verdict fields:
- overall_score: 0 to 10 for the report as a whole. 0 to 2 is useless or misleading, 3 to 4 is weak, 5 to 6 is acceptable, 7 to 8 is good, 9 to 10 is excellent and would beat a strong human-written answer. Dangling citations, unsourced key claims and ignored gaps must lower it.
- hallucination_risk: "low" when the key claims are traceable to cited sources and the report states its gaps, "medium" when some significant claims are unsupported or sources look mismatched, "high" when key claims lack support, citations dangle, or the report asserts things that cannot be true as of today's date.
- citation_quality: "good" when every claim is cited, every citation resolves and the sources look authoritative, "weak" when citations are partial, dangling or from poor sources, "missing" when the report has essentially no citations.
- summary: two or three sentences naming the biggest strength and the biggest defect.`;

function formatRubric(rubric: readonly Criterion[]): string {
  return rubric.map((c) => `- id: ${c.id} | kind: ${c.kind} | weight: ${c.weight}\n  ${c.criterion}`).join("\n");
}

function formatSources(result: DeepResearchResult): string {
  if (result.sources.length === 0) return "(the sources list is empty)";
  return result.sources
    .map((s) => `[${s.id}] ${s.title} | ${s.url} | accessed ${s.accessed_at}\n    used for: ${s.used_for}`)
    .join("\n");
}

function formatFindings(result: DeepResearchResult): string {
  if (result.findings.length === 0) return "(no findings were returned)";
  return result.findings
    .map((f) => `- (${f.confidence}) ${f.claim} [sources: ${f.source_ids.join(", ") || "none"}]`)
    .join("\n");
}

function formatGaps(result: DeepResearchResult): string {
  return result.gaps.length === 0 ? "(none reported)" : result.gaps.map((g) => `- ${g}`).join("\n");
}

function formatCitationCheck(check: CitationCheck, sourceCount: number): string {
  const list = (ns: number[]): string => (ns.length === 0 ? "none" : ns.map((n) => `[${n}]`).join(", "));
  return [
    `- Citation numbers used in the report: ${list(check.cited)}`,
    `- Sources list size: ${sourceCount}`,
    `- DANGLING citations (cited in the report, absent from sources): ${list(check.dangling)}`,
    `- Source ids never cited in the report: ${list(check.uncited_sources)}`,
    `- Source ids named by findings that are absent from sources: ${list(check.findings_with_missing_sources)}`,
  ].join("\n");
}

/** Builds the judge's user message. Exported so tests can inspect what the judge is told. */
export function buildJudgePrompt(
  item: QuestionItem,
  result: DeepResearchResult,
  check: CitationCheck,
  report: { text: string; truncated: boolean },
  today: string,
): string {
  return [
    `Today's date: ${today}`,
    "",
    "## Question under test",
    `Question id: ${item.id}`,
    `Question type: ${item.type}`,
    `Question: ${item.question}`,
    "",
    "## Rubric",
    formatRubric(item.rubric),
    "",
    "## What a great answer looks like (guidance for you)",
    item.notes,
    "",
    "## Locally computed citation check",
    formatCitationCheck(check, result.sources.length),
    "",
    "## Report (Markdown)",
    report.truncated
      ? "Note: the report was truncated. Do not penalize content lost to truncation, but mention it in the summary."
      : "",
    "<report>",
    report.text,
    "</report>",
    "",
    "## Sources list",
    formatSources(result),
    "",
    "## Findings",
    formatFindings(result),
    "",
    "## Gaps the tool reported",
    formatGaps(result),
    "",
    "Grade the report now. Return one rubric entry per criterion id.",
  ].join("\n");
}

/**
 * Grades one research result against its rubric, using the `scorer` role.
 *
 * The weighted rubric score is computed here from the model's per-criterion
 * `met` flags. The model's `overall_score` is kept separately. Citation facts
 * are computed locally and fed to the judge; a dangling citation also caps
 * `citation_quality` at "weak" even if the model said "good".
 */
export async function judgeReport(
  llm: LlmClient,
  item: QuestionItem,
  result: DeepResearchResult,
  opts: JudgeOptions = {},
): Promise<Judgement> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const check = checkCitations(result);
  const report = truncateReport(result.report_markdown);
  const prompt = buildJudgePrompt(item, result, check, report, today);

  const response = await llm.complete({
    role: "scorer",
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    schema: VerdictSchema,
    effort: "medium",
    maxTokens: 4096,
  });
  const verdict = VerdictSchema.parse(response.parsed);

  const byId = new Map(verdict.criteria.map((c) => [c.id, c]));
  const criteria: JudgedCriterion[] = item.rubric.map((c) => {
    const v = byId.get(c.id);
    return { ...c, met: v?.met === true, evidence: v?.evidence ?? "The judge returned no verdict for this criterion." };
  });
  const met = new Map(criteria.map((c) => [c.id, c.met]));

  const citationQuality: CitationQuality =
    check.dangling.length > 0 && verdict.citation_quality === "good" ? "weak" : verdict.citation_quality;

  return {
    criteria,
    weighted_score: weightedScore(item.rubric, met),
    overall_score: Math.min(10, Math.max(0, verdict.overall_score)),
    hallucination_risk: verdict.hallucination_risk,
    citation_quality: citationQuality,
    summary: verdict.summary,
    citation_check: check,
    report_truncated: report.truncated,
    cost_usd: response.costUsd,
  };
}
