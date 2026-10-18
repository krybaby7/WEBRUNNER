import { z } from "zod";

/** `fetch_page` input and output, PLAN.md section 3.2. */

export const FETCH_MODES = ["auto", "fast", "browser"] as const;
export const FETCH_METHODS = ["firecrawl", "jina", "direct", "browser"] as const;

export const DEFAULT_MAX_CHARS = 40_000;
export const MIN_MAX_CHARS = 1000;
export const MAX_MAX_CHARS = 500_000;

export const FetchPageInputSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Only http and https URLs are supported.")
    .describe("The http(s) URL of the page to read."),
  mode: z
    .enum(FETCH_MODES)
    .default("auto")
    .describe(
      "auto (default): try the fast fetchers, then a real browser when the page is bot-walled or has almost no text. fast: fast fetchers only, never opens a browser. browser: always render in the real browser.",
    ),
  max_chars: z
    .number()
    .int()
    .min(MIN_MAX_CHARS)
    .max(MAX_MAX_CHARS)
    .default(DEFAULT_MAX_CHARS)
    .describe(
      "Maximum characters of Markdown to return (default 40000, 1000 to 500000). When the page is longer, `truncated` is true.",
    ),
  wait_for: z
    .string()
    .min(1)
    .optional()
    .describe("Browser mode only: a CSS selector to wait for before extracting the page."),
});

export const FetchPageOutputSchema = z.object({
  url: z.string(),
  final_url: z.string(),
  title: z.string(),
  markdown: z.string(),
  truncated: z.boolean(),
  method: z.enum(FETCH_METHODS),
  fetched_at: z.string(),
  cached: z.boolean(),
});

/** Caller-facing input: `mode` and `max_chars` are optional, defaults are applied by the service. */
export type FetchPageInput = z.input<typeof FetchPageInputSchema>;
export type FetchPageOutput = z.infer<typeof FetchPageOutputSchema>;
export type FetchMode = (typeof FETCH_MODES)[number];
