import type { Page, Response as PageResponse } from "playwright";
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
  defaultStatusError,
  extractWithLlm,
  firstLine,
  navigateTo,
  probeScript,
  rebase,
  resolveOptions,
  runProbe,
  safeAuthor,
  scrollDown,
  shortHash,
  sleep,
  timeGuard,
  toIso,
  toRecipeError,
  unrebase,
  validateItems,
  type SocialRecipe,
  type SocialRecipeOptions,
  type TimeGuard,
  type WallRules,
} from "./social-common.js";

/**
 * Facebook recipe, PLAN.md 14.5 (WP18b). Browser only, through the owner's
 * logged-in profile; personal low-volume use, against Facebook's terms
 * (PLAN.md 14.0). A login is required for search.
 *
 * URLs:
 *   search  https://www.facebook.com/search/posts/?q=<q>
 *           sort recent adds Facebook's "Recent posts" filter
 *           (`filters=` base64 of {"recent_posts:0":"{\"name\":\"recent_posts\",\"args\":\"\"}"},
 *           the form Facebook's own UI emits; not verifiable from this environment).
 *           `recency` has no URL form on Facebook and becomes a caveat.
 *   thread  the post URL as given (host normalised to www.facebook.com);
 *           comments are below the post.
 *
 * Logged-out behaviour seen live on 2026-10-18 from a cloud IP:
 *   - /search/posts/?q=... answered HTTP 404 with the body "Not Found" (curl and
 *     headless Chromium alike): Facebook hides search from anonymous visitors, so a
 *     404 on the search URL is reported as `needsLogin`.
 *   - /login/ renders the login page: title "Facebook", text "Log into Facebook",
 *     `form#login_form` with `input[name=email]` and `input[name=pass][type=password]`.
 *   A redirect to /login, /recover or /reg, or a visible password field on a short
 *   page, is `needsLogin`; /checkpoint/ or a CAPTCHA is `blocked` without it.
 *
 * Extraction: the DOM is obfuscated (generated class names), so extraction is
 * schema-driven LLM over the visible text of the results, cut to about 30,000
 * characters. When an item has no permalink it carries the search URL and a
 * caveat says so.
 *
 * Logged in from a home IP, 2026-10-27 (WP36), the live results page differed
 * from what WP18b could see:
 *   - The feed (`div[role=feed]`, one child per result) is virtualised: posts
 *     that scroll away are emptied, so text read once after the last scroll held
 *     two posts. The recipe now scrolls about a screen at a time and reads every
 *     child after each step, keeping the longest text seen per child.
 *   - Dates and the "Sponsored" label are drawn as hundreds of one-character
 *     lines (a letter plus U+034F), and unloaded posts as lines of "Facebook";
 *     both are removed before the model sees the text. An advert has a U+2060
 *     word joiner after the advertiser's name (or a `utm_medium=paid` link) and is
 *     labelled sponsored for the model to skip.
 *   - Post anchors carry no permalink (`?__cft__...#?abc`; hovering did not fill
 *     one in). The page's own data does: `permalink_url` in the HTML and in the
 *     `/api/graphql/` responses that arrive while scrolling. They are matched to a
 *     post by the post id in its photo links (`set=pcb.<id>`), or by its group or
 *     page when only one post and one permalink share it. A post with a photo but
 *     no permalink gets one built from that id (`facebook.com/<id>` redirects to
 *     the post). Anchors that already are permalinks (as in WP18b's fixture) win.
 *   - The search tabs' own links match the permalink selector before the feed
 *     has any result, so a search waits for a feed child with text
 *     (`FEED_GRACE_MS` covers a layout without a feed).
 */

export const FACEBOOK_SITE = "facebook_search";
export const FACEBOOK_ORIGIN = "https://www.facebook.com";
const SITE_NAME = "Facebook";
/** Characters of visible text handed to the model. */
export const FACEBOOK_TEXT_MAX_CHARS = 30_000;

const FACEBOOK_HOSTS = new Set([
  "facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com", "touch.facebook.com",
  "fb.com", "www.fb.com", "fb.watch",
]);

