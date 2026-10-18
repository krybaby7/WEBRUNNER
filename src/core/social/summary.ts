import { z } from "zod";
import type { Logger } from "../../log.js";
import { OpinionSummarySchema, SENTIMENTS, type OpinionSummary, type SocialItem, type SocialSearchQuery } from "../../schemas/social.js";
import type { CostMeter } from "../llm/cost.js";
import { LlmError, type LlmClient } from "../llm/types.js";

/**
 * The "what people are saying" summary, PLAN.md 14.5: one `extractor`-role
 * call with structured output over the merged items. The model returns `text`
 * and `themes`; the caller's response adds `cost_usd`. Item ids the model
 * invents are dropped. Failures are the client's `LlmError`.
 */

/** What the model is asked for. `cost_usd` comes from the response, not the model. */
export const SummaryModelSchema = z.object({
  text: z.string().min(1),
  themes: z.array(z.object({ theme: z.string().min(1), sentiment: z.enum(SENTIMENTS), item_ids: z.array(z.string().min(1)) })),
});

/** Per-item text in the prompt; the items themselves stay at SOCIAL_TEXT_MAX_CHARS. */
export const SUMMARY_ITEM_TEXT_CHARS = 800;
export const SUMMARY_MAX_TOKENS = 4000;

export const SUMMARY_SYSTEM_PROMPT = [
  "You summarise what people are saying on social platforms about a topic, from a list of posts and comments.",
  "Write `text` as 150 to 400 words of plain prose. Every claim is followed by the ids of the items it rests on, in square brackets, for example [reddit:abc12, hackernews:4567].",
  "Then list `themes`: the recurring points of view, each with a sentiment (positive, negative, mixed or neutral) and the ids of the items that express it.",
  "Only use ids that appear in the list. Report disagreement and minority views as such; do not invent consensus. Mention when the sample is small or one-sided.",
  "Never include an email address or any personal data beyond the handles shown.",
].join("\n");

export interface SummarizeOptions {
  llm: LlmClient;
  items: SocialItem[];
  query: SocialSearchQuery;
  /** Shared with any LLM extraction the platforms did; caps the whole call at `max_cost_usd`. */
  meter: CostMeter;
  signal?: AbortSignal;
  log?: Logger;
}

export function buildSummaryPrompt(query: SocialSearchQuery, items: SocialItem[]): string {
  const subject = query.mode === "thread" ? `the thread at ${query.url ?? "(unknown)"}` : `"${query.query ?? ""}"`;
  const lines = items.map((it) => {
    const text = it.text.length > SUMMARY_ITEM_TEXT_CHARS ? `${it.text.slice(0, SUMMARY_ITEM_TEXT_CHARS)}...` : it.text;
    const meta = [
      it.platform,
      it.kind,
      it.author !== undefined ? `by ${it.author}` : undefined,
      it.score !== undefined ? `score ${it.score}` : undefined,
      it.community !== undefined ? `in ${it.community}` : undefined,
      it.created_at !== undefined ? it.created_at.slice(0, 10) : undefined,
    ]
      .filter((p): p is string => p !== undefined)
      .join(", ");
    const title = it.title !== undefined ? `${it.title}\n` : "";
    return `[${it.id}] (${meta})\n${title}${text}`;
  });
  return `Topic: ${subject}\nItems: ${items.length}\n\n<items>\n${lines.join("\n\n")}\n</items>`;
}

/** Summarise `items`. Throws `LlmError` when the model is unavailable, over budget or answers off-schema. */
export async function summarizeSocialItems(opts: SummarizeOptions): Promise<OpinionSummary> {
  const { llm, items, query, meter } = opts;
  const res = await llm.complete({
    role: "extractor",
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildSummaryPrompt(query, items) }],
    schema: SummaryModelSchema,
    effort: "medium",
    maxTokens: SUMMARY_MAX_TOKENS,
    meter,
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  const parsed = SummaryModelSchema.safeParse(res.parsed);
  if (!parsed.success) {
    throw new LlmError("provider", "schema", "The summary model returned output that does not match the expected schema", {
      retryable: false,
    });
  }
  const known = new Set(items.map((i) => i.id));
  const themes = parsed.data.themes.map((t) => {
    const kept = [...new Set(t.item_ids.filter((id) => known.has(id)))];
    if (kept.length !== t.item_ids.length) {
      opts.log?.debug("summary cited unknown item ids, dropped", { theme: t.theme, dropped: t.item_ids.length - kept.length });
    }
    return { theme: t.theme, sentiment: t.sentiment, item_ids: kept };
  });
  return OpinionSummarySchema.parse({ text: parsed.data.text, themes, cost_usd: Math.max(0, res.costUsd) });
}
