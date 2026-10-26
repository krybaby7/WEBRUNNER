import { z } from "zod";
import { RECENCY_VALUES } from "./web_search.js";

/**
 * Shared schemas for `social_search`, PLAN.md section 14.5.
 * Owned by WP15; consumed by WP18a (tool, API platforms) and WP18b (browser platforms).
 */

export const SOCIAL_PLATFORMS = ["reddit", "hackernews", "bluesky", "x", "facebook", "youtube"] as const;
export const SocialPlatformSchema = z.enum(SOCIAL_PLATFORMS);
export type SocialPlatform = z.infer<typeof SocialPlatformSchema>;

export const SOCIAL_KINDS = ["posts", "comments", "both"] as const;
export const SocialKindSchema = z.enum(SOCIAL_KINDS);
export type SocialKind = z.infer<typeof SocialKindSchema>;

export const SOCIAL_SORTS = ["engagement", "recent"] as const;
export const SocialSortSchema = z.enum(SOCIAL_SORTS);
export type SocialSort = z.infer<typeof SocialSortSchema>;

export const SENTIMENTS = ["positive", "negative", "mixed", "neutral"] as const;
export const SentimentSchema = z.enum(SENTIMENTS);

export const DEFAULT_MAX_SOCIAL_RESULTS = 30;
export const MAX_SOCIAL_RESULTS_LIMIT = 100;
export const DEFAULT_PER_PLATFORM = 15;
export const MAX_PER_PLATFORM = 50;
export const SOCIAL_TEXT_MAX_CHARS = 2000;
export const DEFAULT_SOCIAL_MAX_COST_USD = 0.5;
export const QUERY_MAX_CHARS = 300;

const LangSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}$/, { error: "must be a BCP-47 primary language tag, for example en" })
  .transform((s) => s.toLowerCase());

export const SocialSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(QUERY_MAX_CHARS).optional().describe("What to search for. Required unless `url` is given."),
    url: z
      .url({ protocol: /^https?$/ })
      .optional()
      .describe("A post, thread or video URL on a supported platform: returns that thread's comments instead of searching."),
    platforms: z.array(SocialPlatformSchema).min(1).optional().describe("Defaults to every configured platform."),
    kind: SocialKindSchema.default("both").describe("posts, comments, or both (default)."),
    recency: z.enum(RECENCY_VALUES).optional().describe("Only items from the last day, week, month or year."),
    sort: SocialSortSchema.default("engagement").describe("engagement: most upvoted or liked first. recent: newest first."),
    max_results: z.number().int().min(1).max(MAX_SOCIAL_RESULTS_LIMIT).default(DEFAULT_MAX_SOCIAL_RESULTS),
    per_platform: z.number().int().min(1).max(MAX_PER_PLATFORM).default(DEFAULT_PER_PLATFORM),
    subreddits: z.array(z.string().trim().min(1).max(50)).min(1).optional().describe("Reddit only: restrict to these subreddits."),
    lang: LangSchema.optional().describe("Language filter for platforms that support one (bluesky, x)."),
    summarize: z.boolean().default(false).describe("Also write a short 'what people are saying' summary with themes and sentiment. Needs a model backend (ANTHROPIC_API_KEY or the claude CLI)."),
    max_cost_usd: z.number().positive().default(DEFAULT_SOCIAL_MAX_COST_USD).describe("Cap on Claude API spend for this call."),
  })
  .refine((i) => i.query !== undefined || i.url !== undefined, { error: "give a query or a url", path: ["query"] });
export type SocialSearchInput = z.input<typeof SocialSearchInputSchema>;

/** The query as every platform receives it. `mode: "thread"` carries `url`; `mode: "search"` carries `query`. */
export const SocialSearchQuerySchema = z.object({
  mode: z.enum(["search", "thread"]),
  query: z.string().min(1).optional(),
  url: z.string().url().optional(),
  platforms: z.array(SocialPlatformSchema).min(1),
  kind: SocialKindSchema,
  recency: z.enum(RECENCY_VALUES).optional(),
  sort: SocialSortSchema,
  max_results: z.number().int().min(1).max(MAX_SOCIAL_RESULTS_LIMIT),
  per_platform: z.number().int().min(1).max(MAX_PER_PLATFORM),
  subreddits: z.array(z.string().min(1)).optional(),
  lang: z.string().optional(),
});
export type SocialSearchQuery = z.infer<typeof SocialSearchQuerySchema>;

export const SocialItemSchema = z.object({
  id: z.string().min(1),
  platform: SocialPlatformSchema,
  kind: z.enum(["post", "comment"]),
  url: z.string().url(),
  author: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  text: z.string().max(SOCIAL_TEXT_MAX_CHARS),
  truncated: z.boolean(),
  created_at: z.string().optional(),
  score: z.number().optional(),
  replies: z.number().int().nonnegative().optional(),
  reposts: z.number().int().nonnegative().optional(),
  community: z.string().min(1).optional(),
  parent_url: z.string().url().optional(),
  lang: z.string().optional(),
});
export type SocialItem = z.infer<typeof SocialItemSchema>;

/** Shared with `search_reviews`: the LLM-written synthesis, PLAN.md 14.5 and 14.6. */
export const OpinionSummarySchema = z.object({
  text: z.string().min(1),
  themes: z.array(z.object({ theme: z.string().min(1), sentiment: SentimentSchema, item_ids: z.array(z.string().min(1)) })),
  cost_usd: z.number().nonnegative(),
});
export type OpinionSummary = z.infer<typeof OpinionSummarySchema>;

export const SocialSearchOutputSchema = z.object({
  query: SocialSearchQuerySchema,
  items: z.array(SocialItemSchema).max(MAX_SOCIAL_RESULTS_LIMIT),
  summary: OpinionSummarySchema.optional(),
  platforms_used: z.array(SocialPlatformSchema),
  platforms_failed: z.array(z.object({ platform: SocialPlatformSchema, error: z.string(), needs_login: z.boolean() })),
  fetched_at: z.string(),
  caveats: z.array(z.string()),
});
export type SocialSearchOutput = z.infer<typeof SocialSearchOutputSchema>;