const WALL_RULES: WallRules = {
  site: SITE_NAME,
  platform: "facebook",
  loginUrl: /facebook\.com\/(login|recover|reg)(?:[/?#.]|$)|\/login(?:[/?#.]|$)/i,
  loginText: /log into facebook|log in to facebook|you must log in to continue/i,
  blockedUrl: /\/checkpoint\//i,
};

const NO_RESULTS_RE = /we didn't find anything|no results found|we couldn't find anything/i;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Facebook's "Recent posts" search filter, as the site's own UI encodes it. */
export function recentPostsFilter(): string {
  return Buffer.from(JSON.stringify({ "recent_posts:0": JSON.stringify({ name: "recent_posts", args: "" }) })).toString("base64");
}

export function buildFacebookSearchUrl(q: SocialSearchQuery, baseUrl?: string): string {
  const params = new URLSearchParams({ q: q.query ?? "" });
  if (q.sort === "recent") params.set("filters", recentPostsFilter());
  return rebase(`${FACEBOOK_ORIGIN}/search/posts/?${params.toString()}`, FACEBOOK_ORIGIN, baseUrl);
}

const POST_PATH_RE = /\/posts\/|\/permalink(?:\.php|\/)|\/videos\/|\/reel\/|\/watch\/?|\/share\/|\/photo(?:\.php|\/)|\/story\.php|\/groups\/[^/]+\/posts\//i;
const TRACKING_PARAMS = new Set(["__cft__", "__tn__", "comment_id", "reply_comment_id", "notif_id", "notif_t", "ref", "mibextid", "rdid", "locale", "_rdr", "_rdc"]);

/** A post, video or permalink URL normalised to www.facebook.com without tracking parameters; undefined for anything else. */
export function canonicalFacebookPostUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!FACEBOOK_HOSTS.has(u.hostname.toLowerCase())) return undefined;
  // The search page's own links (/search/posts/?q=) are not posts.
  if (/^\/search\//i.test(u.pathname)) return undefined;
  const hasStory = u.searchParams.has("story_fbid") || (u.pathname.includes("permalink.php") && u.searchParams.has("id"));
  if (u.hostname.toLowerCase() === "fb.watch") return `${FACEBOOK_ORIGIN}/watch/?v=${u.pathname.replace(/^\/+|\/+$/g, "")}`;
  if (!POST_PATH_RE.test(u.pathname) && !hasStory) return undefined;
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!TRACKING_PARAMS.has(k.replace(/\[.*$/, ""))) params.set(k, v);
  const query = params.toString();
  return `${FACEBOOK_ORIGIN}${u.pathname.replace(/\/+$/, "") || "/"}${query === "" ? "" : `?${query}`}`;
}

export function isFacebookUrl(url: string): boolean {
  return canonicalFacebookPostUrl(url) !== undefined;
}

/** A stable native id for a permalink: the numeric id in the path or `story_fbid`, else a hash of the URL. */
export function facebookIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const story = u.searchParams.get("story_fbid") ?? u.searchParams.get("v") ?? u.searchParams.get("fbid");
    if (story !== null && story !== "") return story;
    const m = /\/(?:posts|permalink|videos|reel)\/(?:pfbid)?([A-Za-z0-9]+)/.exec(u.pathname) ?? /^\/(\d+)\/?$/.exec(u.pathname);
    if (m !== null) return m[1] as string;
  } catch {
    // fall through
  }
  return shortHash(url);
}

// ---------------------------------------------------------------------------
// Results text, permalinks from the page's data, and matching them to posts
// ---------------------------------------------------------------------------

/** One letter of an obfuscated date or "Sponsored" label: a character and U+034F on a line of its own. */
const GLYPH_LINE_RE = /^\s*\S?\u034f\s*$/;

/**
 * The visible text without Facebook's obfuscation: one-letter lines (a
 * character plus U+034F), lines of "Facebook" left by unloaded posts, and
 * U+2060 word joiners.
 */
export function cleanFacebookText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !GLYPH_LINE_RE.test(line))
    .map((line) => line.replace(/\u2060|\u034f/g, "").replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && line.trim() !== "Facebook")
    .join("\n");
}

/** An advert: the word joiner Facebook puts before its obfuscated "Sponsored" label, or a paid-campaign link. */
export function looksSponsored(rawText: string, hrefs: readonly string[]): boolean {
  return rawText.includes("\u2060") || hrefs.some((h) => /[?&]utm_medium=paid\b/i.test(h));
}

