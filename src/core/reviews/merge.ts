import type { NormalizedReviewsQuery, Review, ReviewSort, ReviewSource } from "../../schemas/reviews.js";
import { RECENCY_MS } from "./normalize.js";

/**
 * Filtering, sorting and the `max_results` cut, PLAN.md 14.6. Sources return
 * their reviews in their own order; this module never changes a source's
 * order for `relevance`, it only interleaves the sources round-robin.
 */

export interface FilterOutcome {
  kept: Review[];
  /** Reviews dropped by a rating bound because they carry no rating. */
  droppedUnrated: number;
  /** Reviews dropped by `recency` because they carry no date. */
  droppedUndated: number;
}

/**
 * Apply `min_rating`, `max_rating` and `recency`. A rating bound drops
 * reviews without a rating, and `recency` drops reviews without a date, so
 * the caller can say so in a caveat.
 */
export function filterReviews(reviews: readonly Review[], q: NormalizedReviewsQuery, nowMs: number): FilterOutcome {
  const hasRatingBound = q.min_rating !== undefined || q.max_rating !== undefined;
  const since = q.recency !== undefined ? nowMs - RECENCY_MS[q.recency] : undefined;
  const kept: Review[] = [];
  let droppedUnrated = 0;
  let droppedUndated = 0;
  for (const r of reviews) {
    if (hasRatingBound) {
      if (r.rating === undefined) {
        droppedUnrated++;
        continue;
      }
      if (q.min_rating !== undefined && r.rating < q.min_rating) continue;
      if (q.max_rating !== undefined && r.rating > q.max_rating) continue;
    }
    if (since !== undefined) {
      const at = r.created_at !== undefined ? Date.parse(r.created_at) : NaN;
      if (!Number.isFinite(at)) {
        droppedUndated++;
        continue;
      }
      if (at < since) continue;
    }
    kept.push(r);
  }
  return { kept, droppedUnrated, droppedUndated };
}

/** Round-robin over the per-source lists: first of each source, then second of each, and so on. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

function timeOf(r: Review): number | undefined {
  if (r.created_at === undefined) return undefined;
  const ms = Date.parse(r.created_at);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Descending (`dir` 1) or ascending (-1) comparator on an optional number; unknown values sort last. */
function byOptional(get: (r: Review) => number | undefined, dir: 1 | -1): (a: Review, b: Review) => number {
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === undefined && y === undefined) return 0;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return dir === 1 ? y - x : x - y;
  };
}

/**
 * Sort the per-source lists (in query source order) as `sort` asks:
 * `relevance` keeps each source's order and interleaves the sources
 * round-robin; `recent` is `created_at` descending; `rating_low` and
 * `rating_high` sort by rating. Unknown dates or ratings go last, and ties
 * keep the interleaved order (the sort is stable).
 */
export function sortReviews(perSource: readonly (readonly Review[])[], sort: ReviewSort): Review[] {
  const merged = interleave(perSource);
  switch (sort) {
    case "relevance":
      return merged;
    case "recent":
      return merged.sort(byOptional(timeOf, 1));
    case "rating_low":
      return merged.sort(byOptional((r) => r.rating, -1));
    case "rating_high":
      return merged.sort(byOptional((r) => r.rating, 1));
  }
}

export interface SourceReviews {
  source: ReviewSource;
  reviews: readonly Review[];
}

export interface MergeOutcome extends FilterOutcome {
  reviews: Review[];
  /** Reviews that passed the filters but did not fit in `max_results`. */
  omitted: number;
}

/** Filter each source's reviews, sort across sources, cut at `max_results`. Sources follow `q.sources` order. */
export function mergeReviews(results: readonly SourceReviews[], q: NormalizedReviewsQuery, nowMs: number): MergeOutcome {
  const ordered = q.sources.map((s) => results.find((r) => r.source === s)).filter((r): r is SourceReviews => r !== undefined);
  const seen = new Set<string>();
  let droppedUnrated = 0;
  let droppedUndated = 0;
  const perSource = ordered.map((r) => {
    const outcome = filterReviews(r.reviews, q, nowMs);
    droppedUnrated += outcome.droppedUnrated;
    droppedUndated += outcome.droppedUndated;
    return outcome.kept.filter((review) => {
      if (seen.has(review.id)) return false;
      seen.add(review.id);
      return true;
    });
  });
  const sorted = sortReviews(perSource, q.sort);
  return {
    reviews: sorted.slice(0, q.max_results),
    omitted: Math.max(0, sorted.length - q.max_results),
    kept: sorted,
    droppedUnrated,
    droppedUndated,
  };
}
