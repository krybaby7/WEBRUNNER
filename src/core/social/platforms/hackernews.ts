import { z } from "zod";
import type { SocialItem, SocialSearchQuery } from "../../../schemas/social.js";
import {
  allocate,
  fetchJson,
  htmlToText,
  parseBody,
  sinceEpochSeconds,
  stripTrailingSlash,
  toCount,
  toIso,
  toNumber,
} from "../http.js";
import { clipText, safeAuthor } from "../merge.js";
import { SocialProviderError, type SocialHooks, type SocialPlatformProvider } from "../types.js";

/**
 * Hacker News through the Algolia search API (keyless), PLAN.md 14.5.
 * Docs: https://hn.algolia.com/api
 *
 * - search: `/api/v1/search` (relevance, then points) for `sort: "engagement"`,
 *   `/api/v1/search_by_date` for `sort: "recent"`; `tags=story` for posts,
 *   `tags=comment` for comments; `numericFilters=created_at_i>N` for recency.
 * - thread: `/api/v1/items/<id>` returns the story with nested `children`;
 *   the top-level children (depth 1) are the comments.
 *
 * Bodies (`story_text`, `comment_text`, `text`) are HTML and are flattened to
 * plain text. The fixture under test/fixtures/social was recorded live.
 */

const DEFAULT_BASE_URL = "https://hn.algolia.com";
const ITEM_URL = "https://news.ycombinator.com/item?id=";
/** Algolia caps `hitsPerPage` at 1000; the tool never asks for more than 50. */
const MAX_HITS = 100;

const Hit = z.object({
  objectID: z.string(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  author: z.string().nullish(),
  points: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_at: z.string().nullish(),
  created_at_i: z.number().nullish(),
  story_text: z.string().nullish(),
  comment_text: z.string().nullish(),
  story_id: z.number().nullish(),
  story_title: z.string().nullish(),
  _tags: z.array(z.string()).optional(),
});
type Hit = z.infer<typeof Hit>;

const SearchResponse = z.object({ hits: z.array(Hit) });

interface ItemNode {
  id: number;
  type?: string | null;
  author?: string | null;
  title?: string | null;
  url?: string | null;
  text?: string | null;
  points?: number | null;
  created_at?: string | null;
  created_at_i?: number | null;
  children?: ItemNode[];
}
const Item: z.ZodType<ItemNode> = z.lazy(() =>
  z.object({
    id: z.number(),
    type: z.string().nullish(),
    author: z.string().nullish(),
    title: z.string().nullish(),
    url: z.string().nullish(),
    text: z.string().nullish(),
    points: z.number().nullish(),
    created_at: z.string().nullish(),
    created_at_i: z.number().nullish(),
    children: z.array(Item).optional(),
  }),
);

export interface HackerNewsProviderOptions {
  fetchImpl?: typeof fetch;
  /** API origin, without a trailing path. Overridable for tests. */
  baseUrl?: string;
  /** Clock in epoch milliseconds, for recency windows. Default Date.now. */
  now?: () => number;
}

const OWNS = /^(?:www\.)?news\.ycombinator\.com$/i;

/** The item id in a `news.ycombinator.com/item?id=<id>` URL, or undefined. */
export function hackerNewsItemId(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!OWNS.test(u.hostname) || u.pathname !== "/item") return undefined;
  const id = u.searchParams.get("id");
  return id !== null && /^\d+$/.test(id) ? id : undefined;
}

function sectionOf(tags: string[] | undefined): string | undefined {
  if (tags === undefined) return undefined;
  if (tags.includes("ask_hn")) return "Ask HN";
  if (tags.includes("show_hn")) return "Show HN";
  if (tags.includes("launch_hn")) return "Launch HN";
  return undefined;
}