/** `permalink_url` values in a page or GraphQL body (slashes escaped or not), canonical and deduplicated, in order. */
export function permalinksFromBody(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/"permalink_url"\s*:\s*"(https?:(?:\\\/|\/){2}[^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    const canonical = canonicalFacebookPostUrl((m[1] as string).replace(/\\\//g, "/").replace(/\\u0026/gi, "&"));
    if (canonical !== undefined && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** What a result's links say about it. */
export interface FacebookPostRefs {
  /** Anchors that already are permalinks, canonical. */
  links: string[];
  /** Group ids or vanity names, lower-cased. */
  groups: string[];
  /** Pages and people: vanity names or numeric ids, lower-cased. */
  owners: string[];
  /** Post ids from photo links (`set=pcb.<id>`). */
  pcb: string[];
}

/** First path segments that are Facebook sections, not a page or person. */
const RESERVED_SEGMENTS = new Set([
  "groups", "photo", "photo.php", "photos", "stories", "story.php", "permalink.php", "hashtag", "search", "reel", "reels", "watch",
  "events", "marketplace", "profile.php", "pages", "ads", "help", "friends", "notifications", "messages", "gaming", "l.php",
  "sharer", "sharer.php", "share", "login", "settings", "bookmarks", "privacy", "policies", "business", "media", "video.php", "people",
]);
const PERMALINK_HREF_RE = /\/posts\/|\/permalink|\/videos\/|[?&]story_fbid=|\/reel\/\d/i;

/** Groups, owners, photo post ids and ready permalinks from a result's hrefs (absolute, on facebook.com). */
export function facebookPostRefs(hrefs: readonly string[]): FacebookPostRefs {
  const refs: FacebookPostRefs = { links: [], groups: [], owners: [], pcb: [] };
  const add = (list: string[], v: string | undefined): void => {
    if (v !== undefined && v !== "" && !list.includes(v)) list.push(v);
  };
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (!FACEBOOK_HOSTS.has(u.hostname.toLowerCase())) continue;
    if (PERMALINK_HREF_RE.test(`${u.pathname}${u.search}`)) add(refs.links, canonicalFacebookPostUrl(href));
    add(refs.pcb, /^pcb\.(\d+)$/.exec(u.searchParams.get("set") ?? "")?.[1]);
    const seg = u.pathname.split("/").filter((s) => s !== "");
    const first = seg[0]?.toLowerCase();
    if (first === "groups" && seg[1] !== undefined) {
      add(refs.groups, seg[1].toLowerCase());
      if (seg[2] === "user" && seg[3] !== undefined) add(refs.owners, seg[3].toLowerCase());
    } else if (first === "profile.php") {
      add(refs.owners, u.searchParams.get("id") ?? undefined);
    } else if (first !== undefined && !RESERVED_SEGMENTS.has(first) && /^[a-z0-9.]+$/.test(first)) {
      add(refs.owners, first);
    }
  }
  return refs;
}

/** Group, owner and post id of a canonical permalink. */
function permalinkParts(url: string): { group?: string; owner?: string; postId?: string } {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter((s) => s !== "");
    if (seg[0] === "groups" && seg[2] === "posts") return { group: seg[1]?.toLowerCase(), postId: seg[3] };
    if (/^(permalink|story)\.php$/.test(seg[0] ?? "")) return { owner: u.searchParams.get("id") ?? undefined, postId: u.searchParams.get("story_fbid") ?? undefined };
    if (seg.length >= 3 && (seg[1] === "posts" || seg[1] === "videos")) return { owner: seg[0]?.toLowerCase(), postId: seg[2] };
  } catch {
    // not a URL
  }
  return {};
}

/**
 * A permalink for each result, or undefined: an anchor that already is one;
 * else the page-data permalink whose post id is in the result's photo links;
 * else the one permalink that shares the result's group (or page), when no
 * other unmatched result shares it; else one built from a photo's post id.
 * A wrong link is worse than none, so ambiguous matches are left out.
 */
