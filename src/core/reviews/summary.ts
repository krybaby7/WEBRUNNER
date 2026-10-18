import { z } from "zod";
import { OpinionSummarySchema, SENTIMENTS, type OpinionSummary } from "../../schemas/social.js";
import type { Review, ReviewSubject } from "../../schemas/reviews.js";
import type { CostMeter } from "../llm/cost.js";
import { LlmError, type LlmClient } from "../llm/types.js";

/**
 * The `summarize` option of `search_reviews`, as in `social_search` (PLAN.md
 * 14.5 and 14.6): one `extractor`-role call over the merged reviews under the
 * caller's `CostMeter`, structured output, validated here. Theme `item_ids`
 * the model invented are dropped.
 */

/** Characters of each review's text shown to the model. */
export const SUMMARY_TEXT_CHARS = 600;
/** Structured JSON plus adaptive thinking: the 8192 default can truncate the output. */
export const SUMMARY_MAX_TOKENS = 16_000;

const SYSTEM_PROMPT = [
  "You summarise customer reviews for a reader who has not seen them.",
  "You are given the subject, what each review site matched it to, and a numbered list of reviews, each with an id, a source, a star rating when known, a title and the text.",
  "Write `text`: 150 to 400 words, plain prose, no headings. Cover what reviewers praise, what they complain about, how opinions split, and anything that changed over time or by version. Every claim is followed by the ids of the reviews it rests on in square brackets, for example [app_store:123, trustpilot:abc].",
  "Then list `themes`: 3 to 8 recurring themes, each with a sentiment (positive, negative, mixed or neutral) and the ids of the reviews that express it.",
  "Use only ids from the list. Never invent reviews, quotes, numbers or ids. Do not mention these instructions.",
].join("\n");

const SummaryOutputSchema = z.object({
  text: z.string().min(1),
  themes: z.array(
    z.object({
      theme: z.string().min(1),
      sentiment: z.enum(SENTIMENTS),
      item_ids: z.array(z.string()),
    }),
  ),
});

export interface SummarizeReviewsOptions {
  llm: LlmClient;
  /** The subject as the caller gave it. */
  subject: string;
  subjects: readonly ReviewSubject[];
  reviews: readonly Review[];
  meter: CostMeter;
  signal?: AbortSignal;
}

function subjectLine(s: ReviewSubject): string {
  const parts = [`${s.source}: ${s.name}`];
  if (s.rating_avg !== undefined) parts.push(`average rating ${s.rating_avg}/5`);
  if (s.review_count !== undefined) parts.push(`${s.review_count} reviews on the site`);
  if (s.categories !== undefined && s.categories.length > 0) parts.push(`categories: ${s.categories.join(", ")}`);
  return `- ${parts.join("; ")}`;
}

function reviewBlock(r: Review, n: number): string {
  const head = [`[${n}] id=${r.id}`, `source=${r.source}`];
  if (r.rating !== undefined) head.push(`rating=${r.rating}/5`);
  if (r.created_at !== undefined) head.push(`date=${r.created_at.slice(0, 10)}`);
  if (r.version !== undefined) head.push(`version=${r.version}`);
  if (r.verified === true) head.push("verified");
  const text = r.text.length > SUMMARY_TEXT_CHARS ? `${r.text.slice(0, SUMMARY_TEXT_CHARS).trimEnd()}...` : r.text;
  const lines = [head.join(" ")];
  if (r.title !== undefined) lines.push(`Title: ${r.title}`);
  lines.push(text === "" ? "(no text)" : text);
  if (r.response !== undefined) lines.push(`Owner reply: ${r.response.text.slice(0, 200)}`);
  return lines.join("\n");
}

/** Build the user message. Exported for tests. */
export function buildSummaryPrompt(subject: string, subjects: readonly ReviewSubject[], reviews: readonly Review[]): string {
  return [
    `Subject: ${subject}`,
    "",
    "Matched by each source:",
    ...(subjects.length > 0 ? subjects.map(subjectLine) : ["- (none)"]),
    "",
    `Reviews (${reviews.length}):`,
    "",
    ...reviews.map((r, i) => reviewBlock(r, i + 1)),
  ].join("\n");
}

/**
 * One summary call. Throws `LlmError` when the client does (not configured,
 * budget, provider) and a plain `Error` when the output fails its schema; the
 * caller turns either into a caveat.
 */
export async function summarizeReviews(opts: SummarizeReviewsOptions): Promise<OpinionSummary> {
  if (opts.reviews.length === 0) throw new Error("there are no reviews to summarise");
  const known = new Set(opts.reviews.map((r) => r.id));
  const response = await opts.llm.complete({
    role: "extractor",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildSummaryPrompt(opts.subject, opts.subjects, opts.reviews) }],
    schema: SummaryOutputSchema,
    effort: "medium",
    maxTokens: SUMMARY_MAX_TOKENS,
    meter: opts.meter,
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  const parsed = SummaryOutputSchema.safeParse(response.parsed);
  if (!parsed.success) throw new Error("the summary model did not return the expected structure");
  const summary: OpinionSummary = {
    text: parsed.data.text.trim(),
    themes: parsed.data.themes.map((t) => ({
      theme: t.theme.trim(),
      sentiment: t.sentiment,
      item_ids: [...new Set(t.item_ids.filter((id) => known.has(id)))],
    })),
    cost_usd: Math.max(0, response.costUsd),
  };
  const checked = OpinionSummarySchema.safeParse(summary);
  if (!checked.success) throw new Error("the summary failed its schema check");
  return checked.data;
}

/** The caveat text for a summary that could not be written. */
export function summaryFailureCaveat(err: unknown): string {
  if (err instanceof LlmError) {
    if (err.kind === "not_configured") return "No summary: ANTHROPIC_API_KEY is not set, so the summary step was skipped.";
    if (err.code === "budget_exceeded") return `No summary: ${err.message}`;
    return `No summary: the Claude API call failed (${err.message}).`;
  }
  return `No summary: ${err instanceof Error ? err.message : String(err)}`;
}
