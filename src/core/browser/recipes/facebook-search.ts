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
 * schema-driven LLM over the visible text of the results region (role=main or
 * role=feed, else the body) after at most 3 scrolls, cut to about 30,000
 * characters. Item URLs come from permalink anchors found by a probe
 * (`/posts/`, `/permalink/`, `/videos/`, `story_fbid`, `/reel/`); when the model
 * cannot point at one, the item carries the search URL and a caveat says so.
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
    const m = /\/(?:posts|permalink|videos|reel)\/(?:pfbid)?([A-Za-z0-9]+)/.exec(u.pathname);
    if (m !== null) return m[1] as string;
  } catch {
    // fall through
  }
  return shortHash(url);
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface FacebookProbe extends BasicProbe {
  /** Visible text length of the results region (role=main or role=feed). */
  mainTextLength: number;
  permalinks: number;
}

const PERMALINK_SELECTOR = 'a[href*="/posts/"], a[href*="/permalink"], a[href*="/videos/"], a[href*="story_fbid="], a[href*="/reel/"]';

const FB_PROBE_JS = probeScript(`
  const main = document.querySelector('[role="main"], [role="feed"]');
  return {
    mainTextLength: main ? (main.innerText || "").length : 0,
    permalinks: document.querySelectorAll('${PERMALINK_SELECTOR}').length,
  };
`);

interface FacebookCapture {
  text: string;
  permalinks: string[];
}

const CAPTURE_JS = `(() => {
  const main = document.querySelector('[role="main"], [role="feed"]') || document.body;
  const text = main ? (main.innerText || "") : "";
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('${PERMALINK_SELECTOR}')) {
    const href = a.getAttribute("href") || "";
    if (!href) continue;
    let abs;
    try { abs = new URL(href, location.href).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    links.push(abs);
  }
  return { text: text.slice(0, ${FACEBOOK_TEXT_MAX_CHARS}), permalinks: links };
})()`;

const MORE_COMMENTS_RE = /^(view|see|show)\s+(\d+\s+|all\s+|more\s+)?(more\s+)?(comments?|replies)\b|^\d+\s+(more\s+)?(comments|replies)$/i;

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
      permalink: z.number().nullable().describe("Index [n] of the permalink in the list that belongs to this post, when one clearly does; else null"),
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
  "- One entry per post. Skip navigation, filters, 'People also search for', adverts and 'Suggested' boxes.",
  "- author is the poster's name as printed. community is the group or page a post was shared in when the header says so ('Name > Group'), else null.",
  "- text is the post's own text; drop 'See more', 'Like', 'Comment', 'Share' labels and reaction lines.",
  "- Counts: '1.2K' is 1200; null when not shown.",
  "- created_at only when a full date is printed; relative times are null.",
  "- permalink is the index of the listed permalink that belongs to the post when the order or text makes that clear; otherwise null. Never guess.",
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
    await navigateTo(page, url, ctx, { site: SITE_NAME, guard, onStatus: searchStatus });
    const state = await waitForContent(page, ctx, guard);
    if (state === "empty") {
      caveat(`Facebook showed no posts for "${q.query}".`);
      return [];
    }
    for (let i = 0; i < o.maxScrolls; i++) {
      guard.check("while scrolling");
      await scrollDown(page, Math.min(o.settleMs, Math.max(0, guard.remaining() - 500)));
    }
    guard.check("before extraction");
    const capture = await page.evaluate<FacebookCapture>(CAPTURE_JS);
    const permalinks = [
      ...new Set(
        capture.permalinks
          .map((p) => canonicalFacebookPostUrl(unrebase(p, FACEBOOK_ORIGIN, o.baseUrl)))
          .filter((p): p is string => p !== undefined),
      ),
    ];
    const extraction = await extractWithLlm(ctx, {
      site: SITE_NAME,
      system: SEARCH_SYSTEM_PROMPT,
      content: [
        `Search: "${q.query}" on Facebook (posts).`,
        "",
        permalinks.length === 0 ? "Permalinks found on the page: none." : "Permalinks found on the page, in page order:",
        ...permalinks.map((p, i) => `[${i}] ${p}`),
        "",
        "Visible text of the results:",
        capture.text,
      ].join("\n"),
      schema: FacebookSearchExtractionSchema,
    });
    let missingLink = false;
    const candidates = extraction.posts.map((p) => {
      const link = p.permalink === null ? undefined : permalinks[p.permalink];
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
    const state = await waitForContent(page, ctx, guard);
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
    const capture = await page.evaluate<FacebookCapture>(CAPTURE_JS);
    const extraction = await extractWithLlm(ctx, {
      site: SITE_NAME,
      system: THREAD_SYSTEM_PROMPT,
      content: [`Post page: ${canonical}`, "", "Visible text of the page:", capture.text].join("\n"),
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

  /** Wait for the results region to carry text or permalinks; walls throw; "empty" when the page says there is nothing. */
  async function waitForContent(page: Page, ctx: RecipeContext, guard: TimeGuard): Promise<"results" | "empty"> {
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
        if (probe.permalinks > 0 || probe.mainTextLength > 200) return "results";
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