export function assignPermalinks(posts: readonly FacebookPostRefs[], dataLinks: readonly string[]): (string | undefined)[] {
  const out: (string | undefined)[] = posts.map(() => undefined);
  const used = new Set<string>();
  const take = (i: number, link: string): void => {
    out[i] = link;
    used.add(link);
  };
  posts.forEach((p, i) => {
    const link = p.links.find((l) => !used.has(l));
    if (link !== undefined) take(i, link);
  });
  const parts = dataLinks.map((link) => ({ link, ...permalinkParts(link) }));
  posts.forEach((p, i) => {
    if (out[i] !== undefined) return;
    const hit = parts.find((d) => !used.has(d.link) && d.postId !== undefined && p.pcb.includes(d.postId));
    if (hit !== undefined) take(i, hit.link);
  });
  for (const key of ["group", "owner"] as const) {
    const refsOf = (p: FacebookPostRefs): string[] => (key === "group" ? p.groups : p.owners);
    posts.forEach((p, i) => {
      if (out[i] !== undefined) return;
      for (const ref of refsOf(p)) {
        const links = parts.filter((d) => !used.has(d.link) && d[key] === ref);
        const rivals = posts.filter((q, j) => j !== i && out[j] === undefined && refsOf(q).includes(ref));
        if (links.length === 1 && rivals.length === 0) {
          take(i, (links[0] as { link: string }).link);
          return;
        }
      }
    });
  }
  posts.forEach((p, i) => {
    if (out[i] !== undefined || p.pcb[0] === undefined) return;
    const link = p.groups.length === 1 ? `${FACEBOOK_ORIGIN}/groups/${p.groups[0]}/posts/${p.pcb[0]}` : `${FACEBOOK_ORIGIN}/${p.pcb[0]}`;
    if (!used.has(link)) take(i, link);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface FacebookProbe extends BasicProbe {
  /** Visible text length of the results region (role=main or role=feed). */
  mainTextLength: number;
  permalinks: number;
  /** Feed children with at least 40 characters of text. */
  feedPosts: number;
}

const PERMALINK_SELECTOR = 'a[href*="/posts/"], a[href*="/permalink"], a[href*="/videos/"], a[href*="story_fbid="], a[href*="/reel/"]';

const FB_PROBE_JS = probeScript(`
  const main = document.querySelector('[role="main"], [role="feed"]');
  const feed = document.querySelector('[role="feed"]');
  return {
    mainTextLength: main ? (main.innerText || "").length : 0,
    permalinks: document.querySelectorAll('${PERMALINK_SELECTOR}').length,
    feedPosts: feed ? Array.from(feed.children).filter((c) => (c.innerText || "").trim().length >= 40).length : 0,
  };
`);

/**
 * How long a search page may show text but no feed results before its text is
 * read anyway (a layout without a feed). The search tabs' own links
 * (`/search/videos/`) match the permalink selector at once, while the feed is
 * still empty: live on 2026-10-27 reading then found 0 to 3 posts.
 */
const FEED_GRACE_MS = 5000;

/** A post page's visible text, generously cut: the obfuscation is removed before the real cut. */
const THREAD_TEXT_JS = `(() => {
  const main = document.querySelector('[role="main"], [role="feed"]') || document.body;
  return ((main && main.innerText) || "").slice(0, ${FACEBOOK_TEXT_MAX_CHARS * 4});
})()`;

interface FeedCapture {
  /** One entry per child of the feed that has text; `key` is its position, stable while the page lives. */
  posts: { key: number; text: string; hrefs: string[] }[];
  /** The results region's text when there is no feed. */
  text: string;
}

const FEED_CAPTURE_JS = `(() => {
  const feed = document.querySelector('[role="feed"]');
  const posts = [];
  if (feed) {
    Array.from(feed.children).forEach((child, key) => {
      const text = child.innerText || "";
      if (text.trim() === "") return;
      posts.push({ key, text, hrefs: Array.from(child.querySelectorAll("a[href]")).map((a) => a.href) });
    });
  }
  const main = document.querySelector('[role="main"]') || document.body;
  return { posts, text: posts.length > 0 ? "" : ((main && main.innerText) || "").slice(0, ${FACEBOOK_TEXT_MAX_CHARS * 4}) };
})()`;

/** Scroll about one screen; where the page is and how tall it is afterwards. */
const STEP_JS = `(() => {
  window.scrollBy(0, Math.round(window.innerHeight * 0.8));
  const se = document.scrollingElement || document.documentElement;
  return window.scrollY + ":" + se.scrollHeight;
})()`;

/** Screens scrolled per configured scroll: the shared recipes jump to the bottom, which skips most of a virtualised feed. */
const STEPS_PER_SCROLL = 4;
/** Characters of one result handed to the model. */
const POST_TEXT_MAX_CHARS = 4000;

/** A result as read so far: the longest text seen for it and every href it has shown. */
interface FeedPost {
  key: number;
  text: string;
  hrefs: string[];
  sponsored: boolean;
}

const MORE_COMMENTS_RE =/^(view|see|show)\s+(\d+\s+|all\s+|more\s+)?(more\s+)?(comments?|replies)\b|^\d+\s+(more\s+)?(comments|replies)$/i;

// ---------------------------------------------------------------------------
// LLM schemas and prompts
// ---------------------------------------------------------------------------

const PostFields = {
  author: z.string().nullable().describe("The poster's name as shown (a person or a page); null when not shown"),
  community: z.string().nullable().describe("The group or page the post was published in, when the post shows one; else null"),
  text: z.string().describe("The post's own text; not the comments, reactions or 'See more' labels"),
  created_at: z.string().nullable().describe("ISO 8601 date when a full date is shown; null for relative times like '3h'"),
  likes: z.number().nullable().describe("Reaction count shown, else null"),
  comments: z.number().nullable().describe("Comment count shown, else null"),
  shares: z.number().nullable().describe("Share count shown, else null"),
};

export const FacebookSearchExtractionSchema = z.object({
  posts: z.array(
    z.object({
      ...PostFields,
      post: z.number().nullable().describe("The number n of the 'Post [n]' block this record was read from; null when the text has no such blocks"),
    }),
  ),
});
export type FacebookSearchExtraction = z.infer<typeof FacebookSearchExtractionSchema>;

export const FacebookThreadExtractionSchema = z.object({
  post: z.object(PostFields).nullable().describe("The main post on the page; null when none is visible"),
  comments: z.array(
    z.object({
      author: z.string().nullable().describe("The commenter's name as shown"),
      text: z.string().describe("The comment's text"),
      created_at: z.string().nullable().describe("ISO 8601 date when a full date is shown, else null"),
      likes: z.number().nullable().describe("Reaction count shown, else null"),
      replies: z.number().nullable().describe("Reply count shown, else null"),
    }),
  ),
});
export type FacebookThreadExtraction = z.infer<typeof FacebookThreadExtractionSchema>;

const SEARCH_SYSTEM_PROMPT = [
  "You read the visible text of a Facebook search results page and return the posts on it as structured records.",
  "The text is the only source of truth. Never use outside knowledge.",
  "Rules:",
  "- The text is split into 'Post [n]' blocks, one per result on the page. Return one entry per real post, with post set to its block's n.",
  "- Skip blocks marked sponsored, adverts, navigation, filters, 'People also search for' and 'Suggested' boxes.",
  "- author is the poster's name as printed. community is the group or page a post was shared in when the header says so ('Group · Join' then the poster, or 'Name > Group'), else null.",
  "- text is the post's own text; drop 'See more', 'Like', 'Comment', 'Share', 'Join', 'Follow', 'Comment as ...' labels and reaction lines.",
  "- Counts: '1.2K' is 1200; null when not shown.",
  "- created_at only when a full date is printed; relative times are null.",
  "- Do not invent anything the text does not state.",
].join("\n");

const THREAD_SYSTEM_PROMPT = [
  "You read the visible text of one Facebook post page and return the post and its comments as structured records.",
  "The text is the only source of truth. Never use outside knowledge.",
  "Rules:",
  "- post is the main post (author, text, counts). comments are the comments shown below it, in page order, including replies to comments.",
  "- Skip 'Write a comment', 'Most relevant', 'View more comments' and similar controls, and anything from a sidebar or 'Related' box.",
  "- Counts: '1.2K' is 1200; null when not shown. created_at only when a full date is printed.",
  "- Do not invent anything the text does not state.",
].join("\n");

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export function createFacebookSearchRecipe(options: SocialRecipeOptions = {}): SocialRecipe {
  const o = resolveOptions(options);

  const buildUrl = (q: SocialSearchQuery): string | null => {
    if (q.mode === "thread") {
      const canonical = q.url === undefined ? undefined : canonicalFacebookPostUrl(q.url);
      return canonical === undefined ? null : rebase(canonical, FACEBOOK_ORIGIN, o.baseUrl);
    }
    return q.query === undefined ? null : buildFacebookSearchUrl(q, o.baseUrl);
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

  const searchStatus = (status: number): RecipeError | undefined => {
    if (status === 404) {
      return new RecipeError("blocked", "Facebook answers HTTP 404 to anonymous visitors of search; run accounts connect facebook", {
        retryable: false,
        needsLogin: true,
      });
    }
    return defaultStatusError(SITE_NAME, status);
  };

  const threadStatus = (status: number): RecipeError | undefined => {
    if (status === 404) return new RecipeError("provider", "Facebook answered HTTP 404: the post does not exist or is not visible to this account", { retryable: false });
    return defaultStatusError(SITE_NAME, status);
  };

  async function search(page: Page, q: SocialSearchQuery, ctx: RecipeContext, guard: TimeGuard, caveat: (m: string) => void): Promise<SocialItem[]> {
    if (q.query === undefined) throw new RecipeError("invalid_input", "Facebook search needs a query");
    if (q.recency !== undefined) caveat("Facebook search has no date filter in its URL; the recency filter was not applied to Facebook results.");
    const url = buildFacebookSearchUrl(q, o.baseUrl);
    // Permalinks from the page's own data: the document and the GraphQL responses that load more results.
    const dataLinks: string[] = [];
    const reads: Promise<void>[] = [];
    const onResponse = (r: PageResponse): void => {
      const isData = r.request().resourceType() === "document" || /\/api\/graphql\/?(?:[?#]|$)/.test(r.url());
      if (!isData || r.status() >= 400) return;
      reads.push(
        r.text().then(
          (body) => {
            for (const link of permalinksFromBody(body)) if (!dataLinks.includes(link)) dataLinks.push(link);
          },
          () => undefined,
        ),
      );
    };
    page.on("response", onResponse);
    const posts = new Map<number, FeedPost>();
    let pageText = "";
    try {
      await navigateTo(page, url, ctx, { site: SITE_NAME, guard, onStatus: searchStatus });
      const state = await waitForContent(page, ctx, guard, "search");
      if (state === "empty") {
        caveat(`Facebook showed no posts for "${q.query}".`);
        return [];
      }
      const capture = async (): Promise<void> => {
        const c = await page.evaluate<FeedCapture>(FEED_CAPTURE_JS).catch(() => undefined);
        if (c === undefined) return;
        if (c.text !== "" && c.text.length > pageText.length) pageText = c.text;
        for (const p of c.posts) {
          const hrefs = p.hrefs.map((h) => unrebase(h, FACEBOOK_ORIGIN, o.baseUrl));
          const text = cleanFacebookText(p.text);
          const seen = posts.get(p.key);
          posts.set(p.key, {
            key: p.key,
            text: seen !== undefined && seen.text.length >= text.length ? seen.text : text,
            hrefs: [...new Set([...(seen?.hrefs ?? []), ...hrefs])],
            sponsored: (seen?.sponsored ?? false) || looksSponsored(p.text, hrefs),
          });
        }
      };
      // Enough when per_platform organic posts have been read; a virtualised feed forgets the ones scrolled past.
      const enough = (): boolean => [...posts.values()].filter((p) => !p.sponsored && p.text.length >= 40).length >= q.per_platform;
      await capture();
      // At the end when two steps in a row neither moved the page nor made it taller.
      let still = 0;
      let steps = 0;
      let where = "";
      for (; steps < o.maxScrolls * STEPS_PER_SCROLL && !enough(); steps++) {
        guard.check("while scrolling");
        const now = await page.evaluate<string>(STEP_JS).catch((err: unknown) => {
          ctx.log.debug("facebook: scroll step failed", { error: firstLine(err) });
          return where;
        });
        await sleep(Math.min(o.settleMs, Math.max(0, guard.remaining() - 500)));
        await capture();
        still = now === where ? still + 1 : 0;
        where = now;
        if (still >= 2) break;
      }
      ctx.log.debug("facebook: scrolled", { steps, at_end: still >= 2, enough: enough() });
      await Promise.race([Promise.allSettled(reads), sleep(Math.min(2000, Math.max(0, guard.remaining() - 500)))]);
    } finally {
      page.off("response", onResponse);
    }
    guard.check("before extraction");

    const ordered = [...posts.values()].sort((a, b) => a.key - b.key).filter((p) => p.text !== "");
    const links = assignPermalinks(
      ordered.map((p) => facebookPostRefs(p.hrefs)),
      dataLinks,
    );
    ctx.log.debug("facebook: results read", {
      posts: ordered.length,
      sponsored: ordered.filter((p) => p.sponsored).length,
      data_permalinks: dataLinks.length,
      linked: links.filter((l) => l !== undefined).length,
    });
    const blocks: string[] = [];
    let budget = FACEBOOK_TEXT_MAX_CHARS;
    for (const [n, p] of ordered.entries()) {
      if (budget <= 0) break;
      const body = p.text.slice(0, Math.min(POST_TEXT_MAX_CHARS, budget));
      budget -= body.length;
      blocks.push(`Post [${n}]${p.sponsored ? " (Facebook marks this post as sponsored)" : ""}:\n${body}`);
    }
    const content =
      blocks.length > 0
        ? [`Search: "${q.query}" on Facebook (posts).`, "", "The results, one block per result, in page order:", "", blocks.join("\n\n")]
        : [`Search: "${q.query}" on Facebook (posts).`, "", "Visible text of the results:", cleanFacebookText(pageText).slice(0, FACEBOOK_TEXT_MAX_CHARS)];
    const extraction = await extractWithLlm(ctx, {
      site: SITE_NAME,
      system: SEARCH_SYSTEM_PROMPT,
      content: content.join("\n"),
      schema: FacebookSearchExtractionSchema,
    });
    let missingLink = false;
    const linked = new Set<string>();
    const candidates = extraction.posts.map((p) => {
      const found = p.post === null ? undefined : links[p.post];
      // Two records from one block share no link: the second gets the search page.
      const link = found !== undefined && !linked.has(found) ? found : undefined;
      if (link !== undefined) linked.add(link);
      if (link === undefined) missingLink = true;
      const { text, truncated } = clipText(p.text);
      return compact({
        id: `facebook:${link !== undefined ? facebookIdFromUrl(link) : shortHash(`${p.author ?? ""}\n${p.text}`)}`,
        platform: "facebook",
        kind: "post",
        url: link ?? url,
        author: safeAuthor(p.author),
        community: p.community?.trim() || undefined,
        text,
        truncated,
        created_at: toIso(p.created_at),
        score: p.likes ?? undefined,
        replies: p.comments ?? undefined,
        reposts: p.shares ?? undefined,
      });
    });
    const items = validateItems(candidates, ctx, SITE_NAME);
    if (missingLink && items.length > 0) caveat("Some Facebook posts had no permalink on the results page; their url is the search page.");
    return items.slice(0, q.per_platform);
  }

  async function thread(page: Page, q: SocialSearchQuery, ctx: RecipeContext, guard: TimeGuard, caveat: (m: string) => void): Promise<SocialItem[]> {
    const canonical = q.url === undefined ? undefined : canonicalFacebookPostUrl(q.url);
    if (canonical === undefined) throw new RecipeError("invalid_input", `not a Facebook post URL: ${q.url ?? "(none)"}`);
    await navigateTo(page, rebase(canonical, FACEBOOK_ORIGIN, o.baseUrl), ctx, { site: SITE_NAME, guard, onStatus: threadStatus });
    const state = await waitForContent(page, ctx, guard, "thread");
    if (state === "empty") {
      caveat("Facebook showed nothing at that URL.");
      return [];
    }
    await expandComments(page, ctx, guard, caveat);
    for (let i = 0; i < o.maxScrolls; i++) {
      guard.check("while scrolling");
      await scrollDown(page, Math.min(o.settleMs, Math.max(0, guard.remaining() - 500)));
    }
    guard.check("before extraction");
    const text = cleanFacebookText(await page.evaluate<string>(THREAD_TEXT_JS)).slice(0, FACEBOOK_TEXT_MAX_CHARS);
    const extraction = await extractWithLlm(ctx, {
      site: SITE_NAME,
      system: THREAD_SYSTEM_PROMPT,
      content: [`Post page: ${canonical}`, "", "Visible text of the page:", text].join("\n"),
      schema: FacebookThreadExtractionSchema,
    });
    const postId = facebookIdFromUrl(canonical);
    const candidates: Record<string, unknown>[] = [];
    if (extraction.post !== null) {
      const { text, truncated } = clipText(extraction.post.text);
      candidates.push(
        compact({
          id: `facebook:${postId}`,
          platform: "facebook",
          kind: "post",
          url: canonical,
          author: safeAuthor(extraction.post.author),
          community: extraction.post.community?.trim() || undefined,
          text,
          truncated,
          created_at: toIso(extraction.post.created_at),
          score: extraction.post.likes ?? undefined,
          replies: extraction.post.comments ?? undefined,
          reposts: extraction.post.shares ?? undefined,
        }),
      );
    } else {
      caveat("The Facebook post itself could not be read; only comments are returned.");
    }
    for (const c of extraction.comments.slice(0, q.per_platform)) {
      const { text, truncated } = clipText(c.text);
      candidates.push(
        compact({
          id: `facebook:${postId}:${shortHash(`${c.author ?? ""}\n${c.text}`)}`,
          platform: "facebook",
          kind: "comment",
          url: canonical,
          author: safeAuthor(c.author),
          text,
          truncated,
          created_at: toIso(c.created_at),
          score: c.likes ?? undefined,
          replies: c.replies ?? undefined,
          parent_url: canonical,
        }),
      );
    }
    return validateItems(candidates, ctx, SITE_NAME);
  }

  /**
   * Wait for content; walls throw; "empty" when the page says there is nothing.
   * A search waits for a feed result with text, and takes other text or links
   * only after `FEED_GRACE_MS`; a post page takes text or links at once.
   */
  async function waitForContent(page: Page, ctx: RecipeContext, guard: TimeGuard, mode: "search" | "thread"): Promise<"results" | "empty"> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(o.maxResultsWaitMs, guard.remaining() * 0.6));
    let last: FacebookProbe | undefined;
    for (;;) {
      guard.check("while waiting for content");
      const probe = await runProbe<FacebookProbe>(page, FB_PROBE_JS);
      if (probe !== undefined) {
        last = probe;
        const wall = classifyWall(probe, WALL_RULES);
        if (wall !== undefined) throw wall;
        if (NO_RESULTS_RE.test(probe.text)) return "empty";
        if (mode === "search" && probe.feedPosts > 0) return "results";
        const settled = mode === "thread" || Date.now() - start >= Math.min(FEED_GRACE_MS, budget / 2);
        if (settled && (probe.permalinks > 0 || probe.mainTextLength > 200)) return "results";
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `no content appeared on Facebook within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(o.pollMs);
    }
  }

  /** Click "View more comments" style controls at most twice. Read-only: it only reveals what is already public to this account. */
  async function expandComments(page: Page, ctx: RecipeContext, guard: TimeGuard, caveat: (m: string) => void): Promise<void> {
    const button = page.getByRole("button", { name: MORE_COMMENTS_RE }).first();
    for (let i = 0; i < 2; i++) {
      guard.check("while expanding comments");
      try {
        if ((await button.count()) === 0) return;
        await button.click({ timeout: 3000 });
        await sleep(Math.min(o.settleMs, Math.max(0, guard.remaining() - 500)));
      } catch (err) {
        ctx.log.debug("facebook: could not expand more comments", { error: firstLine(err) });
        return;
      }
    }
    try {
      if ((await button.count()) > 0) caveat("Facebook still offers more comments after two expansions; the comment list may be incomplete.");
    } catch {
      // ignore
    }
  }

  return {
    site: FACEBOOK_SITE,
    paramsSchema: SocialSearchQuerySchema,
    resultSchema: z.array(SocialItemSchema),
    buildUrl,
    run,
  };
}

/** The recipe against live Facebook. */
export const facebookSearchRecipe: SocialRecipe = createFacebookSearchRecipe();
