import { z } from "zod";
import type { SocialItem, SocialSearchQuery } from "../../../schemas/social.js";
import {
  allocate,
  fetchJson,
  hasKey,
  interleave,
  parseBody,
  perThread,
  SocialHttpError,
  stripTrailingSlash,
  toCount,
  toIso,
  toNumber,
} from "../http.js";
import { clipText, safeAuthor } from "../merge.js";
import { SocialProviderError, type SocialHooks, type SocialPlatformProvider } from "../types.js";

/**
 * Reddit, PLAN.md 14.5, in three steps:
 *
 * 1. The Reddit API with app-only OAuth when `clientId` and `clientSecret` are
 *    set: `POST https://www.reddit.com/api/v1/access_token` (HTTP Basic,
 *    `grant_type=client_credentials`), token cached until 60 s before expiry,
 *    then `https://oauth.reddit.com/<path>`.
 * 2. Otherwise the public `.json` endpoints on `https://www.reddit.com` with a
 *    descriptive User-Agent (`reddit_user_agent`, default
 *    `webrunner/<version> personal MCP server`).
 * 3. A 403 or 429 from step 2 hands the request to `fallback` (the browser
 *    platform WP18b registers) when one is configured and ready. Without one,
 *    a 429 is a retryable `provider` error carrying `Retry-After`, and a 403 a
 *    `provider` error that suggests REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET
 *    or connecting a Reddit account.
 *
 * Search: `/search?q=&sort=relevance&t=&limit=&type=link&raw_json=1`, or
 * `/r/a+b/search?restrict_sr=1&...` for `subreddits`. Always `relevance`:
 * Reddit's `top` and `new` sorts list unrelated posts for most queries (seen
 * live on old.reddit, the same search, 2026-10-28, WP39); the tool's merge
 * orders the items by score or date. Comments are the
 * top-level comments (`/comments/<id>?limit=&depth=1&sort=top&raw_json=1`)
 * of the top matching posts, at most 5 by score, spread evenly over the
 * comment budget. Fixtures are built from the documented shapes: the
 * development environment got 403 from reddit.com and has no API keys.
 */

const DEFAULT_PUBLIC_BASE_URL = "https://www.reddit.com";
const DEFAULT_API_BASE_URL = "https://oauth.reddit.com";
const TOKEN_PATH = "/api/v1/access_token";
const MAX_LIMIT = 100;
/** Posts whose comments are fetched for `kind: "comments"`. */
const COMMENT_SOURCE_POSTS = 5;
/** A token is renewed this long before Reddit says it expires. */
const TOKEN_SAFETY_MS = 60_000;

const TIME_FILTER = { day: "day", week: "week", month: "month", year: "year" } as const;

const Post = z.object({
  id: z.string(),
  title: z.string().nullish(),
  selftext: z.string().nullish(),
  author: z.string().nullish(),
  score: z.number().nullish(),
  num_comments: z.number().nullish(),
  subreddit: z.string().nullish(),
  permalink: z.string().nullish(),
  url: z.string().nullish(),
  is_self: z.boolean().nullish(),
  created_utc: z.number().nullish(),
});
type Post = z.infer<typeof Post>;

const Comment = z.object({
  id: z.string(),
  body: z.string().nullish(),
  author: z.string().nullish(),
  score: z.number().nullish(),
  subreddit: z.string().nullish(),
  permalink: z.string().nullish(),
  created_utc: z.number().nullish(),
  link_id: z.string().nullish(),
});
type Comment = z.infer<typeof Comment>;

/** A listing of posts; children of other kinds (`more`, ads) are ignored. */
const PostListing = z.object({
  data: z.object({ children: z.array(z.object({ kind: z.string(), data: z.unknown() })) }),
});

/** `/comments/<id>` answers with two listings: the post, then its comments. */
const ThreadResponse = z.tuple([PostListing, PostListing]).rest(z.unknown());

const TokenResponse = z.object({ access_token: z.string(), expires_in: z.number().optional() });

