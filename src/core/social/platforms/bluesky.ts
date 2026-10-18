import { z } from "zod";
import type { SocialItem, SocialSearchQuery } from "../../../schemas/social.js";
import {
  allocate,
  fetchJson,
  interleave,
  parseBody,
  perThread,
  sinceIso,
  stripTrailingSlash,
  toCount,
  toIso,
  toNumber,
} from "../http.js";
import { clipText, safeAuthor } from "../merge.js";
import { SocialProviderError, type SocialHooks, type SocialPlatformProvider } from "../types.js";

/**
 * Bluesky through the public AppView API (keyless), PLAN.md 14.5.
 * Docs: https://docs.bsky.app/docs/api/app-bsky-feed-search-posts
 *       https://docs.bsky.app/docs/api/app-bsky-feed-get-post-thread
 *       https://docs.bsky.app/docs/api/com-atproto-identity-resolve-handle
 *
 * - search: `app.bsky.feed.searchPosts?q=&limit=&sort=top|latest&since=&lang=`;
 *   comments are the replies of the top 3 posts via `getPostThread` depth 1.
 * - thread: a `bsky.app/profile/<handle>/post/<rkey>` URL; the handle is
 *   resolved to a DID with `com.atproto.identity.resolveHandle`, then
 *   `getPostThread` on `at://<did>/app.bsky.feed.post/<rkey>`.
 *
 * The fixtures under test/fixtures/social are built from the documented
 * shapes: the public API answered 403 from the development environment.
 */

const DEFAULT_BASE_URL = "https://public.api.bsky.app";
const WEB_URL = "https://bsky.app";
const MAX_LIMIT = 100;
/** Posts whose replies are fetched for `kind: "comments"`. */
const COMMENT_SOURCE_POSTS = 3;

const Author = z.object({
  did: z.string(),
  handle: z.string(),
  displayName: z.string().nullish(),
});

const Record = z.object({
  text: z.string().nullish(),
  createdAt: z.string().nullish(),
  langs: z.array(z.string()).nullish(),
});

const PostView = z.object({
  uri: z.string(),
  cid: z.string().optional(),
  author: Author,
  record: Record.loose(),
  replyCount: z.number().nullish(),
  repostCount: z.number().nullish(),
  likeCount: z.number().nullish(),
  indexedAt: z.string().nullish(),
});
type PostView = z.infer<typeof PostView>;

const SearchResponse = z.object({ posts: z.array(PostView), cursor: z.string().optional() });

/** A thread node. Not-found and blocked nodes have no `post`; they are skipped. */
const ThreadNode = z.object({
  $type: z.string().optional(),
  post: PostView.optional(),
  replies: z.array(z.object({ $type: z.string().optional(), post: PostView.optional() }).loose()).optional(),
});
const ThreadResponse = z.object({ thread: ThreadNode.loose() });

const ResolveHandleResponse = z.object({ did: z.string() });

export interface BlueskyProviderOptions {
  fetchImpl?: typeof fetch;
  /** API origin, without a trailing path. Overridable for tests. */
  baseUrl?: string;
  /** Clock in epoch milliseconds, for recency windows. Default Date.now. */
  now?: () => number;
}

const OWNS = /^(?:www\.)?bsky\.app$/i;
const AT_URI = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/;

/** `{ handle, rkey }` from a `bsky.app/profile/<handle>/post/<rkey>` URL, or undefined. `handle` may be a DID. */
export function blueskyPostRef(url: string): { handle: string; rkey: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!OWNS.test(u.hostname)) return undefined;
  const m = /^\/profile\/([^/]+)\/post\/([^/]+)\/?$/.exec(u.pathname);
  if (m === null) return undefined;
  return { handle: decodeURIComponent(m[1] as string), rkey: decodeURIComponent(m[2] as string) };
}

/** `https://bsky.app/profile/<handle>/post/<rkey>` for a post view; undefined for a malformed uri. */
export function blueskyWebUrl(post: PostView): string | undefined {
  const m = AT_URI.exec(post.uri);
  if (m === null) return undefined;
  return `${WEB_URL}/profile/${encodeURIComponent(post.author.handle)}/post/${encodeURIComponent(m[2] as string)}`;
}

