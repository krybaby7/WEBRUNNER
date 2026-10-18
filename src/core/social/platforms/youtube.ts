import { z } from "zod";
import type { SocialItem, SocialSearchQuery } from "../../../schemas/social.js";
import {
  allocate,
  fetchJson,
  hasKey,
  interleave,
  looseCount,
  parseBody,
  perThread,
  sinceIso,
  SocialHttpError,
  stripTrailingSlash,
  toCount,
  toIso,
  toNumber,
} from "../http.js";
import { clipText, safeAuthor } from "../merge.js";
import { SocialProviderError, type SocialHooks, type SocialPlatformProvider } from "../types.js";

/**
 * YouTube through the Data API v3 (needs YOUTUBE_API_KEY), PLAN.md 14.5.
 * Docs: https://developers.google.com/youtube/v3/docs/search/list
 *       https://developers.google.com/youtube/v3/docs/videos/list
 *       https://developers.google.com/youtube/v3/docs/commentThreads/list
 *
 * - posts are videos: `search?part=snippet&type=video&q=&order=relevance|date
 *   &publishedAfter=&maxResults=`, then one `videos?part=statistics&id=a,b,c`
 *   call for like and comment counts.
 * - comments: `commentThreads?part=snippet&videoId=&order=relevance
 *   &maxResults=&textFormat=plainText` for the top 3 videos.
 * - thread: a `youtube.com/watch?v=` or `youtu.be/` URL; the video plus its
 *   comment threads.
 *
 * Quota: a search costs 100 units of the default 10,000 daily units; the
 * other calls cost 1 each. A 403 with reason `quotaExceeded` is a
 * non-retryable `provider` error naming the quota. A video with comments
 * disabled is skipped with a caveat. Fixtures are built from the docs: the
 * API needs a key the development environment does not have.
 */

const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3";
const WATCH_URL = "https://www.youtube.com/watch?v=";
const MAX_SEARCH_RESULTS = 50;
const MAX_COMMENT_RESULTS = 100;
/** Videos whose comments are fetched for `kind: "comments"`. */
const COMMENT_SOURCE_VIDEOS = 3;
export const YOUTUBE_QUOTA_CAVEAT =
  "YouTube: each search costs 100 units of the Data API's 10,000-unit daily quota (comment and statistics calls cost 1 each).";

const Snippet = z.object({
  publishedAt: z.string().nullish(),
  channelId: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  channelTitle: z.string().nullish(),
});

const SearchResponse = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }).loose(), snippet: Snippet.loose() })),
});

const Statistics = z.object({ viewCount: looseCount, likeCount: looseCount, commentCount: looseCount });

const VideosResponse = z.object({
  items: z.array(z.object({ id: z.string(), snippet: Snippet.loose().optional(), statistics: Statistics.loose().optional() })),
});

const CommentThreadsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        videoId: z.string().nullish(),
        totalReplyCount: looseCount,
        topLevelComment: z.object({
          id: z.string(),
          snippet: z.object({
            textOriginal: z.string().nullish(),
            textDisplay: z.string().nullish(),
            authorDisplayName: z.string().nullish(),
            likeCount: looseCount,
            publishedAt: z.string().nullish(),
          }),
        }),
      }),
    }),
  ),
});

interface Video {
  id: string;
  snippet: z.infer<typeof Snippet>;
  statistics?: z.infer<typeof Statistics> | undefined;
}

export interface YouTubeProviderOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** API origin and version path, without a trailing slash. Overridable for tests. */
  baseUrl?: string;
  /** Clock in epoch milliseconds, for recency windows. Default Date.now. */
  now?: () => number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,}$/;

/** The video id in a youtube.com/watch?v=, youtube.com/shorts/, youtube.com/live/ or youtu.be/ URL. */
export function youTubeVideoId(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
  let id: string | null | undefined;
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (host === "youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = /^\/(?:shorts|live|embed)\/([^/]+)/.exec(u.pathname);
      id = m?.[1];
    }
  }
  return id !== null && id !== undefined && VIDEO_ID.test(id) ? id : undefined;
}

