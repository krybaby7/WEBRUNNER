import type { Page } from "playwright";
import { z } from "zod";
import { SocialItemSchema, SocialSearchQuerySchema, type SocialItem, type SocialSearchQuery } from "../../../schemas/social.js";
import type { RecipeContext } from "./types.js";
import { RecipeError } from "./types.js";
import {
  type BasicProbe,
  caveatSink,
  classifyWall,
  clipText,
  compact,
  firstLine,
  navigateTo,
  parseCount,
  probeScript,
  rebase,
  resolveOptions,
  runProbe,
  safeAuthor,
  sleep,
  timeGuard,
  toIso,
  toRecipeError,
  validateItems,
  type SocialRecipe,
  type SocialRecipeOptions,
  type TimeGuard,
  type WallRules,
} from "./social-common.js";

/**
 * Reddit browser fallback on old.reddit.com, PLAN.md 14.5 (WP18b): step 3 of
 * the Reddit access chain, used when the API and the `.json` endpoints block.
 * Reads through the profile's session when there is one; works anonymously
 * from most home IPs. Automated reading of reddit.com is against Reddit's
 * terms (PLAN.md 14.0); personal low-volume use.
 *
 * URLs:
 *   search  https://old.reddit.com/search?q=<q>&sort=relevance&t=all|day|week|month|year&restrict_sr=on
 *           with `subreddits`: https://old.reddit.com/r/a+b/search?...&restrict_sr=on
 *           always sort=relevance (the tool's merge orders by score or date); recency -> t.
 *   thread  any reddit.com/r/<sub>/comments/<id>[/slug] (or redd.it/<id>) URL with
 *           the host rewritten to old.reddit.com, plus ?limit=<n>&depth=1&sort=top.
 *   comments in search mode: the top-level comments of the top matching posts
 *           (at most 5 posts, by score, while time allows).
 *
 * Seen live on 2026-10-18 from a cloud IP (curl and headless Chromium alike):
 *   https://old.reddit.com/search?q=claude+code -> HTTP 302 to
 *   https://old.reddit.com/login/?reason=lor2&dest=<the search URL>, and that login
 *   page answered HTTP 403 with the text "You've been blocked by network security."
 *   (so did www.reddit.com's search after its JS challenge). Reddit logs cloud
 *   networks out and then blocks them; from a home IP old.reddit serves search
 *   anonymously. The recipe reports the block page as `blocked` and a /login
 *   redirect that renders a login form as `blocked` with `needsLogin: true`.
 *
 * Seen live on 2026-10-28 from the owner's home IP, logged in (WP39):
 *   - sort=top, new and comments match far more loosely than relevance: for
 *     "best budget robot vacuum 2026" sort=top listed 25 of the year's
 *     highest-scored posts, none about vacuums, and even a one-word "espresso"
 *     listed cake recipes. www.reddit.com/search gave the same lists, so this
 *     is Reddit's search, not old.reddit. sort=relevance lists matching posts;
 *     ordering by score or date is left to the tool's merge (PLAN.md 14.5).
 *   - the search page sometimes says "there doesn't seem to be anything here"
 *     for a query that has results, and lists them when loaded again a second
 *     or two later. The page is the same markup as a real no-match page, so an
 *     empty search is loaded again (`emptyRetryDelaysMs`) before it is believed.
 *
 * Page structure (old.reddit's long-stable markup):
 *   results   div.search-result-link (data-fullname="t3_<id>"): a.search-title,
 *             .search-score ("12 points"), .search-comments ("3 comments", href is
 *             the permalink), a.search-subreddit-link ("r/sub"), time[datetime],
 *             .search-author a, .search-result-body (snippet, when shown).
 *   over 18   /over18?dest=... interstitial with a form whose button[name=over18]
 *             [value=yes] continues; clicking it is the one write-free control used.
 *   thread    #siteTable .thing.link (data-permalink, data-fullname, data-subreddit,
 *             a.title, .score.unvoted[title], a.author, time[datetime],
 *             .expando .usertext-body) and top-level comments
 *             .commentarea .sitetable.nestedlisting > .thing.comment (data-permalink,
 *             data-fullname="t1_<id>", .usertext-body, .score.unvoted[title] with the
 *             exact count, a.author, time[datetime], a.numchildren "(n children)").
 *
 * Extraction is deterministic (the markup is stable and plain); there is no LLM
 * call in this recipe, so it works without ANTHROPIC_API_KEY.
 *
 * www.reddit.com's search first, old.reddit as the fallback, from what was
 * seen live on 2026-10-28 (WP43) for four everyday questions:
 *   - old.reddit's search said "there doesn't seem to be anything here" for
 *     every query, through four loads each (including one that had listed 15
 *     posts half an hour before), while www.reddit.com's search, from the same
 *     logged-in profile, listed 10 posts for each;
 *   - once old.reddit answered again, its relevance ranking kept to the query
 *     for 17 of 40 posts ("Sharm El Sheikh best snorkeling spots" listed
 *     Monster Hunter; "cost of living in Cairo as an expat" none about Cairo),
 *     www.reddit.com's for about 39 of 40.
 * So search mode reads www.reddit.com's search, and old.reddit's (with one
 * reload of an empty page) when www.reddit.com finds nothing, fails, or is
 * asked for several subreddits, with a caveat saying which and why:
 *   search    https://www.reddit.com/search/?q=<q>&type=posts&sort=relevance&t=<t>
 *             (one subreddit: /r/<sub>/search/?...&restrict_sr=1; several
 *             subreddits are not supported there: /r/a+b/search/ finds nothing)
 *   results   [data-testid="sdui-post-unit"]: a[data-testid="post-title-text"]
 *             (id "search-post-title-t3_<id>", href the permalink), a second link
 *             to the same href holding a snippet, faceplate-hovercard[label="r/sub"],
 *             faceplate-timeago > time[datetime], and [data-testid="search-counter-row"]
 *             spans "N votes" and "N comments" with faceplate-number[number].
 *             Server-rendered: 7 results within about a second; scrolling adds more.
 *   none      "Hm...we couldn't find any results for <q>".
 * The posts' comments, in search mode, are still read on old.reddit.
 */

