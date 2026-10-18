import { z } from "zod";
import type { NormalizedReviewsQuery, Review, ReviewKind, ReviewSubject } from "../../../schemas/reviews.js";
import { describeIssues, requestJson, type FetchImpl } from "../http.js";
import { kindsDefaultingTo, normalizeRating, reviewId, toIsoUtc, truncateReviewText } from "../normalize.js";
import { ReviewSourceError, type ReviewHooks, type ReviewSearchResult, type ReviewSourceProvider } from "../types.js";

/**
 * Apple App Store customer reviews, keyless (PLAN.md 14.6).
 *
 * Verified live on 2026-10-18 from the development environment:
 *   GET https://itunes.apple.com/search?term=Notion&entity=software&country=us&limit=5          -> 200, 5 results
 *   GET https://itunes.apple.com/us/rss/customerreviews/id=1232780281/sortBy=mostRecent/page=1/json -> 200, 50 entries
 * The `lookup` endpoint (same result shape as `search`, used for app URLs) is
 * from Apple's iTunes Search API documentation.
 *
 * A review entry carries `im:rating`, `im:version`, `title`, `content`,
 * `author.name`, `updated`, `id` and `im:voteSum`. The first entry of a page
 * can be the app itself (no `im:rating`); it is skipped. Pages 1 to 3 are read
 * at most, stopping when `per_source` is reached or a page is empty.
 */

const DEFAULT_BASE_URL = "https://itunes.apple.com";
export const APP_STORE_MAX_PAGES = 3;
const SEARCH_LIMIT = 5;

export interface AppStoreOptions {
  fetchImpl?: FetchImpl;
  /** Replaces https://itunes.apple.com. For tests. */
  baseUrl?: string;
}

const SearchResult = z.object({
  trackId: z.number().int(),
  trackName: z.string().min(1),
  trackViewUrl: z.string().optional(),
  averageUserRating: z.number().optional(),
  userRatingCount: z.number().optional(),
  sellerName: z.string().optional(),
  primaryGenreName: z.string().optional(),
  genres: z.array(z.string()).optional(),
});
const SearchResponse = z.object({ resultCount: z.number().optional(), results: z.array(SearchResult) });
type AppMatch = z.infer<typeof SearchResult>;

const Label = z.object({ label: z.string() });
const Entry = z.object({
  id: Label.optional(),
  title: Label.optional(),
  content: Label.optional(),
  updated: Label.optional(),
  "im:rating": Label.optional(),
  "im:version": Label.optional(),
  "im:voteSum": Label.optional(),
  author: z.object({ name: Label.optional() }).optional(),
});
type FeedEntry = z.infer<typeof Entry>;
// A page with one review carries `entry` as an object, a page with none has no `entry` at all.
const FeedResponse = z.object({ feed: z.object({ entry: z.union([z.array(Entry), Entry]).optional() }) });

