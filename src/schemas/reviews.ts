import { z } from "zod";
import { OpinionSummarySchema } from "./social.js";
import { RECENCY_VALUES } from "./web_search.js";

/**
 * Shared schemas for `search_reviews`, PLAN.md section 14.6.
 * Owned by WP15; consumed by WP19a (tool, App Store, Trustpilot) and WP19b (browser sources).
 */

export const REVIEW_SOURCES = ["google_maps", "trustpilot", "app_store", "google_play", "amazon"] as const;
export const ReviewSourceSchema = z.enum(REVIEW_SOURCES);
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;

export const REVIEW_KINDS = ["place", "business", "product", "app", "any"] as const;
export const ReviewKindSchema = z.enum(REVIEW_KINDS);
export type ReviewKind = z.infer<typeof ReviewKindSchema>;

export const REVIEW_SORTS = ["relevance", "recent", "rating_low", "rating_high"] as const;
export const ReviewSortSchema = z.enum(REVIEW_SORTS);
export type ReviewSort = z.infer<typeof ReviewSortSchema>;

/** Which sources answer by default for each kind (PLAN.md 14.6). */
export const DEFAULT_SOURCES_BY_KIND: Readonly<Record<ReviewKind, readonly ReviewSource[]>> = {
  place: ["google_maps"],
  business: ["google_maps", "trustpilot"],
  product: ["amazon", "trustpilot"],
  app: ["app_store", "google_play"],
  any: ["google_maps", "trustpilot", "app_store", "google_play", "amazon"],
};

export const DEFAULT_MAX_REVIEWS = 30;
export const MAX_REVIEWS_LIMIT = 100;
export const DEFAULT_PER_SOURCE = 15;
export const MAX_PER_SOURCE = 50;
export const REVIEW_TEXT_MAX_CHARS = 2000;
export const DEFAULT_REVIEWS_MAX_COST_USD = 0.5;
export const SUBJECT_MAX_CHARS = 300;

const RatingBound = z.number().min(1).max(5);
const CountryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, { error: "must be an ISO 3166-1 alpha-2 country code, for example us" })
  .transform((s) => s.toLowerCase());

export const SearchReviewsInputSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1)
      .max(SUBJECT_MAX_CHARS)
      .describe("A name ('Hotel Lutetia Paris', 'Sony WH-1000XM5', 'Notion') or the URL of a product, place or app page."),
    kind: ReviewKindSchema.default("any").describe("place, business, product, app or any (default). Steers which sources answer."),
    location: z.string().trim().min(1).max(120).optional().describe("Disambiguates places and businesses, for example 'Paris'."),
    sources: z.array(ReviewSourceSchema).min(1).optional().describe("Defaults to the configured sources that cover `kind`."),
    max_results: z.number().int().min(1).max(MAX_REVIEWS_LIMIT).default(DEFAULT_MAX_REVIEWS),
    per_source: z.number().int().min(1).max(MAX_PER_SOURCE).default(DEFAULT_PER_SOURCE),
    min_rating: RatingBound.optional(),
    max_rating: RatingBound.optional(),
    recency: z.enum(RECENCY_VALUES).optional().describe("Only reviews from the last day, week, month or year."),
    sort: ReviewSortSchema.default("relevance"),
    app_store_country: CountryCode.default("us").describe("App Store storefront, ISO 3166-1 alpha-2; default us."),
    summarize: z.boolean().default(false).describe("Also write a short summary with themes and sentiment. Needs a model backend (ANTHROPIC_API_KEY or the claude CLI)."),
    max_cost_usd: z.number().positive().default(DEFAULT_REVIEWS_MAX_COST_USD).describe("Cap on Claude API spend for this call."),
  })
  .refine((i) => i.min_rating === undefined || i.max_rating === undefined || i.min_rating <= i.max_rating, {
    error: "min_rating must not exceed max_rating",
    path: ["min_rating"],
  });
export type SearchReviewsInput = z.input<typeof SearchReviewsInputSchema>;

/** The query as every source receives it. */
export const NormalizedReviewsQuerySchema = z.object({
  subject: z.string().min(1),
  /** Set when `subject` parsed as an http(s) URL. */
  subject_url: z.string().url().optional(),
  kind: ReviewKindSchema,
  location: z.string().min(1).optional(),
  sources: z.array(ReviewSourceSchema).min(1),
  max_results: z.number().int().min(1).max(MAX_REVIEWS_LIMIT),
  per_source: z.number().int().min(1).max(MAX_PER_SOURCE),
  min_rating: RatingBound.optional(),
  max_rating: RatingBound.optional(),
  recency: z.enum(RECENCY_VALUES).optional(),
  sort: ReviewSortSchema,
  app_store_country: z.string().regex(/^[a-z]{2}$/),
});
export type NormalizedReviewsQuery = z.infer<typeof NormalizedReviewsQuerySchema>;

export const RatingDistributionSchema = z.object({
  "1": z.number().int().nonnegative(),
  "2": z.number().int().nonnegative(),
  "3": z.number().int().nonnegative(),
  "4": z.number().int().nonnegative(),
  "5": z.number().int().nonnegative(),
});

export const ReviewSubjectSchema = z.object({
  source: ReviewSourceSchema,
  name: z.string().min(1),
  url: z.string().url().optional(),
  rating_avg: z.number().min(0).max(5).optional(),
  review_count: z.number().int().nonnegative().optional(),
  rating_distribution: RatingDistributionSchema.optional(),
  address: z.string().min(1).optional(),
  categories: z.array(z.string().min(1)).optional(),
  price_level: z.string().min(1).optional(),
});
export type ReviewSubject = z.infer<typeof ReviewSubjectSchema>;

export const ReviewSchema = z.object({
  id: z.string().min(1),
  source: ReviewSourceSchema,
  url: z.string().url().optional(),
  author: z.string().min(1).optional(),
  rating: z.number().min(1).max(5).optional(),
  title: z.string().min(1).optional(),
  text: z.string().max(REVIEW_TEXT_MAX_CHARS),
  truncated: z.boolean(),
  created_at: z.string().optional(),
  helpful_votes: z.number().int().nonnegative().optional(),
  verified: z.boolean().optional(),
  version: z.string().min(1).optional(),
  language: z.string().optional(),
  response: z.object({ text: z.string().min(1), created_at: z.string().optional() }).optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const SearchReviewsOutputSchema = z.object({
  query: NormalizedReviewsQuerySchema,
  subjects: z.array(ReviewSubjectSchema),
  reviews: z.array(ReviewSchema).max(MAX_REVIEWS_LIMIT),
  summary: OpinionSummarySchema.optional(),
  sources_used: z.array(ReviewSourceSchema),
  sources_failed: z.array(z.object({ source: ReviewSourceSchema, error: z.string(), needs_login: z.boolean() })),
  fetched_at: z.string(),
  caveats: z.array(z.string()),
});
export type SearchReviewsOutput = z.infer<typeof SearchReviewsOutputSchema>;