export const REDDIT_SITE = "reddit_search";
export const OLD_REDDIT_ORIGIN = "https://old.reddit.com";
/** Canonical host for item URLs, so they dedupe with the API provider's. */
export const REDDIT_CANONICAL_ORIGIN = "https://www.reddit.com";
const SITE_NAME = "Reddit (old.reddit.com)";
/** Most post pages opened for comments in search mode (PLAN.md 14.5). */
export const MAX_COMMENT_POSTS = 5;
/** Time reserved before each extra post page is opened for comments. */
const COMMENT_PAGE_RESERVE_MS = 8000;
/** Pauses before loading an empty old.reddit search page again (WP39; one reload since WP43, now that it is the fallback). */
export const DEFAULT_EMPTY_RETRY_DELAYS_MS: readonly number[] = [1000];
/** Time kept in hand after an empty page before loading it again. */
const EMPTY_RETRY_RESERVE_MS = 3000;
const NEW_REDDIT_SITE_NAME = "Reddit (www.reddit.com)";
/** Least time left for www.reddit.com's search to be worth a try. */
const NEW_REDDIT_RESERVE_MS = 6000;
/** Least time left, after www.reddit.com failed, for old.reddit to be worth a try. */
const OLD_REDDIT_RESERVE_MS = 5000;
/** Most scrolls of www.reddit.com's results to load more of them. */
const NEW_REDDIT_MAX_SCROLLS = 2;

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com", "sh.reddit.com"]);
const SHORT_HOSTS = new Set(["redd.it", "www.redd.it"]);

