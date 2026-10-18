import { z } from "zod";
import { RECENCY_VALUES } from "./web_search.js";

/** `deep_research` input and output, PLAN.md section 3.3. */

export const DEPTHS = ["quick", "standard", "deep"] as const;
export const OUTPUT_FORMATS = ["report", "brief"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const STOPPED_REASONS = ["converged", "iterations", "budget", "searches", "reads", "no_results"] as const;

export const QUOTE_MAX_CHARS = 300;
export const QUESTION_MAX_CHARS = 2000;

export type Depth = (typeof DEPTHS)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export type StoppedReason = (typeof STOPPED_REASONS)[number];

export interface DepthBudget {
  /** Maximum search calls (one per sub-query). */
  searches: number;
  /** Maximum pages successfully read. */
  pages: number;
  /** Maximum loop iterations. */
  iterations: number;
  /**
   * LLM role that writes the final report. `extractor` is the Sonnet-class role:
   * the 3.3 table asks for a Sonnet writer at quick depth, and the writer role
   * is routed to Opus by default. Standard and deep use the `writer` role.
   */
  writerRole: "extractor" | "writer";
}

/** Depth budgets, PLAN.md section 3.3 (DECIDED defaults). */
export const DEPTH_BUDGETS: Readonly<Record<Depth, DepthBudget>> = {
  quick: { searches: 4, pages: 6, iterations: 1, writerRole: "extractor" },
  standard: { searches: 12, pages: 20, iterations: 3, writerRole: "writer" },
  deep: { searches: 30, pages: 50, iterations: 6, writerRole: "writer" },
};

export const DeepResearchInputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(QUESTION_MAX_CHARS)
    .describe("The question to research. Be specific; up to 2000 characters."),
  depth: z
    .enum(DEPTHS)
    .default("standard")
    .describe(
      "quick (about 4 searches, 6 pages, one pass), standard (12 searches, 20 pages, 3 passes; default) or deep (30 searches, 50 pages, 6 passes).",
    ),
  focus_domains: z.array(z.string().min(1)).optional().describe("Only use sources from these domains."),
  exclude_domains: z.array(z.string().min(1)).optional().describe("Never use sources from these domains."),
  recency: z
    .enum(RECENCY_VALUES)
    .optional()
    .describe("Prefer sources from the last day, week, month or year."),
  output: z
    .enum(OUTPUT_FORMATS)
    .default("report")
    .describe("report (default) is a full cited report; brief is about 300 words."),
  max_cost_usd: z
    .number()
    .positive()
    .optional()
    .describe("Hard cap on LLM spend for this call in USD. Defaults to the server's RESEARCH_MAX_COST_USD."),
});

export const FindingSchema = z.object({
  claim: z.string(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  source_ids: z.array(z.number().int()),
  quote: z
    .string()
    .max(QUOTE_MAX_CHARS)
    .optional()
    .describe("Verbatim supporting text from the source, 300 characters at most."),
});

export const SourceSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  accessed_at: z.string(),
  published_at: z.string().optional(),
  used_for: z.string(),
});

export const ResearchStatsSchema = z.object({
  searches: z.number(),
  pages_read: z.number(),
  pages_failed: z.number(),
  iterations: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  elapsed_ms: z.number(),
  stopped_reason: z.enum(STOPPED_REASONS),
});

export const DeepResearchResultSchema = z.object({
  question: z.string(),
  report_markdown: z.string(),
  findings: z.array(FindingSchema),
  sources: z.array(SourceSchema),
  gaps: z.array(z.string()),
  depth: z.enum(DEPTHS),
  stats: ResearchStatsSchema,
});

/** Caller-facing input: `depth` and `output` are optional, defaults are applied by `runResearch`. */
export type DeepResearchInput = z.input<typeof DeepResearchInputSchema>;
/** Input after parsing, with defaults applied. */
export type ParsedDeepResearchInput = z.infer<typeof DeepResearchInputSchema>;
export type DeepResearchResult = z.infer<typeof DeepResearchResultSchema>;
export type ResearchFinding = z.infer<typeof FindingSchema>;
export type ResearchSource = z.infer<typeof SourceSchema>;
export type ResearchStats = z.infer<typeof ResearchStatsSchema>;
