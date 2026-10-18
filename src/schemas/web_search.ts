import { z } from "zod";

/** `web_search` input and output, PLAN.md section 3.1. */

export const SEARCH_PROVIDER_NAMES = ["brave", "exa", "tavily", "perplexity"] as const;
export const RECENCY_VALUES = ["day", "week", "month", "year"] as const;

export const DEFAULT_MAX_RESULTS = 10;
export const MAX_RESULTS_LIMIT = 30;

export const WebSearchInputSchema = z.object({
  query: z.string().trim().min(1).describe("The search query."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS_LIMIT)
    .default(DEFAULT_MAX_RESULTS)
    .describe(
      "Maximum number of merged results to return (default 10, max 30). Some engines cap a single request at 20 results, so a large value can return fewer rows.",
    ),
  recency: z.enum(RECENCY_VALUES).optional().describe("Only return results from the last day, week, month or year."),
  include_domains: z.array(z.string().min(1)).optional().describe("Only return results from these domains."),
  exclude_domains: z.array(z.string().min(1)).optional().describe("Never return results from these domains."),
  providers: z
    .array(z.enum(SEARCH_PROVIDER_NAMES))
    .optional()
    .describe("Search engines to use. Default: every engine that has an API key configured."),
});

export const WebSearchResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  published_at: z.string().optional(),
  providers: z.array(z.string()),
  score: z.number(),
});

export const WebSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(WebSearchResultSchema),
  providers_used: z.array(z.string()),
  providers_failed: z.array(z.object({ provider: z.string(), error: z.string() })),
  cached: z.boolean(),
  latency_ms: z.number(),
});

/**
 * Caller-facing input: `max_results` is optional because the default is applied
 * by the service (and by the tool's schema parse).
 */
export type WebSearchInput = z.input<typeof WebSearchInputSchema>;
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;
export type WebSearchProviderFailure = WebSearchOutput["providers_failed"][number];
