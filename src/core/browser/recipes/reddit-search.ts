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
 *   search  https://old.reddit.com/search?q=<q>&sort=top|new&t=all|day|week|month|year&restrict_sr=on
 *           with `subreddits`: https://old.reddit.com/r/a+b/search?...&restrict_sr=on
 *           sort engagement -> top, recent -> new; recency -> t.
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

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const SORT_PARAM: Record<SocialSearchQuery["sort"], string> = { engagement: "top", recent: "new" };

export function buildOldRedditSearchUrl(q: SocialSearchQuery, baseUrl?: string): string {
  const subs = q.subreddits?.map((s) => s.trim().replace(/^\/?r\//i, "")).filter((s) => s !== "") ?? [];
  const path = subs.length > 0 ? `/r/${subs.join("+")}/search` : "/search";
  const params = new URLSearchParams({ q: q.query ?? "", sort: SORT_PARAM[q.sort], t: q.recency ?? "all", restrict_sr: "on" });
  return rebase(`${OLD_REDDIT_ORIGIN}${path}?${params.toString()}`, OLD_REDDIT_ORIGIN, baseUrl);
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

export function createRedditSearchRecipe(options: SocialRecipeOptions = {}): SocialRecipe {
  const o = resolveOptions(options);

  const buildUrl = (q: SocialSearchQuery): string | null => {
    if (q.mode === "thread") {
      const ref = q.url === undefined ? undefined : parseRedditThreadUrl(q.url);
      return ref === undefined ? null : buildOldRedditThreadUrl(ref, q.per_platform, o.baseUrl);
    }
    return q.query === undefined ? null : buildOldRedditSearchUrl(q, o.baseUrl);
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
    await navigateTo(page, buildOldRedditSearchUrl(q, o.baseUrl), ctx, { site: SITE_NAME, guard });
    const state = await waitFor(page, ctx, guard, caveat, (p) => p.results > 0);
    if (state === "empty") {
      caveat(`Reddit showed no posts for "${q.query}".`);
      return [];
    }
    const raws = await page.evaluate<RawResult[]>(RESULTS_JS);
    const posts = validateItems(
      raws.map(resultToCandidate).filter((c): c is Record<string, unknown> => c !== undefined),
      ctx,
      SITE_NAME,
    );
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

  /** Wait for `ready`, passing the over-18 gate once; walls throw; "empty" when old.reddit says there is nothing. */
  async function waitFor(
    page: Page,
    ctx: RecipeContext,
    guard: TimeGuard,
    caveat: (m: string) => void,
    ready: (p: RedditProbe) => boolean,
  ): Promise<"results" | "empty"> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(o.maxResultsWaitMs, guard.remaining() * 0.6));
    let gatePassed = false;
    let last: RedditProbe | undefined;
    for (;;) {
      guard.check("while waiting for the page");
      const probe = await runProbe<RedditProbe>(page, REDDIT_PROBE_JS);
      if (probe !== undefined) {
        last = probe;
        const wall = classifyWall(probe, WALL_RULES);
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
        if (NO_RESULTS_RE.test(probe.text)) return "empty";
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `old.reddit did not show the page within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
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