export interface RedditProviderOptions {
  clientId?: string;
  clientSecret?: string;
  /** Replaces the default User-Agent. */
  userAgent?: string;
  /** Package version for the default User-Agent. */
  version: string;
  fetchImpl?: typeof fetch;
  /** The browser platform a 403 or 429 from the public endpoints hands over to (WP18b). */
  fallback?: SocialPlatformProvider;
  /** Clock in epoch milliseconds, for the token cache. Default Date.now. */
  now?: () => number;
  /** Origins, without trailing slashes. Overridable for tests. */
  publicBaseUrl?: string;
  apiBaseUrl?: string;
}

const REDDIT_HOST = /^(?:[a-z0-9-]+\.)?reddit\.com$/i;
const REDDIT_ID = /^[a-z0-9]{1,12}$/i;

/** The post id in a `reddit.com/r/<sub>/comments/<id>/...` or `redd.it/<id>` URL, or undefined. */
export function redditPostId(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (host === "redd.it" || host === "www.redd.it") {
    const id = u.pathname.split("/")[1];
    return id !== undefined && REDDIT_ID.test(id) ? id : undefined;
  }
  if (!REDDIT_HOST.test(host)) return undefined;
  const m = /^\/(?:r\/[^/]+|user\/[^/]+)\/comments\/([^/]+)/.exec(u.pathname);
  const id = m?.[1];
  return id !== undefined && REDDIT_ID.test(id) ? id : undefined;
}

function fullUrl(permalink: string | null | undefined, fallbackPath: string): string {
  const path = permalink !== null && permalink !== undefined && permalink.startsWith("/") ? permalink : fallbackPath;
  return `${DEFAULT_PUBLIC_BASE_URL}${path}`;
}

