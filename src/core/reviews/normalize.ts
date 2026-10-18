import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  DEFAULT_SOURCES_BY_KIND,
  REVIEW_KINDS,
  REVIEW_TEXT_MAX_CHARS,
  type NormalizedReviewsQuery,
  type ReviewKind,
  type ReviewSource,
  type SearchReviewsInputSchema,
} from "../../schemas/reviews.js";
import { RECENCY_MS } from "../search/providers/shared.js";

/**
 * Query normalisation and the small value helpers every review source shares
 * (PLAN.md 14.6): default sources by kind, rating normalisation, text cut,
 * ids and dates.
 */

/** The tool input after `SearchReviewsInputSchema` applied its defaults. */
export type ParsedSearchReviewsInput = z.output<typeof SearchReviewsInputSchema>;

export { RECENCY_MS };

/** Caveat added when a source could only approximate `created_at` from a relative date. */
export const APPROXIMATE_DATE_CAVEAT =
  'Some created_at values are approximate: the site printed a relative date such as "2 months ago".';

/** The canonical string form of `value` when it is an absolute http(s) URL, else undefined. */
export function parseHttpUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString();
}

/** Kinds for which `source` answers when the caller names no sources (PLAN.md 14.6 table). */
export function kindsDefaultingTo(source: ReviewSource): ReviewKind[] {
  return REVIEW_KINDS.filter((kind) => DEFAULT_SOURCES_BY_KIND[kind].includes(source));
}

export interface NormalizeReviewsOptions {
  /** Names of the sources that are configured right now. Must be non-empty when `input.sources` is unset. */
  configuredSources: readonly ReviewSource[];
}

/**
 * Turn the validated tool input into the query every source receives.
 * `sources` unset means the configured sources whose default kinds include
 * `kind`; when none of them does, every configured source. An explicit list is
 * kept as given, so an unconfigured source can be reported in `sources_failed`.
 */
export function normalizeReviewsInput(input: ParsedSearchReviewsInput, opts: NormalizeReviewsOptions): NormalizedReviewsQuery {
  const subject = input.subject.trim();
  const subjectUrl = parseHttpUrl(subject);

  let sources: ReviewSource[];
  if (input.sources !== undefined) {
    sources = [...new Set(input.sources)];
  } else {
    const configured = [...new Set(opts.configuredSources)];
    const byKind = DEFAULT_SOURCES_BY_KIND[input.kind].filter((s) => configured.includes(s));
    sources = byKind.length > 0 ? byKind : configured;
    if (sources.length === 0) {
      throw new RangeError("normalizeReviewsInput: no configured sources and none named in the input");
    }
  }

  return {
    subject,
    ...(subjectUrl !== undefined && { subject_url: subjectUrl }),
    kind: input.kind,
    ...(input.location !== undefined && { location: input.location.trim() }),
    sources,
    max_results: input.max_results,
    per_source: input.per_source,
    ...(input.min_rating !== undefined && { min_rating: input.min_rating }),
    ...(input.max_rating !== undefined && { max_rating: input.max_rating }),
    ...(input.recency !== undefined && { recency: input.recency }),
    sort: input.sort,
    app_store_country: input.app_store_country,
  };
}

/** The scale a source prints ratings on: five stars, ten points, or a percentage. */
export type RatingScale = 5 | 10 | 100;

/**
 * A rating on the 1..5 scale in half steps (PLAN.md 14.6): a 10-point value is
 * halved, a percentage divided by 20. Anything below 1 is pinned to 1 (a
 * 1/10 is still the lowest star), anything above the scale's maximum to 5.
 * Non-finite or non-positive input has no rating.
 */
export function normalizeRating(value: number, scale: RatingScale = 5): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const onFive = scale === 10 ? value / 2 : scale === 100 ? value / 20 : value;
  const half = Math.round(onFive * 2) / 2;
  return Math.min(5, Math.max(1, half));
}

/** Collapse whitespace and cut at REVIEW_TEXT_MAX_CHARS. Truncation is always flagged. */
export function truncateReviewText(raw: string): { text: string; truncated: boolean } {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= REVIEW_TEXT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, REVIEW_TEXT_MAX_CHARS).trimEnd(), truncated: true };
}

/** 12 hex characters of the sha256 of `text`, for sources without a native review id. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** `"<source>:<native id>"`, or `"<source>:<12-hex hash of fallback>"` when the site gives no id. */
export function reviewId(source: ReviewSource, nativeId: string | undefined, fallback: string): string {
  const native = nativeId?.trim();
  return `${source}:${native !== undefined && native !== "" ? native : shortHash(fallback)}`;
}

/** An ISO 8601 UTC timestamp for a parseable date string or epoch, else undefined. */
export function toIsoUtc(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value.trim());
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3600_000,
  hr: 3600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

export interface ParsedReviewDate {
  iso: string;
  /** True when the date was computed from a relative phrase and is only approximate. */
  approximate: boolean;
}

/**
 * Read a date as review sites print it: an ISO timestamp or any absolute date
 * `Date.parse` accepts is exact; "today", "yesterday", "just now", "2 months
 * ago", "an hour ago" and "Updated 3 days ago" are approximated from `nowMs`.
 */
export function parseReviewDate(raw: string, nowMs: number): ParsedReviewDate | undefined {
  const text = raw.trim().replace(/^(?:updated|posted|reviewed|written)\s+/i, "");
  if (text === "") return undefined;
  const lowered = text.toLowerCase();
  if (/^(?:just now|today|moments? ago)$/.test(lowered)) return { iso: new Date(nowMs).toISOString(), approximate: true };
  if (lowered === "yesterday") return { iso: new Date(nowMs - RELATIVE_UNIT_MS["day"]!).toISOString(), approximate: true };
  const rel = /^(?:about |over |almost |~)?(an?|\d+)\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago$/.exec(lowered);
  if (rel !== null) {
    const count = rel[1] === "a" || rel[1] === "an" ? 1 : Number(rel[1]);
    const unit = RELATIVE_UNIT_MS[rel[2] as string] as number;
    return { iso: new Date(nowMs - count * unit).toISOString(), approximate: true };
  }
  const iso = toIsoUtc(text);
  return iso === undefined ? undefined : { iso, approximate: false };
}