export class BlueskyProvider implements SocialPlatformProvider {
  readonly name = "bluesky" as const;
  readonly access = "api" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: BlueskyProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.now = opts.now ?? Date.now;
  }

  isConfigured(): boolean {
    return true;
  }

  ownsUrl(url: string): boolean {
    return blueskyPostRef(url) !== undefined;
  }

  async search(q: SocialSearchQuery, signal: AbortSignal, _hooks?: SocialHooks): Promise<SocialItem[]> {
    if (q.query === undefined) {
      throw new SocialProviderError("bluesky search needs a query", { platform: this.name, code: "invalid_input", retryable: false });
    }
    const budget = allocate(q.kind, q.per_platform);
    // Comments come from the top posts, so a comments-only search still needs a few posts.
    const wanted = Math.max(budget.posts, budget.comments > 0 ? COMMENT_SOURCE_POSTS : 0);
    const found = await this.searchPosts(q, wanted, signal);
    const posts = found.slice(0, budget.posts).flatMap((p) => {
      const item = this.postItem(p, undefined);
      return item === undefined ? [] : [item];
    });
    if (budget.comments === 0) return posts;

    const sources = found.slice(0, COMMENT_SOURCE_POSTS);
    const each = perThread(budget.comments, sources.length);
    const replyLists = await Promise.all(sources.map((p) => this.replies(p.uri, each, signal)));
    const comments = interleave(replyLists, budget.comments);
    return [...posts, ...comments].slice(0, q.per_platform);
  }

  async thread(url: string, q: SocialSearchQuery, signal: AbortSignal, _hooks?: SocialHooks): Promise<SocialItem[]> {
    const ref = blueskyPostRef(url);
    if (ref === undefined) {
      throw new SocialProviderError(`not a Bluesky post URL: ${url}`, { platform: this.name, code: "invalid_input", retryable: false });
    }
    const did = ref.handle.startsWith("did:") ? ref.handle : await this.resolveHandle(ref.handle, signal);
    const uri = `at://${did}/app.bsky.feed.post/${ref.rkey}`;
    const thread = await this.getThread(uri, signal);
    if (thread.post === undefined) {
      throw new SocialProviderError(`Bluesky post not found or not viewable: ${url}`, {
        platform: this.name,
        code: "provider",
        retryable: false,
      });
    }
    const post = this.postItem(thread.post, undefined);
    if (post === undefined) {
      throw new SocialProviderError("Bluesky returned a post with a malformed uri", { platform: this.name, code: "provider", retryable: false });
    }
    const comments = this.replyItems(thread, post.url).slice(0, q.per_platform);
    return [post, ...comments];
  }

  private async xrpc(method: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    return fetchJson({
      platform: this.name,
      url: `${this.baseUrl}/xrpc/${method}?${params.toString()}`,
      init: { method: "GET", headers: { Accept: "application/json" } },
      fetchImpl: this.fetchImpl,
      signal,
      label: "Bluesky",
    });
  }

  private async searchPosts(q: SocialSearchQuery, limit: number, signal: AbortSignal): Promise<PostView[]> {
    const params = new URLSearchParams({
      q: q.query ?? "",
      limit: String(Math.min(MAX_LIMIT, Math.max(1, limit))),
      sort: q.sort === "recent" ? "latest" : "top",
    });
    const since = sinceIso(q.recency, this.now());
    if (since !== undefined) params.set("since", since);
    if (q.lang !== undefined) params.set("lang", q.lang);
    const body = await this.xrpc("app.bsky.feed.searchPosts", params, signal);
    return parseBody(this.name, SearchResponse, body, "Bluesky").posts;
  }

  private async getThread(uri: string, signal: AbortSignal): Promise<z.infer<typeof ThreadNode>> {
    const body = await this.xrpc("app.bsky.feed.getPostThread", new URLSearchParams({ uri, depth: "1" }), signal);
    return parseBody(this.name, ThreadResponse, body, "Bluesky").thread;
  }

  private async resolveHandle(handle: string, signal: AbortSignal): Promise<string> {
    const body = await this.xrpc("com.atproto.identity.resolveHandle", new URLSearchParams({ handle }), signal);
    return parseBody(this.name, ResolveHandleResponse, body, "Bluesky").did;
  }

  /** Replies of one post, as comments pointing at it. */
  private async replies(uri: string, limit: number, signal: AbortSignal): Promise<SocialItem[]> {
    const thread = await this.getThread(uri, signal);
    const parent = thread.post !== undefined ? blueskyWebUrl(thread.post) : undefined;
    return this.replyItems(thread, parent).slice(0, limit);
  }

  private replyItems(thread: z.infer<typeof ThreadNode>, parentUrl: string | undefined): SocialItem[] {
    return (thread.replies ?? []).flatMap((r) => {
      if (r.post === undefined) return [];
      const item = this.postItem(r.post, parentUrl);
      return item === undefined ? [] : [item];
    });
  }

  /** A post view as an item: a `post` when it has no parent, otherwise a `comment` on `parentUrl`. */
  private postItem(p: PostView, parentUrl: string | undefined): SocialItem | undefined {
    const url = blueskyWebUrl(p);
    if (url === undefined) return undefined;
    const rkey = (AT_URI.exec(p.uri) as RegExpExecArray)[2] as string;
    const text = clipText(p.record.text ?? "");
    const author = safeAuthor(p.author.handle) ?? safeAuthor(p.author.displayName);
    const createdAt = toIso(p.record.createdAt ?? p.indexedAt);
    const score = toNumber(p.likeCount);
    const replies = toCount(p.replyCount);
    const reposts = toCount(p.repostCount);
    const lang = p.record.langs?.[0]?.trim().toLowerCase().split("-")[0];
    return {
      id: `bluesky:${p.author.did}/${rkey}`,
      platform: this.name,
      kind: parentUrl === undefined ? "post" : "comment",
      url,
      ...(author !== undefined && { author }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(replies !== undefined && { replies }),
      ...(reposts !== undefined && { reposts }),
      ...(parentUrl !== undefined && { parent_url: parentUrl }),
      ...(lang !== undefined && lang !== "" && { lang }),
    };
  }
}
