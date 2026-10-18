import type { NormalizedReviewsQuery, Review, ReviewKind, ReviewSource, ReviewSubject } from "../../schemas/reviews.js";
import type { CostMeter } from "../llm/cost.js";

export type { NormalizedReviewsQuery, Review, ReviewKind, ReviewSource, ReviewSubject };

/** Caveat sink and shared LLM budget, PLAN.md 14.8. */
export interface ReviewHooks {
  caveats?: string[];
  meter?: CostMeter;
}

export interface ReviewSearchResult {
  /** What this source matched the subject to. */
  subject: ReviewSubject;
  /** At most `q.per_source` reviews, validated by `ReviewSchema`, tagged `source: name`, in the source's own order. */
  reviews: Review[];
}

/**
 * One review site, PLAN.md 14.6 and 14.8. Browser sources only navigate,
 * scroll and read. Failures are `ReviewSourceError`; a login wall sets `needsLogin`.
 */
export interface ReviewSourceProvider {
  readonly name: ReviewSource;
  /** Kinds this source answers for when the caller does not name sources. */
  readonly defaultKinds: readonly ReviewKind[];
  isConfigured(): boolean;
  search(q: NormalizedReviewsQuery, signal: AbortSignal, hooks?: ReviewHooks): Promise<ReviewSearchResult>;
}

export type ReviewSourceErrorCode = "provider" | "timeout" | "config" | "blocked" | "invalid_input" | "not_found";

export interface ReviewSourceErrorOptions {
  source: ReviewSource;
  code: ReviewSourceErrorCode;
  retryable: boolean;
  needsLogin?: boolean;
  status?: number;
  cause?: unknown;
}

/** Failure of a review source. `not_found` means the subject could not be matched on this site. */
export class ReviewSourceError extends Error {
  readonly source: ReviewSource;
  readonly code: ReviewSourceErrorCode;
  readonly retryable: boolean;
  readonly needsLogin: boolean;
  readonly status?: number;

  constructor(message: string, options: ReviewSourceErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ReviewSourceError";
    this.source = options.source;
    this.code = options.code;
    this.retryable = options.retryable;
    this.needsLogin = options.needsLogin ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}