/** `apps.apple.com/<cc>/app/<slug>/id<digits>` (the storefront and slug are optional). */
const APP_URL = /^https?:\/\/(?:apps|itunes)\.apple\.com\/(?:([a-z]{2})\/)?(?:app\/)?(?:[^/?#]+\/)?id(\d+)/i;

export function parseAppStoreUrl(url: string): { id: string; country?: string } | undefined {
  const m = APP_URL.exec(url);
  if (m === null) return undefined;
  const country = m[1]?.toLowerCase();
  return { id: m[2] as string, ...(country !== undefined && { country }) };
}

export class AppStoreSource implements ReviewSourceProvider {
  readonly name = "app_store" as const;
  readonly defaultKinds: readonly ReviewKind[] = kindsDefaultingTo("app_store");
  private readonly fetchImpl: FetchImpl;
  private readonly baseUrl: string;

  constructor(opts: AppStoreOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** Keyless: always available. */
  isConfigured(): boolean {
    return true;
  }

  async search(q: NormalizedReviewsQuery, signal: AbortSignal, hooks?: ReviewHooks): Promise<ReviewSearchResult> {
    const { app, country } = await this.resolveApp(q, signal, hooks);
    const id = String(app.trackId);
    const reviewsUrl = `https://apps.apple.com/${country}/app/id${id}?see-all=reviews`;

    const reviews: Review[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= APP_STORE_MAX_PAGES && reviews.length < q.per_source; page++) {
      const entries = await this.feedPage(id, country, page, signal);
      if (entries.length === 0) break;
      for (const entry of entries) {
        const review = mapEntry(entry, reviewsUrl);
        if (review === undefined || seen.has(review.id)) continue;
        seen.add(review.id);
        reviews.push(review);
        if (reviews.length >= q.per_source) break;
      }
    }

    const subject: ReviewSubject = {
      source: this.name,
      name: app.trackName,
      ...(app.trackViewUrl !== undefined && URL.canParse(app.trackViewUrl) && { url: app.trackViewUrl }),
      ...(app.averageUserRating !== undefined &&
        Number.isFinite(app.averageUserRating) && { rating_avg: Math.min(5, Math.max(0, Math.round(app.averageUserRating * 100) / 100)) }),
      ...(app.userRatingCount !== undefined && Number.isInteger(app.userRatingCount) && app.userRatingCount >= 0 && { review_count: app.userRatingCount }),
      ...(app.genres !== undefined && app.genres.length > 0 && { categories: app.genres.filter((g) => g.trim() !== "") }),
    };
    return { subject, reviews };
  }

  /** The app the subject names: by id from an App Store URL, else the first search hit. */
  private async resolveApp(q: NormalizedReviewsQuery, signal: AbortSignal, hooks?: ReviewHooks): Promise<{ app: AppMatch; country: string }> {
    const fromUrl = q.subject_url !== undefined ? parseAppStoreUrl(q.subject_url) : undefined;
    if (q.subject_url !== undefined && fromUrl === undefined) {
      throw new ReviewSourceError("app_store: the subject URL is not an App Store app page (apps.apple.com/.../id<digits>)", {
        source: this.name,
        code: "not_found",
        retryable: false,
      });
    }
    const country = fromUrl?.country ?? q.app_store_country;
    if (fromUrl !== undefined) {
      const params = new URLSearchParams({ id: fromUrl.id, country });
      const found = await this.appList(`${this.baseUrl}/lookup?${params.toString()}`, signal);
      const app = found[0];
      if (app !== undefined) return { app, country };
      hooks?.caveats?.push(`app_store: the lookup for app id ${fromUrl.id} returned no metadata; the subject carries the id only.`);
      return { app: { trackId: Number(fromUrl.id), trackName: `App Store app id ${fromUrl.id}` }, country };
    }
    const params = new URLSearchParams({ term: q.subject, entity: "software", country, limit: String(SEARCH_LIMIT) });
    const found = await this.appList(`${this.baseUrl}/search?${params.toString()}`, signal);
    const app = found[0];
    if (app === undefined) {
      throw new ReviewSourceError(`app_store: no app matches "${q.subject}" in the ${country} storefront`, {
        source: this.name,
        code: "not_found",
        retryable: false,
      });
    }
    if (found.length > 1) {
      const others = found.slice(1, 4).map((a) => a.trackName);
      hooks?.caveats?.push(`app_store matched "${q.subject}" to "${app.trackName}" (also found: ${others.join(", ")}).`);
    }
    return { app, country };
  }

  private async appList(url: string, signal: AbortSignal): Promise<AppMatch[]> {
    const body = await requestJson({ source: this.name, url, fetchImpl: this.fetchImpl, signal });
    const parsed = SearchResponse.safeParse(body);
    if (!parsed.success) {
      throw new ReviewSourceError(`app_store returned an unexpected search response (${describeIssues(parsed.error.issues)})`, {
        source: this.name,
        code: "provider",
        retryable: false,
        cause: parsed.error,
      });
    }
    return parsed.data.results;
  }

  private async feedPage(id: string, country: string, page: number, signal: AbortSignal): Promise<FeedEntry[]> {
    const url = `${this.baseUrl}/${country}/rss/customerreviews/id=${id}/sortBy=mostRecent/page=${page}/json`;
    const body = await requestJson(
      { source: this.name, url, fetchImpl: this.fetchImpl, signal },
      { notFoundMessage: `app_store has no review feed for app id ${id} in the ${country} storefront` },
    );
    const parsed = FeedResponse.safeParse(body);
    if (!parsed.success) {
      throw new ReviewSourceError(`app_store returned an unexpected feed shape (${describeIssues(parsed.error.issues)})`, {
        source: this.name,
        code: "provider",
        retryable: false,
        cause: parsed.error,
      });
    }
    const entry = parsed.data.feed.entry;
    if (entry === undefined) return [];
    return Array.isArray(entry) ? entry : [entry];
  }
}

/** One feed entry to a Review; undefined for the app's own entry (no rating) or an entry without an id. */
export function mapEntry(entry: FeedEntry, reviewsUrl: string): Review | undefined {
  const ratingRaw = entry["im:rating"]?.label;
  const nativeId = entry.id?.label.trim();
  if (ratingRaw === undefined || nativeId === undefined || nativeId === "") return undefined;
  const rating = normalizeRating(Number(ratingRaw), 5);
  const { text, truncated } = truncateReviewText(entry.content?.label ?? "");
  const title = entry.title?.label.trim();
  const author = entry.author?.name?.label.trim();
  const version = entry["im:version"]?.label.trim();
  const createdAt = toIsoUtc(entry.updated?.label);
  const votes = entry["im:voteSum"] !== undefined ? Number(entry["im:voteSum"].label) : NaN;
  return {
    id: reviewId("app_store", nativeId, `${author ?? ""}\n${text}`),
    source: "app_store",
    url: reviewsUrl,
    ...(author !== undefined && author !== "" && { author }),
    ...(rating !== undefined && { rating }),
    ...(title !== undefined && title !== "" && { title }),
    text,
    truncated,
    ...(createdAt !== undefined && { created_at: createdAt }),
    ...(Number.isInteger(votes) && votes > 0 && { helpful_votes: votes }),
    ...(version !== undefined && version !== "" && { version }),
  };
}