export class HackerNewsProvider implements SocialPlatformProvider {
  readonly name = "hackernews" as const;
  readonly access = "api" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: HackerNewsProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.now = opts.now ?? Date.now;
  }

  isConfigured(): boolean {
    return true;
  }

  ownsUrl(url: string): boolean {
    return hackerNewsItemId(url) !== undefined;
  }

  async search(q: SocialSearchQuery, signal: AbortSignal, _hooks?: SocialHooks): Promise<SocialItem[]> {
    if (q.query === undefined) {
      throw new SocialProviderError("hackernews search needs a query", { platform: this.name, code: "invalid_input", retryable: false });
    }
    const budget = allocate(q.kind, q.per_platform);
    const [stories, comments] = await Promise.all([
      budget.posts > 0 ? this.hits(q, "story", budget.posts, signal) : Promise.resolve([]),
      budget.comments > 0 ? this.hits(q, "comment", budget.comments, signal) : Promise.resolve([]),
    ]);
    const posts = stories.map((h) => this.storyItem(h));
    const replies = comments.flatMap((h) => {
      const item = this.commentHit(h);
      return item === undefined ? [] : [item];
    });
    return [...posts, ...replies].slice(0, q.per_platform);
  }

  async thread(url: string, q: SocialSearchQuery, signal: AbortSignal, _hooks?: SocialHooks): Promise<SocialItem[]> {
    const id = hackerNewsItemId(url);
    if (id === undefined) {
      throw new SocialProviderError(`not a Hacker News item URL: ${url}`, { platform: this.name, code: "invalid_input", retryable: false });
    }
    const body = await fetchJson({
      platform: this.name,
      url: `${this.baseUrl}/api/v1/items/${id}`,
      init: { method: "GET", headers: { Accept: "application/json" } },
      fetchImpl: this.fetchImpl,
      signal,
      label: "Hacker News",
    });
    const root = parseBody(this.name, Item, body, "Hacker News");
    const postUrl = `${ITEM_URL}${root.id}`;
    const post = this.nodeItem(root, "post", postUrl, undefined);
    const comments = (root.children ?? [])
      .filter((c) => typeof c.text === "string" && c.text.trim() !== "" && c.author !== null && c.author !== undefined)
      .slice(0, q.per_platform)
      .map((c) => this.nodeItem(c, "comment", `${ITEM_URL}${c.id}`, postUrl));
    return [post, ...comments];
  }

  private async hits(q: SocialSearchQuery, tag: "story" | "comment", count: number, signal: AbortSignal): Promise<Hit[]> {
    const params = new URLSearchParams({
      query: q.query ?? "",
      tags: tag,
      hitsPerPage: String(Math.min(MAX_HITS, Math.max(1, count))),
    });
    const since = sinceEpochSeconds(q.recency, this.now());
    if (since !== undefined) params.set("numericFilters", `created_at_i>${since}`);
    const path = q.sort === "recent" ? "/api/v1/search_by_date" : "/api/v1/search";
    const body = await fetchJson({
      platform: this.name,
      url: `${this.baseUrl}${path}?${params.toString()}`,
      init: { method: "GET", headers: { Accept: "application/json" } },
      fetchImpl: this.fetchImpl,
      signal,
      label: "Hacker News",
    });
    return parseBody(this.name, SearchResponse, body, "Hacker News").hits.slice(0, count);
  }

  private storyItem(h: Hit): SocialItem {
    const text = clipText(htmlToText(h.story_text) || (h.url ?? ""));
    const author = safeAuthor(h.author);
    const title = h.title?.trim();
    const createdAt = toIso(h.created_at ?? h.created_at_i);
    const score = toNumber(h.points);
    const replies = toCount(h.num_comments);
    const community = sectionOf(h._tags);
    return {
      id: `hackernews:${h.objectID}`,
      platform: this.name,
      kind: "post",
      url: `${ITEM_URL}${h.objectID}`,
      ...(author !== undefined && { author }),
      ...(title !== undefined && title !== "" && { title }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(replies !== undefined && { replies }),
      ...(community !== undefined && { community }),
    };
  }

  private commentHit(h: Hit): SocialItem | undefined {
    const plain = htmlToText(h.comment_text);
    if (plain === "") return undefined;
    const text = clipText(plain);
    const author = safeAuthor(h.author);
    const createdAt = toIso(h.created_at ?? h.created_at_i);
    const score = toNumber(h.points);
    return {
      id: `hackernews:${h.objectID}`,
      platform: this.name,
      kind: "comment",
      url: `${ITEM_URL}${h.objectID}`,
      ...(author !== undefined && { author }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(h.story_id !== null && h.story_id !== undefined && { parent_url: `${ITEM_URL}${h.story_id}` }),
    };
  }

  private nodeItem(n: ItemNode, kind: "post" | "comment", url: string, parentUrl: string | undefined): SocialItem {
    const plain = htmlToText(n.text);
    const text = clipText(kind === "post" ? plain || (n.url ?? "") : plain);
    const author = safeAuthor(n.author);
    const title = n.title?.trim();
    const createdAt = toIso(n.created_at ?? n.created_at_i);
    const score = toNumber(n.points);
    const replies = kind === "post" ? toCount(n.children?.length) : undefined;
    return {
      id: `hackernews:${n.id}`,
      platform: this.name,
      kind,
      url,
      ...(author !== undefined && { author }),
      ...(kind === "post" && title !== undefined && title !== "" && { title }),
      text: text.text,
      truncated: text.truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(score !== undefined && { score }),
      ...(replies !== undefined && { replies }),
      ...(parentUrl !== undefined && { parent_url: parentUrl }),
    };
  }
}

