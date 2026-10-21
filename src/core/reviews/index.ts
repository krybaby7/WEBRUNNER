import { z } from "zod";
import type { Logger } from "../../log.js";
import type { ErrorCode } from "../../schemas/error.js";
import {
  ReviewSchema,
  ReviewSubjectSchema,
  type NormalizedReviewsQuery,
  type Review,
  type ReviewSource,
  type ReviewSubject,
  type SearchReviewsOutput,
} from "../../schemas/reviews.js";
import type { Cache } from "../cache/index.js";
import { CostMeter } from "../llm/cost.js";
import { LlmError, type LlmClient } from "../llm/types.js";
import { mergeReviews } from "./merge.js";
import { normalizeReviewsInput, truncateReviewText, type ParsedSearchReviewsInput } from "./normalize.js";
import { summarizeReviews, summaryFailureCaveat } from "./summary.js";
import { ReviewSourceError, type ReviewSearchResult, type ReviewSourceProvider } from "./types.js";

/**
 * The `search_reviews` service, PLAN.md 14.6: normalise, pick sources, run
 * them in parallel under per-source timeouts, cache each source's answer for
 * an hour, filter, sort, cut, and optionally summarise.
 */

export const REVIEWS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Per-source time budgets (PLAN.md 14.6): 15 s for API sources, 60 s for browser
 * sources and for Trustpilot, whose WAF challenge sends it through the browser
 * (a name lookup renders two pages; live 2026-10-21, 15 s timed out).
 */
export const DEFAULT_SOURCE_TIMEOUTS_MS: Readonly<Record<ReviewSource, number>> = {
  app_store: 15_000,
  trustpilot: 60_000,
  google_maps: 60_000,
  google_play: 60_000,
  amazon: 60_000,
};

const NOT_CONFIGURED_HINT: Readonly<Record<ReviewSource, string>> = {
  app_store: "not configured",
  trustpilot: "not configured",
  google_maps: "not configured: no browser session is available",
  google_play: "not configured: no browser session is available",
  amazon: "not configured: no browser session is available (and Amazon may need a connected account)",
};

export type ReviewsSearchErrorCode = Extract<ErrorCode, "config" | "provider" | "timeout" | "blocked" | "invalid_input">;

export interface FailedSource {
  source: ReviewSource;
  error: string;
  needs_login: boolean;
}