export class RedditProvider implements SocialPlatformProvider {
  readonly name = "reddit" as const;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: SocialPlatformProvider | undefined;
  private readonly now: () => number;
  private readonly publicBaseUrl: string;
  private readonly apiBaseUrl: string;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(opts: RedditProviderOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.userAgent = hasKey(opts.userAgent) ? (opts.userAgent as string) : `webrunner/${opts.version} personal MCP server`;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.fallback = opts.fallback;
    this.now = opts.now ?? Date.now;
    this.publicBaseUrl = stripTrailingSlash(opts.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL);
    this.apiBaseUrl = stripTrailingSlash(opts.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  }

  /**
   * "browser" when Reddit is read without API credentials and the browser can
   * stand in: the public endpoints answer 403 from most home IPs, and the
   * browser path (old.reddit, a reload, then www.reddit.com's search) needs the
   * browser's time budget, not the API's (WP43). "api" otherwise.
   */
  get access(): "api" | "browser" {
    return !this.usesApi && this.fallback !== undefined && this.fallback.isConfigured() ? "browser" : "api";
  }

  /** The public endpoints need no key, so Reddit is always offered. */
  isConfigured(): boolean {
    return true;
  }

  /** True when the API credentials are set (step 1 is in use). */
  get usesApi(): boolean {
    return hasKey(this.clientId) && hasKey(this.clientSecret);
  }

  ownsUrl(url: string): boolean {
    return redditPostId(url) !== undefined;
  }

  async search(q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]> {
    if (q.query === undefined) {
      throw new SocialProviderError("reddit search needs a query", { platform: this.name, code: "invalid_input", retryable: false });
    }
    try {
      return await this.searchDirect(q, signal);
    } catch (err) {
      if (this.shouldHandOver(err)) {
        hooks?.caveats?.push(this.handoverCaveat(err));
        return (this.fallback as SocialPlatformProvider).search(q, signal, hooks);
      }
      throw this.describe(err);
    }
  }

  async thread(url: string, q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks): Promise<SocialItem[]> {
    const id = redditPostId(url);
    if (id === undefined) {
      throw new SocialProviderError(`not a Reddit post URL: ${url}`, { platform: this.name, code: "invalid_input", retryable: false });
    }
    try {
      const { post, comments } = await this.fetchThread(id, q.per_platform, signal);
      return [this.postItem(post), ...comments];
    } catch (err) {
      if (this.shouldHandOver(err)) {
        hooks?.caveats?.push(this.handoverCaveat(err));
        return (this.fallback as SocialPlatformProvider).thread(url, q, signal, hooks);
      }
      throw this.describe(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Steps 1 and 2: the request layer
  // ---------------------------------------------------------------------------

  /** GET `path` (without `.json`) with `params`, through the API or the public endpoints. */
  private async get(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    params.set("raw_json", "1");
    if (this.usesApi) {
      const token = await this.accessToken(signal);
      return fetchJson({
        platform: this.name,
        url: `${this.apiBaseUrl}${path}?${params.toString()}`,
        init: {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": this.userAgent },
        },
        fetchImpl: this.fetchImpl,
        signal,
        secrets: [this.clientSecret, token],
        label: "Reddit API",
      });
    }
    return fetchJson({
      platform: this.name,
      url: `${this.publicBaseUrl}${path}.json?${params.toString()}`,
      init: { method: "GET", headers: { Accept: "application/json", "User-Agent": this.userAgent } },
      fetchImpl: this.fetchImpl,
      signal,
      label: "Reddit",
    });
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    const now = this.now();
    if (this.token !== undefined && this.token.expiresAt > now) return this.token.value;
    const basic = Buffer.from(`${this.clientId as string}:${this.clientSecret as string}`, "utf8").toString("base64");
    const body = await fetchJson({
      platform: this.name,
      url: `${this.publicBaseUrl}${TOKEN_PATH}`,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.userAgent,
        },
        body: "grant_type=client_credentials",
      },
      fetchImpl: this.fetchImpl,
      signal,
      secrets: [this.clientSecret, basic],
      label: "Reddit API (token)",
    });
    const parsed = parseBody(this.name, TokenResponse, body, "Reddit API (token)");
    const ttlMs = (parsed.expires_in ?? 3600) * 1000;
    this.token = { value: parsed.access_token, expiresAt: this.now() + Math.max(0, ttlMs - TOKEN_SAFETY_MS) };
    return parsed.access_token;
  }

  // ---------------------------------------------------------------------------
  // Step 3: the handover
  // ---------------------------------------------------------------------------

  private shouldHandOver(err: unknown): boolean {
    return (
      !this.usesApi &&
      this.fallback !== undefined &&
      this.fallback.isConfigured() &&
      err instanceof SocialHttpError &&
      (err.status === 403 || err.status === 429)
    );
  }

  private handoverCaveat(err: unknown): string {
    const status = err instanceof SocialHttpError ? err.status : undefined;
    return `Reddit's public JSON endpoints answered HTTP ${status ?? "error"}; results come from the browser instead.`;
  }

  /** A 403 from the public endpoints gets a message that says how to fix it; everything else passes through. */
  private describe(err: unknown): unknown {
    if (!this.usesApi && err instanceof SocialHttpError && err.status === 403) {
      return new SocialProviderError(
        "Reddit's public JSON endpoints refused the request (HTTP 403). Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to use the Reddit API, or connect a Reddit account with the accounts tool to read Reddit through the browser.",
        { platform: this.name, code: "provider", retryable: false, status: 403, cause: err },
      );
    }
    return err;
  }

  // ---------------------------------------------------------------------------
  // Search and threads
  // ---------------------------------------------------------------------------

  private async searchDirect(q: SocialSearchQuery, signal: AbortSignal): Promise<SocialItem[]> {
    const budget = allocate(q.kind, q.per_platform);
    const wanted = Math.max(budget.posts, budget.comments > 0 ? COMMENT_SOURCE_POSTS : 0);
    const found = await this.searchPosts(q, wanted, signal);
    const posts = found.slice(0, budget.posts).map((p) => this.postItem(p));
    if (budget.comments === 0) return posts;

    const sources = [...found].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, COMMENT_SOURCE_POSTS);
    const each = perThread(budget.comments, sources.length);
    const lists = await Promise.all(sources.map((p) => this.fetchThread(p.id, each, signal).then((t) => t.comments)));
    return [...posts, ...interleave(lists, budget.comments)].slice(0, q.per_platform);
  }

  private async searchPosts(q: SocialSearchQuery, limit: number, signal: AbortSignal): Promise<Post[]> {
    const params = new URLSearchParams({
      q: q.query ?? "",
      sort: "relevance",
      t: q.recency !== undefined ? TIME_FILTER[q.recency] : "all",
      limit: String(Math.min(MAX_LIMIT, Math.max(1, limit))),
      type: "link",
    });
    let path = "/search";
    const subs = (q.subreddits ?? []).map((s) => s.trim().replace(/^\/?r\//i, "")).filter((s) => s !== "");
    if (subs.length > 0) {
      path = `/r/${subs.map(encodeURIComponent).join("+")}/search`;
      params.set("restrict_sr", "1");
    }
    const body = await this.get(path, params, signal);
    return parseBody(this.name, PostListing, body, "Reddit")
      .data.children.filter((c) => c.kind === "t3")
      .flatMap((c) => {
        const p = Post.safeParse(c.data);
        return p.success ? [p.data] : [];
      });
  }

  private async fetchThread(id: string, limit: number, signal: AbortSignal): Promise<{ post: Post; comments: SocialItem[] }> {
    const params = new URLSearchParams({ limit: String(Math.min(MAX_LIMIT, Math.max(1, limit))), depth: "1", sort: "top" });
    const body = await this.get(`/comments/${encodeURIComponent(id)}`, params, signal);
    const [postListing, commentListing] = parseBody(this.name, ThreadResponse, body, "Reddit");
    const first = postListing.data.children.find((c) => c.kind === "t3");
    const post = first !== undefined ? Post.safeParse(first.data) : undefined;
    if (post === undefined || !post.success) {
      throw new SocialProviderError(`Reddit post not found: ${id}`, { platform: this.name, code: "provider", retryable: false });
    }
    const postUrl = fullUrl(post.data.permalink, `/comments/${id}`);
    const comments = commentListing.data.children
      .filter((c) => c.kind === "t1")
      .flatMap((c) => {
        const parsed = Comment.safeParse(c.data);
        if (!parsed.success) return [];
        const item = this.commentItem(parsed.data, postUrl, post.data.subreddit);
        return item === undefined ? [] : [item];
      })
      .slice(0, limit);
    return { post: post.data, comments };
  }

  private postItem(p: Post): SocialItem {
    const self = p.selftext?.trim() ?? "";
    const text = clipText(self !== "" ? self : p.is_self === false && p.url ? p.url : "");
    const author = safeAuthor(p.author);
    const title = p.title?.trim();
    const createdAt = toIso(p.created_utc);
    const score = toNumber(p.score);
    const replies = toCount(p.num_comments);
    const community = p.subreddit?.trim();
    return {
      id: `reddit:${p.id}`,
      platform: this.name,
      kind: "post",
      url: fullUrl(p.permalink, `/comments/${p.id}`),
      ...(author !== undefined && { author }),
      ...(title !== undefined && title !== "" && { title }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(replies !== undefined && { replies }),
      ...(community !== undefined && community !== "" && { community }),
    };
  }

  private commentItem(c: Comment, parentUrl: string, subreddit: string | null | undefined): SocialItem | undefined {
    const raw = c.body?.trim() ?? "";
    if (raw === "" || raw === "[deleted]" || raw === "[removed]") return undefined;
    const text = clipText(raw);
    const author = safeAuthor(c.author);
    const createdAt = toIso(c.created_utc);
    const score = toNumber(c.score);
    const community = (c.subreddit ?? subreddit)?.trim();
    return {
      id: `reddit:${c.id}`,
      platform: this.name,
      kind: "comment",
      url: fullUrl(c.permalink, `${new URL(parentUrl).pathname.replace(/\/$/, "")}/${c.id}/`),
      ...(author !== undefined && { author }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(community !== undefined && community !== "" && { community }),
      parent_url: parentUrl,
    };
  }
}