const WALL_RULES: WallRules = {
  site: SITE_NAME,
  platform: "reddit",
  loginUrl: /\/login(?:[/?#]|$)/i,
  loginText: /^\s*log in\s*$|you must be logged in to do that/im,
  blockedText: /blocked by network security|whoa there, pardner/i,
};

const NO_RESULTS_RE = /there doesn't seem to be anything here|no results found/i;

const NEW_WALL_RULES: WallRules = {
  ...WALL_RULES,
  site: NEW_REDDIT_SITE_NAME,
  blockedText: /blocked by network security|whoa there, pardner|prove your humanity|verify (?:that )?you(?:'re| are) (?:a )?human/i,
};

const NEW_NO_RESULTS_RE = /we couldn.t find any results/i;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Reddit's other sorts match loosely enough to list unrelated posts (see above); `q.sort` is applied by the merge. */
export function buildOldRedditSearchUrl(q: SocialSearchQuery, baseUrl?: string): string {
  const subs = q.subreddits?.map((s) => s.trim().replace(/^\/?r\//i, "")).filter((s) => s !== "") ?? [];
  const path = subs.length > 0 ? `/r/${subs.join("+")}/search` : "/search";
  const params = new URLSearchParams({ q: q.query ?? "", sort: "relevance", t: q.recency ?? "all", restrict_sr: "on" });
  return rebase(`${OLD_REDDIT_ORIGIN}${path}?${params.toString()}`, OLD_REDDIT_ORIGIN, baseUrl);
}

/**
 * www.reddit.com's own search for posts, or undefined when it cannot express the
 * query: it has no search across several subreddits.
 */
export function buildNewRedditSearchUrl(q: SocialSearchQuery, baseUrl?: string): string | undefined {
  const subs = q.subreddits?.map((s) => s.trim().replace(/^\/?r\//i, "")).filter((s) => s !== "") ?? [];
  if (subs.length > 1) return undefined;
  const path = subs.length === 1 ? `/r/${subs[0] as string}/search/` : "/search/";
  const params = new URLSearchParams({ q: q.query ?? "", type: "posts", sort: "relevance", t: q.recency ?? "all" });
  if (subs.length === 1) params.set("restrict_sr", "1");
  return rebase(`${REDDIT_CANONICAL_ORIGIN}${path}?${params.toString()}`, REDDIT_CANONICAL_ORIGIN, baseUrl);
}

export interface RedditThreadRef {
  id: string;
  /** Path such as /r/sub/comments/<id>/slug, without a trailing slash. */
  path: string;
  /** https://www.reddit.com<path> */
  canonicalUrl: string;
}

/** Parse a thread URL on any reddit.com host or redd.it; undefined for anything else. */
export function parseRedditThreadUrl(url: string): RedditThreadRef | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) {
    const id = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!/^[a-z0-9]+$/i.test(id)) return undefined;
    return { id, path: `/comments/${id}`, canonicalUrl: `${REDDIT_CANONICAL_ORIGIN}/comments/${id}` };
  }
  if (!REDDIT_HOSTS.has(host)) return undefined;
  const m = /^((?:\/r\/[^/]+|\/user\/[^/]+)?\/comments\/([a-z0-9]+)(?:\/[^/]*)?)/i.exec(u.pathname);
  if (m === null) return undefined;
  const path = (m[1] as string).replace(/\/+$/, "");
  return { id: m[2] as string, path, canonicalUrl: `${REDDIT_CANONICAL_ORIGIN}${path}` };
}

export function isRedditUrl(url: string): boolean {
  return parseRedditThreadUrl(url) !== undefined;
}

/** The old.reddit URL that loads a thread's top-level comments. */
export function buildOldRedditThreadUrl(ref: RedditThreadRef, limit: number, baseUrl?: string): string {
  const params = new URLSearchParams({ limit: String(limit), depth: "1", sort: "top" });
  return rebase(`${OLD_REDDIT_ORIGIN}${ref.path}/?${params.toString()}`, OLD_REDDIT_ORIGIN, baseUrl);
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface RedditProbe extends BasicProbe {
  results: number;
  comments: number;
  post: boolean;
  over18: boolean;
}

const REDDIT_PROBE_JS = probeScript(`
  return {
    results: document.querySelectorAll("div.search-result-link").length,
    comments: document.querySelectorAll(".commentarea .thing.comment").length,
    post: !!document.querySelector("#siteTable .thing.link, .thing[data-type='link']"),
    over18: !!document.querySelector('button[name="over18"][value="yes"], form[action*="over18"]'),
  };
`);

interface RawResult {
  fullname: string;
  title: string;
  href: string;
  score: string;
  comments: string;
  commentsHref: string;
  subreddit: string;
  datetime: string;
  author: string;
  body: string;
}

const RESULTS_JS = `(() => {
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const attr = (el, a) => (el ? (el.getAttribute(a) || "") : "");
  return Array.from(document.querySelectorAll("div.search-result-link")).map((r) => ({
    fullname: attr(r, "data-fullname"),
    title: txt(r.querySelector("a.search-title")),
    href: attr(r.querySelector("a.search-title"), "href"),
    score: txt(r.querySelector(".search-score")),
    comments: txt(r.querySelector(".search-comments")),
    commentsHref: attr(r.querySelector("a.search-comments"), "href"),
    subreddit: txt(r.querySelector("a.search-subreddit-link")),
    datetime: attr(r.querySelector("time[datetime]"), "datetime"),
    author: txt(r.querySelector(".search-author a")),
    body: r.querySelector(".search-result-body") ? (r.querySelector(".search-result-body").innerText || "") : "",
  }));
})()`;

const NEW_PROBE_JS = probeScript(`
  return {
    results: document.querySelectorAll('[data-testid="sdui-post-unit"] a[data-testid="post-title-text"]').length,
    comments: 0,
    post: false,
    over18: false,
  };
`);

interface RawNewResult {
  fullname: string;
  title: string;
  href: string;
  votes: string;
  comments: string;
  subreddit: string;
  datetime: string;
  snippet: string;
}

/** One record per www.reddit.com search result; counts from faceplate-number's exact `number`. */
const NEW_RESULTS_JS = `(() => {
  const txt = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");
  const counter = (unit, re) => {
    const span = Array.from(unit.querySelectorAll('[data-testid="search-counter-row"] span')).find((s) => re.test(txt(s)));
    if (!span) return "";
    const n = span.querySelector("faceplate-number");
    return (n && n.getAttribute("number")) || txt(span);
  };
  return Array.from(document.querySelectorAll('[data-testid="sdui-post-unit"]')).map((u) => {
    const title = u.querySelector('a[data-testid="post-title-text"]');
    const href = title ? (title.getAttribute("href") || "") : "";
    const snippet = Array.from(u.querySelectorAll("a[href]")).find((a) => a !== title && a.getAttribute("href") === href);
    const community = u.querySelector('faceplate-hovercard[data-id="community-hover-card"]');
    const time = u.querySelector("faceplate-timeago time[datetime], time[datetime]");
    return {
      fullname: title ? (title.id || "").replace(/^search-post-title-/, "") : "",
      title: txt(title),
      href,
      votes: counter(u, /\\bvotes?$/i),
      comments: counter(u, /\\bcomments?$/i),
      subreddit: community ? (community.getAttribute("label") || "") : "",
      datetime: time ? (time.getAttribute("datetime") || "") : "",
      snippet: snippet ? (snippet.innerText || snippet.textContent || "") : "",
    };
  });
})()`;

interface RawPost {
  fullname: string;
  permalink: string;
  subreddit: string;
  title: string;
  scoreTitle: string;
  scoreText: string;
  author: string;
  datetime: string;
  body: string;
  commentCount: string;
}

interface RawComment {
  fullname: string;
  permalink: string;
  author: string;
  scoreTitle: string;
  scoreText: string;
  datetime: string;
  body: string;
  children: string;
  deleted: boolean;
}

const THREAD_JS = `(() => {
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const attr = (el, a) => (el ? (el.getAttribute(a) || "") : "");
  const p = document.querySelector("#siteTable .thing.link, .thing[data-type='link']");
  const post = p ? {
    fullname: attr(p, "data-fullname"),
    permalink: attr(p, "data-permalink"),
    subreddit: attr(p, "data-subreddit"),
    title: txt(p.querySelector("a.title")),
    scoreTitle: attr(p.querySelector(".score.unvoted"), "title"),
    scoreText: txt(p.querySelector(".score.unvoted")),
    author: txt(p.querySelector("a.author")),
    datetime: attr(p.querySelector("time[datetime]"), "datetime"),
    body: p.querySelector(".expando .usertext-body") ? (p.querySelector(".expando .usertext-body").innerText || "") : "",
    commentCount: txt(p.querySelector("a.comments")),
  } : null;
  const nodes = document.querySelectorAll(".commentarea .sitetable.nestedlisting > .thing.comment, .commentarea > .sitetable > .thing.comment");
  const comments = Array.from(new Set(nodes)).map((c) => {
    const entry = c.querySelector(":scope > .entry") || c;
    return {
      fullname: attr(c, "data-fullname"),
      permalink: attr(c, "data-permalink"),
      author: txt(entry.querySelector("a.author")),
      scoreTitle: attr(entry.querySelector(".score.unvoted"), "title"),
      scoreText: txt(entry.querySelector(".score.unvoted")),
      datetime: attr(entry.querySelector("time[datetime]"), "datetime"),
      body: entry.querySelector(".usertext-body") ? (entry.querySelector(".usertext-body").innerText || "") : "",
      children: txt(entry.querySelector("a.numchildren")),
      deleted: c.classList.contains("deleted"),
    };
  });
  return { post, comments };
})()`;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function nativeId(fullname: string, href: string): string | undefined {
  const fromName = /^t[0-9]_([a-z0-9]+)$/i.exec(fullname)?.[1];
  if (fromName !== undefined) return fromName;
  return /\/comments\/([a-z0-9]+)/i.exec(href)?.[1];
}

function canonicalFromPath(permalinkOrHref: string): string | undefined {
  if (permalinkOrHref === "") return undefined;
  if (/^https?:\/\//i.test(permalinkOrHref)) return parseRedditThreadUrl(permalinkOrHref)?.canonicalUrl;
  return `${REDDIT_CANONICAL_ORIGIN}${permalinkOrHref.replace(/\/+$/, "")}`;
}

/** Subreddit name without the r/ prefix, or undefined. */
export function subredditName(raw: string): string | undefined {
  const s = raw.trim().replace(/^\/?r\//i, "");
  return s === "" ? undefined : s;
}

export function resultToCandidate(raw: RawResult): Record<string, unknown> | undefined {
  const id = nativeId(raw.fullname, raw.commentsHref || raw.href);
  const url = canonicalFromPath(raw.commentsHref) ?? canonicalFromPath(raw.href);
  if (id === undefined || url === undefined) return undefined;
  const { text, truncated } = clipText(raw.body);
  return compact({
    id: `reddit:${id}`,
    platform: "reddit",
    kind: "post",
    url,
    author: safeAuthor(raw.author.replace(/^u\//, "")),
    title: raw.title.trim() || undefined,
    text,
    truncated,
    created_at: toIso(raw.datetime),
    score: parseCount(raw.score),
    replies: parseCount(raw.comments),
    community: subredditName(raw.subreddit),
  });
}

/** A www.reddit.com search result as a post. Its snippet is the start of the post's text (or of a matching comment). */
export function newResultToCandidate(raw: RawNewResult): Record<string, unknown> | undefined {
  const id = nativeId(raw.fullname, raw.href);
  const url = canonicalFromPath(raw.href);
  if (id === undefined || url === undefined) return undefined;
  const { text, truncated } = clipText(raw.snippet);
  return compact({
    id: `reddit:${id}`,
    platform: "reddit",
    kind: "post",
    url,
    title: raw.title.trim() || undefined,
    text,
    truncated,
    created_at: toIso(raw.datetime),
    score: parseCount(raw.votes),
    replies: parseCount(raw.comments),
    community: subredditName(raw.subreddit),
  });
}

/** Score from `.score.unvoted`: the exact count in `title`, else the printed "12 points"; undefined when hidden. */
export function scoreOf(title: string, text: string): number | undefined {
  const exact = parseCount(title);
  if (exact !== undefined) return exact;
  if (/hidden/i.test(text)) return undefined;
  return parseCount(text);
}

export function postToCandidate(raw: RawPost): Record<string, unknown> | undefined {
  const id = nativeId(raw.fullname, raw.permalink);
  const url = canonicalFromPath(raw.permalink);
  if (id === undefined || url === undefined) return undefined;
  const { text, truncated } = clipText(raw.body);
  return compact({
    id: `reddit:${id}`,
    platform: "reddit",
    kind: "post",
    url,
    author: safeAuthor(raw.author),
    title: raw.title.trim() || undefined,
    text,
    truncated,
    created_at: toIso(raw.datetime),
    score: scoreOf(raw.scoreTitle, raw.scoreText),
    replies: parseCount(raw.commentCount),
    community: subredditName(raw.subreddit),
  });
}

export function commentToCandidate(raw: RawComment, parentUrl: string, community: string | undefined): Record<string, unknown> | undefined {
  if (raw.deleted) return undefined;
  const id = nativeId(raw.fullname, raw.permalink);
  const url = canonicalFromPath(raw.permalink);
  if (id === undefined || url === undefined) return undefined;
  const { text, truncated } = clipText(raw.body);
  return compact({
    id: `reddit:${id}`,
    platform: "reddit",
    kind: "comment",
    url,
    author: safeAuthor(raw.author),
    text,
    truncated,
    created_at: toIso(raw.datetime),
    score: scoreOf(raw.scoreTitle, raw.scoreText),
    replies: parseCount(raw.children),
    community,
    parent_url: parentUrl,
  });
}

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export interface RedditSearchRecipeOptions extends SocialRecipeOptions {
  /** Pauses before each reload of an empty old.reddit search page, in ms; one reload per entry. Default DEFAULT_EMPTY_RETRY_DELAYS_MS. */
  emptyRetryDelaysMs?: readonly number[];
  /** Search www.reddit.com first and old.reddit as the fallback (WP43). Default true; tests of old.reddit alone turn it off. */
  newRedditFirst?: boolean;
}

export function createRedditSearchRecipe(options: RedditSearchRecipeOptions = {}): SocialRecipe {
  const o = resolveOptions(options);
  const emptyRetryDelaysMs = options.emptyRetryDelaysMs ?? DEFAULT_EMPTY_RETRY_DELAYS_MS;
  const newRedditFirst = options.newRedditFirst ?? true;

  const buildUrl = (q: SocialSearchQuery): string | null => {
    if (q.mode === "thread") {
      const ref = q.url === undefined ? undefined : parseRedditThreadUrl(q.url);
      return ref === undefined ? null : buildOldRedditThreadUrl(ref, q.per_platform, o.baseUrl);
    }
    if (q.query === undefined) return null;
    return (newRedditFirst ? buildNewRedditSearchUrl(q, o.baseUrl) : undefined) ?? buildOldRedditSearchUrl(q, o.baseUrl);
  };

  async function run(page: Page, params: SocialSearchQuery, ctx: RecipeContext): Promise<SocialItem[]> {
    const parsed = SocialSearchQuerySchema.safeParse(params);
    if (!parsed.success) {
      throw new RecipeError("invalid_input", `invalid social query: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    const q = parsed.data;
    const guard = timeGuard(ctx, SITE_NAME);
    const caveat = caveatSink(ctx);
    try {
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      guard.check("before navigating");
      return q.mode === "thread" ? await thread(page, q, ctx, guard, caveat) : await search(page, q, ctx, guard, caveat);
    } catch (err) {
      throw toRecipeError(err, ctx, SITE_NAME);
    }
  }

  async function search(page: Page, q: SocialSearchQuery, ctx: RecipeContext, guard: TimeGuard, caveat: (m: string) => void): Promise<SocialItem[]> {
    if (q.query === undefined) throw new RecipeError("invalid_input", "Reddit search needs a query");
    let posts: SocialItem[] | undefined;
    /** Why old.reddit is read after www.reddit.com was tried, for the caveat. */
    let why: string | undefined;
    const newUrl = newRedditFirst ? buildNewRedditSearchUrl(q, o.baseUrl) : undefined;
    if (newUrl !== undefined && guard.remaining() >= NEW_REDDIT_RESERVE_MS) {
      try {
        const found = await searchNewReddit(page, newUrl, q, ctx, guard, caveat);
        if (found.length > 0) posts = found;
        else why = "www.reddit.com's search found nothing";
      } catch (err) {
        if (guard.remaining() < OLD_REDDIT_RESERVE_MS) throw err;
        why = `www.reddit.com's search could not be read (${firstLine(err)})`;
        ctx.log.warn("reddit: www.reddit.com's search failed; trying old.reddit", { error: firstLine(err) });
      }
    }
    posts ??= await searchOldReddit(page, q, ctx, guard, caveat, why);
    if (posts.length === 0) return [];
    if (q.kind === "posts") return posts.slice(0, q.per_platform);

    const postBudget = q.kind === "both" ? Math.ceil(q.per_platform / 2) : 0;
    const commentBudget = q.per_platform - postBudget;
    const ranked = [...posts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const comments: SocialItem[] = [];
    let opened = 0;
    for (const post of ranked) {
      if (comments.length >= commentBudget || opened >= MAX_COMMENT_POSTS) break;
      if (guard.remaining() < COMMENT_PAGE_RESERVE_MS) {
        caveat("Not every top Reddit post was opened for comments: the time budget ran low.");
        break;
      }
      const ref = parseRedditThreadUrl(post.url);
      if (ref === undefined) continue;
      opened++;
      try {
        comments.push(...(await readThread(page, ref, commentBudget - comments.length, ctx, guard, caveat)).filter((i) => i.kind === "comment"));
      } catch (err) {
        if (err instanceof RecipeError && err.code === "timeout") throw err;
        ctx.log.warn("reddit: could not read a post's comments", { url: post.url, error: firstLine(err) });
        caveat(`Comments of ${post.url} could not be read: ${firstLine(err)}`);
      }
    }
    return [...posts.slice(0, postBudget), ...comments.slice(0, commentBudget)];
  }

  /**
   * old.reddit's search, loading an empty page again before believing it. The
   * fallback when www.reddit.com's search found nothing or failed (`why`), and
   * the only search for several subreddits at once.
   */
  async function searchOldReddit(
    page: Page,
    q: SocialSearchQuery,
    ctx: RecipeContext,
    guard: TimeGuard,
    caveat: (m: string) => void,
    why: string | undefined,
  ): Promise<SocialItem[]> {
    const url = buildOldRedditSearchUrl(q, o.baseUrl);
    let loads = 0;
    for (;;) {
      await navigateTo(page, url, ctx, { site: SITE_NAME, guard });
      loads++;
      if ((await waitFor(page, ctx, guard, caveat, (p) => p.results > 0)) === "results") {
        const raws = await page.evaluate<RawResult[]>(RESULTS_JS);
        const posts = validateItems(
          raws.map(resultToCandidate).filter((c): c is Record<string, unknown> => c !== undefined),
          ctx,
          SITE_NAME,
        );
        if (why !== undefined) caveat(`These Reddit posts come from old.reddit.com's search: ${why}.`);
        return posts;
      }
      const delay = emptyRetryDelaysMs[loads - 1];
      if (delay === undefined || guard.remaining() < delay + EMPTY_RETRY_RESERVE_MS) {
        const tried = `old.reddit.com's search was loaded ${loads} time${loads === 1 ? "" : "s"}`;
        caveat(`Reddit showed no posts for "${q.query}" (${why !== undefined ? `${why}; ` : ""}${tried}).`);
        return [];
      }
      ctx.log.debug("reddit: the search page was empty; loading it again", { loads, delay_ms: delay });
      await sleep(delay);
    }
  }

  /**
   * www.reddit.com's own search, read first (WP43): its relevance ranking keeps
   * to the query where old.reddit's often does not. Empty when it found nothing;
   * walls, timeouts and HTTP errors throw. Posts only; in search mode their
   * comments are still read on old.reddit.
   */
  async function searchNewReddit(
    page: Page,
    url: string,
    q: SocialSearchQuery,
    ctx: RecipeContext,
    guard: TimeGuard,
    caveat: (m: string) => void,
  ): Promise<SocialItem[]> {
    await navigateTo(page, url, ctx, { site: NEW_REDDIT_SITE_NAME, guard });
    const state = await waitFor(page, ctx, guard, caveat, (p) => p.results > 0, { probe: NEW_PROBE_JS, noResults: NEW_NO_RESULTS_RE, walls: NEW_WALL_RULES });
    if (state === "empty") return [];
    let count = await page.evaluate<number>(`document.querySelectorAll('[data-testid="sdui-post-unit"]').length`);
    for (let i = 0; i < NEW_REDDIT_MAX_SCROLLS && count < q.per_platform && guard.remaining() > EMPTY_RETRY_RESERVE_MS; i++) {
      const before = count;
      await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
      const until = Date.now() + Math.min(2500, guard.remaining() - EMPTY_RETRY_RESERVE_MS);
      do {
        await sleep(o.pollMs);
        count = await page.evaluate<number>(`document.querySelectorAll('[data-testid="sdui-post-unit"]').length`);
      } while (count <= before && Date.now() < until);
      if (count <= before) break;
    }
    const raws = await page.evaluate<RawNewResult[]>(NEW_RESULTS_JS);
    return validateItems(
      raws.map(newResultToCandidate).filter((c): c is Record<string, unknown> => c !== undefined),
      ctx,
      NEW_REDDIT_SITE_NAME,
    );
  }

  async function thread(page: Page, q: SocialSearchQuery, ctx: RecipeContext, guard: TimeGuard, caveat: (m: string) => void): Promise<SocialItem[]> {
    const ref = q.url === undefined ? undefined : parseRedditThreadUrl(q.url);
    if (ref === undefined) throw new RecipeError("invalid_input", `not a Reddit thread URL: ${q.url ?? "(none)"}`);
    return readThread(page, ref, q.per_platform, ctx, guard, caveat);
  }

  /** Open a thread on old.reddit and return the post (first) and its top-level comments. */
  async function readThread(
    page: Page,
    ref: RedditThreadRef,
    limit: number,
    ctx: RecipeContext,
    guard: TimeGuard,
    caveat: (m: string) => void,
  ): Promise<SocialItem[]> {
    await navigateTo(page, buildOldRedditThreadUrl(ref, Math.max(1, limit), o.baseUrl), ctx, {
      site: SITE_NAME,
      guard,
      onStatus: (status) => {
        if (status === 404) return new RecipeError("provider", "Reddit answered HTTP 404: the thread does not exist", { retryable: false });
        if (status === 403 || status === 429) {
          return new RecipeError("blocked", `Reddit answered HTTP ${status}; it is blocking this browser or network`, { retryable: false });
        }
        return status >= 500 ? new RecipeError("provider", `Reddit answered HTTP ${status}`, { retryable: true }) : undefined;
      },
    });
    const state = await waitFor(page, ctx, guard, caveat, (p) => p.post || p.comments > 0);
    if (state === "empty") {
      caveat("Reddit showed nothing at that URL.");
      return [];
    }
    const raw = await page.evaluate<{ post: RawPost | null; comments: RawComment[] }>(THREAD_JS);
    const postCandidate = raw.post === null ? undefined : postToCandidate(raw.post);
    const post = postCandidate === undefined ? [] : validateItems([postCandidate], ctx, SITE_NAME);
    const postItem = post[0];
    const parentUrl = postItem?.url ?? ref.canonicalUrl;
    const community = postItem?.community;
    const comments = validateItems(
      raw.comments.map((c) => commentToCandidate(c, parentUrl, community)).filter((c): c is Record<string, unknown> => c !== undefined),
      ctx,
      SITE_NAME,
    );
    if (postItem === undefined) caveat("The Reddit post itself could not be read; only comments are returned.");
    return [...post, ...comments.slice(0, limit)];
  }

  /**
   * Wait for `ready`, passing the over-18 gate once; walls throw; "empty" when
   * the page says there is nothing. `page` defaults to old.reddit's probe, text and walls.
   */
  async function waitFor(
    page: Page,
    ctx: RecipeContext,
    guard: TimeGuard,
    caveat: (m: string) => void,
    ready: (p: RedditProbe) => boolean,
    site: { probe: string; noResults: RegExp; walls: WallRules } = { probe: REDDIT_PROBE_JS, noResults: NO_RESULTS_RE, walls: WALL_RULES },
  ): Promise<"results" | "empty"> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(o.maxResultsWaitMs, guard.remaining() * 0.6));
    let gatePassed = false;
    let last: RedditProbe | undefined;
    for (;;) {
      guard.check("while waiting for the page");
      const probe = await runProbe<RedditProbe>(page, site.probe);
      if (probe !== undefined) {
        last = probe;
        const wall = classifyWall(probe, site.walls);
        if (wall !== undefined) throw wall;
        if (ready(probe)) return "results";
        if (probe.over18) {
          if (gatePassed) throw new RecipeError("blocked", `Reddit kept showing its over-18 interstitial at ${probe.url}`, { retryable: false });
          if (await passAgeGate(page, ctx)) {
            gatePassed = true;
            caveat("Reddit showed an over-18 interstitial, which was accepted to read the page.");
            continue;
          }
          throw new RecipeError("blocked", `Reddit showed an over-18 interstitial at ${probe.url} that could not be passed`, { retryable: false });
        }
        if (site.noResults.test(probe.text)) return "empty";
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `${site.walls.site} did not show the page within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(o.pollMs);
    }
  }

  /** Click the interstitial's "yes" button (a navigation, no form fields). True when it was clicked. */
  async function passAgeGate(page: Page, ctx: RecipeContext): Promise<boolean> {
    try {
      const yes = page.locator('button[name="over18"][value="yes"]').first();
      if ((await yes.count()) === 0) return false;
      await Promise.all([page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined), yes.click({ timeout: 3000 })]);
      await sleep(o.pollMs);
      return true;
    } catch (err) {
      ctx.log.debug("reddit: over-18 button could not be clicked", { error: firstLine(err) });
      return false;
    }
  }

  return {
    site: REDDIT_SITE,
    paramsSchema: SocialSearchQuerySchema,
    resultSchema: z.array(SocialItemSchema),
    buildUrl,
    run,
  };
}

/** The recipe against live old.reddit.com. */
export const redditSearchRecipe: SocialRecipe = createRedditSearchRecipe();