/** Thrown when no source answered. `code` is the most specific code the failures share (PLAN.md 3.6). */
export class ReviewsSearchError extends Error {
  readonly code: ReviewsSearchErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ReviewsSearchErrorCode, message: string, retryable: boolean, details?: unknown) {
    super(message);
    this.name = "ReviewsSearchError";
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export interface ReviewsServiceDeps {
  /** Every source, configured or not. */
  sources: ReviewSourceProvider[];
  cache: Cache;
  llm?: LlmClient;
  log: Logger;
  /** Overrides the per-source timeouts. */
  timeoutsMs?: Partial<Record<ReviewSource, number>>;
  /** Clock in epoch milliseconds. Default Date.now. */
  now?: () => number;
}

export interface ReviewsService {
  /**
   * The validated tool input to the tool output. Throws `ReviewsSearchError`
   * when nothing could be searched; a source that fails while others answer
   * is reported in `sources_failed`.
   */
  search(input: ParsedSearchReviewsInput, signal?: AbortSignal): Promise<SearchReviewsOutput>;
}

interface Failure extends FailedSource {
  code: ErrorCode;
  retryable: boolean;
  /** True for "not configured"; such entries do not decide the error code when a real failure exists. */
  unconfigured: boolean;
}

const CachedResultSchema = z.object({ subject: ReviewSubjectSchema, reviews: z.array(ReviewSchema) });

/** Reject when `signal` aborts, even if the source ignores it. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal, source: ReviewSource, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new ReviewSourceError(`${source} did not answer within ${Math.round(timeoutMs / 1000)} s (timed out or cancelled)`, {
          source,
          code: "timeout",
          retryable: true,
        }),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function classify(err: unknown, source: ReviewSource): Failure {
  if (err instanceof ReviewSourceError) {
    const code: ErrorCode = err.code === "not_found" ? "provider" : err.code;
    return { source, error: err.message, needs_login: err.needsLogin, code, retryable: err.retryable, unconfigured: false };
  }
  if (err instanceof LlmError) {
    return { source, error: err.message, needs_login: false, code: err.code, retryable: err.retryable, unconfigured: false };
  }
  const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
  return { source, error: message, needs_login: false, code: "provider", retryable: false, unconfigured: false };
}

/** Most specific code wins: blocked, then a code every real failure shares, then provider. */
function noSourceAnswered(failures: Failure[]): ReviewsSearchError {
  const real = failures.filter((f) => !f.unconfigured);
  const basis = real.length > 0 ? real : failures;
  const first = basis[0] as Failure;
  let code: ReviewsSearchErrorCode;
  if (basis.some((f) => f.code === "blocked")) code = "blocked";
  else if (basis.every((f) => f.code === first.code) && isServiceCode(first.code)) code = first.code;
  else code = "provider";
  const retryable = code !== "blocked" && basis.some((f) => f.retryable);
  const loginHint = failures.some((f) => f.needs_login) ? " Connect the account with the accounts tool and try again." : "";
  const message =
    failures.length === 1
      ? `${first.source}: ${first.error}${loginHint}`
      : `No review source answered. ${failures.map((f) => `${f.source}: ${f.error}`).join("; ")}${loginHint}`;
  return new ReviewsSearchError(code, message, retryable, {
    sources_failed: failures.map((f): FailedSource => ({ source: f.source, error: f.error, needs_login: f.needs_login })),
  });
}

function isServiceCode(code: ErrorCode): code is ReviewsSearchErrorCode {
  return code === "config" || code === "provider" || code === "timeout" || code === "blocked" || code === "invalid_input";
}

/** Enforce the text cut and the source tag whatever a source returned. */
function tidy(source: ReviewSource, result: ReviewSearchResult): ReviewSearchResult {
  const reviews = result.reviews.map((r): Review => {
    const cut = truncateReviewText(r.text);
    return { ...r, source, text: cut.text, truncated: r.truncated || cut.truncated };
  });
  return { subject: { ...result.subject, source }, reviews };
}

export function createReviewsService(deps: ReviewsServiceDeps): ReviewsService {
  const { cache, log } = deps;
  const now = deps.now ?? Date.now;

  function cacheKey(source: ReviewSource, q: NormalizedReviewsQuery): Record<string, unknown> {
    return {
      kind: "search_reviews",
      source,
      subject: q.subject.toLowerCase(),
      subject_url: q.subject_url,
      location: q.location?.toLowerCase(),
      per_source: q.per_source,
      app_store_country: q.app_store_country,
    };
  }

  async function runSource(
    provider: ReviewSourceProvider,
    q: NormalizedReviewsQuery,
    meter: CostMeter,
    caveats: string[],
    outer: AbortSignal | undefined,
  ): Promise<ReviewSearchResult> {
    const key = cacheKey(provider.name, q);
    const stored = await cache.get<unknown>(key);
    if (stored !== undefined) {
      const hit = CachedResultSchema.safeParse(stored);
      if (hit.success) {
        log.debug("search_reviews: cache hit", { source: provider.name });
        return hit.data;
      }
      log.warn("search_reviews: cache entry does not match the result schema, ignoring it", { source: provider.name });
    }
    const timeoutMs = deps.timeoutsMs?.[provider.name] ?? DEFAULT_SOURCE_TIMEOUTS_MS[provider.name];
    const signals = [AbortSignal.timeout(timeoutMs), ...(outer !== undefined ? [outer] : [])];
    const signal = AbortSignal.any(signals);
    const started = now();
    const found = tidy(provider.name, await raceAbort(provider.search(q, signal, { caveats, meter }), signal, provider.name, timeoutMs));
    const checked = CachedResultSchema.safeParse(found);
    if (!checked.success) {
      const detail = checked.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new ReviewSourceError(`${provider.name} returned reviews that fail the schema (${detail})`, {
        source: provider.name,
        code: "provider",
        retryable: false,
      });
    }
    log.debug("search_reviews: source done", { source: provider.name, reviews: checked.data.reviews.length, elapsed_ms: Math.max(0, now() - started) });
    await cache.set(key, checked.data, REVIEWS_CACHE_TTL_MS);
    return checked.data;
  }

  async function search(input: ParsedSearchReviewsInput, signal?: AbortSignal): Promise<SearchReviewsOutput> {
    const all = deps.sources;
    const configured = all.filter((s) => s.isConfigured());
    if (input.sources === undefined && configured.length === 0) {
      throw new ReviewsSearchError(
        "config",
        "No review source is configured. App Store and Trustpilot need nothing; Google Maps, Google Play and Amazon need the browser.",
        false,
      );
    }
    const query = normalizeReviewsInput(input, { configuredSources: configured.map((s) => s.name) });
    const meter = new CostMeter({ maxCostUsd: input.max_cost_usd });
    const sourceCaveats: string[] = [];
    const failures: Failure[] = [];
    const results: Array<{ source: ReviewSource; result: ReviewSearchResult }> = [];

    await Promise.all(
      query.sources.map(async (source) => {
        const provider = all.find((p) => p.name === source);
        if (provider === undefined || !provider.isConfigured()) {
          failures.push({ source, error: NOT_CONFIGURED_HINT[source], needs_login: false, code: "config", retryable: false, unconfigured: true });
          return;
        }
        try {
          results.push({ source, result: await runSource(provider, query, meter, sourceCaveats, signal) });
        } catch (err) {
          const f = classify(err, source);
          log.warn("review source failed", { source, code: f.code, needs_login: f.needs_login, error: f.error });
          failures.push(f);
        }
      }),
    );

    if (results.length === 0) throw noSourceAnswered(failures);

    const nowMs = now();
    const merged = mergeReviews(
      results.map((r) => ({ source: r.source, reviews: r.result.reviews })),
      query,
      nowMs,
    );
    const subjects: ReviewSubject[] = query.sources
      .map((s) => results.find((r) => r.source === s)?.result.subject)
      .filter((s): s is ReviewSubject => s !== undefined);
    const caveats: string[] = [...new Set(sourceCaveats)];

    let summary: SearchReviewsOutput["summary"];
    if (input.summarize) {
      if (merged.reviews.length === 0) caveats.push("No summary: there are no reviews to summarise.");
      else if (deps.llm === undefined) caveats.push("No summary: the Claude API client is not available.");
      else {
        try {
          summary = await summarizeReviews({
            llm: deps.llm,
            subject: query.subject,
            subjects,
            reviews: merged.reviews,
            meter,
            ...(signal !== undefined && { signal }),
          });
        } catch (err) {
          const caveat = summaryFailureCaveat(err);
          log.warn("search_reviews: summary failed", { error: caveat });
          caveats.push(caveat);
        }
      }
    }

    if (merged.droppedUnrated > 0) caveats.push(`${merged.droppedUnrated} review(s) without a rating were left out by the rating filter.`);
    if (merged.droppedUndated > 0) caveats.push(`${merged.droppedUndated} review(s) without a date were left out by the recency filter.`);
    if (merged.omitted > 0) caveats.push(`${merged.omitted} further review(s) were left out to stay within max_results (${query.max_results}).`);
    if (merged.reviews.length === 0) caveats.push("No reviews matched this search.");

    return {
      query,
      subjects,
      reviews: merged.reviews,
      ...(summary !== undefined && { summary }),
      sources_used: query.sources.filter((s) => results.some((r) => r.source === s)),
      sources_failed: query.sources
        .map((s) => failures.find((f) => f.source === s))
        .filter((f): f is Failure => f !== undefined)
        .map((f): FailedSource => ({ source: f.source, error: f.error, needs_login: f.needs_login })),
      fetched_at: new Date(nowMs).toISOString(),
      caveats,
    };
  }

  return { search };
}