export class YouTubeProvider implements SocialPlatformProvider {
  readonly name = "youtube" as const;
  readonly access = "api" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: YouTubeProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.now = opts.now ?? Date.now;
  }

  isConfigured(): boolean {
    return hasKey(this.apiKey);
  }

  ownsUrl(url: string): boolean {
    return youTubeVideoId(url) !== undefined;
  }

  async search(q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]> {
    const key = this.requireKey();
    if (q.query === undefined) {
      throw new SocialProviderError("youtube search needs a query", { platform: this.name, code: "invalid_input", retryable: false });
    }
    const budget = allocate(q.kind, q.per_platform);
    const wanted = Math.max(budget.posts, budget.comments > 0 ? COMMENT_SOURCE_VIDEOS : 0);

    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      q: q.query,
      order: q.sort === "recent" ? "date" : "relevance",
      maxResults: String(Math.min(MAX_SEARCH_RESULTS, Math.max(1, wanted))),
      key,
    });
    const since = sinceIso(q.recency, this.now());
    if (since !== undefined) params.set("publishedAfter", since);
    const found = parseBody(this.name, SearchResponse, await this.get("search", params, signal), "YouTube").items;
    hooks?.caveats?.push(YOUTUBE_QUOTA_CAVEAT);

    const ids = found.map((i) => i.id.videoId).filter((id): id is string => id !== undefined);
    const stats = ids.length > 0 ? await this.statistics(ids, signal) : new Map<string, z.infer<typeof Statistics>>();
    const videos: Video[] = found.flatMap((i) => {
      const id = i.id.videoId;
      return id === undefined ? [] : [{ id, snippet: i.snippet, statistics: stats.get(id) }];
    });

    const posts = videos.slice(0, budget.posts).map((v) => this.videoItem(v));
    if (budget.comments === 0) return posts;

    const sources = videos.slice(0, COMMENT_SOURCE_VIDEOS);
    const each = perThread(budget.comments, sources.length);
    const lists = await Promise.all(sources.map((v) => this.comments(v.id, each, signal, hooks)));
    return [...posts, ...interleave(lists, budget.comments)].slice(0, q.per_platform);
  }

  async thread(url: string, q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]> {
    this.requireKey();
    const id = youTubeVideoId(url);
    if (id === undefined) {
      throw new SocialProviderError(`not a YouTube video URL: ${url}`, { platform: this.name, code: "invalid_input", retryable: false });
    }
    const body = await this.get("videos", new URLSearchParams({ part: "snippet,statistics", id, key: this.apiKey as string }), signal);
    const video = parseBody(this.name, VideosResponse, body, "YouTube").items[0];
    if (video === undefined || video.snippet === undefined) {
      throw new SocialProviderError(`YouTube video not found: ${id}`, { platform: this.name, code: "provider", retryable: false });
    }
    const post = this.videoItem({ id: video.id, snippet: video.snippet, statistics: video.statistics });
    const comments = await this.comments(video.id, q.per_platform, signal, hooks);
    return [post, ...comments];
  }

  private requireKey(): string {
    if (!hasKey(this.apiKey)) {
      throw new SocialProviderError("youtube is not configured: set YOUTUBE_API_KEY", {
        platform: this.name,
        code: "config",
        retryable: false,
      });
    }
    return this.apiKey as string;
  }

  private async get(resource: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    try {
      return await fetchJson({
        platform: this.name,
        url: `${this.baseUrl}/${resource}?${params.toString()}`,
        init: { method: "GET", headers: { Accept: "application/json" } },
        fetchImpl: this.fetchImpl,
        signal,
        secrets: [this.apiKey],
        label: "YouTube",
      });
    } catch (err) {
      if (err instanceof SocialHttpError && err.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(err.bodyPreview)) {
        throw new SocialProviderError(
          "YouTube Data API daily quota exceeded (10,000 units per day by default; each search costs 100). It resets at midnight Pacific time.",
          { platform: this.name, code: "provider", retryable: false, status: 403, cause: err },
        );
      }
      throw err;
    }
  }

  private async statistics(ids: string[], signal: AbortSignal): Promise<Map<string, z.infer<typeof Statistics>>> {
    const params = new URLSearchParams({ part: "statistics", id: ids.join(","), key: this.apiKey as string });
    const body = await this.get("videos", params, signal);
    const out = new Map<string, z.infer<typeof Statistics>>();
    for (const v of parseBody(this.name, VideosResponse, body, "YouTube").items) {
      if (v.statistics !== undefined) out.set(v.id, v.statistics);
    }
    return out;
  }

  /** Top-level comments of one video. Disabled comments yield an empty list and a caveat. */
  private async comments(videoId: string, limit: number, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]> {
    const params = new URLSearchParams({
      part: "snippet",
      videoId,
      order: "relevance",
      maxResults: String(Math.min(MAX_COMMENT_RESULTS, Math.max(1, limit))),
      textFormat: "plainText",
      key: this.apiKey as string,
    });
    let body: unknown;
    try {
      body = await this.get("commentThreads", params, signal);
    } catch (err) {
      if (err instanceof SocialHttpError && err.status === 403 && /commentsDisabled/.test(err.bodyPreview)) {
        hooks?.caveats?.push(`YouTube: comments are disabled on ${WATCH_URL}${videoId}.`);
        return [];
      }
      throw err;
    }
    const parentUrl = `${WATCH_URL}${videoId}`;
    return parseBody(this.name, CommentThreadsResponse, body, "YouTube")
      .items.slice(0, limit)
      .flatMap((t) => {
        const c = t.snippet.topLevelComment;
        const raw = c.snippet.textOriginal ?? c.snippet.textDisplay ?? "";
        if (raw.trim() === "") return [];
        const text = clipText(raw);
        const author = safeAuthor(c.snippet.authorDisplayName);
        const createdAt = toIso(c.snippet.publishedAt);
        const score = toNumber(c.snippet.likeCount);
        const replies = toCount(t.snippet.totalReplyCount);
        const item: SocialItem = {
          id: `youtube:${c.id}`,
          platform: this.name,
          kind: "comment",
          url: `${parentUrl}&lc=${encodeURIComponent(c.id)}`,
          ...(author !== undefined && { author }),
          text: text.text,
          truncated: text.truncated,
          ...(createdAt !== undefined && { created_at: createdAt }),
          ...(score !== undefined && { score }),
          ...(replies !== undefined && { replies }),
          parent_url: parentUrl,
        };
        return [item];
      });
  }

  private videoItem(v: Video): SocialItem {
    const text = clipText(v.snippet.description ?? "");
    const title = v.snippet.title?.trim();
    const channel = safeAuthor(v.snippet.channelTitle);
    const createdAt = toIso(v.snippet.publishedAt);
    const score = toNumber(v.statistics?.likeCount);
    const replies = toCount(v.statistics?.commentCount);
    return {
      id: `youtube:${v.id}`,
      platform: this.name,
      kind: "post",
      url: `${WATCH_URL}${v.id}`,
      ...(channel !== undefined && { author: channel }),
      ...(title !== undefined && title !== "" && { title }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(replies !== undefined && { replies }),
      ...(channel !== undefined && { community: channel }),
    };
  }
}
