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
  navigateTo,
  parseCount,
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
  validateItems,
  type SocialRecipe,
  type SocialRecipeOptions,
  type WallRules,
} from "./social-common.js";

/**
 * X (Twitter) recipe, PLAN.md 14.5 (WP18b). Browser only, through the owner's
 * logged-in profile; personal low-volume use, against X's terms (PLAN.md 14.0).
 *
 * URLs:
 *   search  https://x.com/search?q=<q>&src=typed_query&f=top   (sort engagement)
 *           https://x.com/search?q=<q>&src=typed_query&f=live  (sort recent)
 *           `lang` appends " lang:<lang>" and `recency` appends " since:YYYY-MM-DD"
 *           to the query (X's own search operators).
 *   thread  https://x.com/<handle>/status/<id>; replies are the articles below it.
 *
 * Logged-out behaviour seen live on 2026-10-18 from a cloud IP:
 *   - curl on the search URL: HTTP 307 to
 *     https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fsearch...&mode=login
 *   - headless Chromium on the search URL and on /i/flow/login: HTTP 403 with an
 *     empty body (X's anti-automation answer to a cookie-less browser).
 *   So a login wall is detected by URL (/i/flow/login, /login, mode=login,
 *   /i/jf/onboarding) or by a visible password field, and reported as `blocked`
 *   with `needsLogin: true`; the 403 is `blocked` without `needsLogin` and the
 *   message still points at `accounts connect x`.
 *
 * Page structure (X's long-stable test ids): posts are `article[data-testid="tweet"]`;
 * text in `[data-testid="tweetText"]` (with a `lang` attribute); the author block
 * `[data-testid="User-Name"]` holds a link whose text starts with "@"; a
 * `time[datetime]` sits in a link to `/<handle>/status/<id>`; the metric buttons
 * `[data-testid="reply"|"retweet"|"like"]` (or `unretweet`/`unlike` once the owner
 * interacted) carry the count in `aria-label` ("1,234 Likes. Like") and a short
 * form in their text ("1.2K"). Below a status page's replies X appends a
 * "Discover more" section of unrelated posts, which the thread mode drops.
 *
 * Extraction: deterministic DOM probe first, validated against SocialItemSchema;
 * when fewer than 3 items validate, schema-driven LLM extraction over each
 * article's inner text, assembled in code.
 */

export const X_SITE = "x_search";
export const X_ORIGIN = "https://x.com";
const SITE_NAME = "X";

const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

const WALL_RULES: WallRules = {
  site: SITE_NAME,
  platform: "x",
  loginUrl: /\/i\/flow\/login|\/login(?:[/?#]|$)|[?&]mode=login\b|\/i\/jf\/onboarding/i,
  loginText: /^\s*(sign in to x|log in to x)\b/i,
};

const NO_RESULTS_RE = /\bno results for\b|try searching for something else/i;
/** Minimum items the DOM probe must yield before the LLM fallback is skipped. */
export const MIN_PROBE_ITEMS = 3;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const RECENCY_DAYS: Record<NonNullable<SocialSearchQuery["recency"]>, number> = { day: 1, week: 7, month: 30, year: 365 };

export function sinceDate(recency: NonNullable<SocialSearchQuery["recency"]>, now: number = Date.now()): string {
  return new Date(now - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
}

export function buildXSearchUrl(q: SocialSearchQuery, baseUrl?: string, now: number = Date.now()): string {
  let text = q.query ?? "";
  if (q.lang !== undefined) text += ` lang:${q.lang}`;
  if (q.recency !== undefined) text += ` since:${sinceDate(q.recency, now)}`;
  const params = new URLSearchParams({ q: text, src: "typed_query", f: q.sort === "recent" ? "live" : "top" });
  return rebase(`${X_ORIGIN}/search?${params.toString()}`, X_ORIGIN, baseUrl);
}

export interface XPostRef {
  handle: string;
  id: string;
  /** Canonical https://x.com/<handle>/status/<id>. */
  url: string;
}

/** Parse a post URL on x.com or twitter.com; undefined for anything else. */
export function parseXPostUrl(url: string): XPostRef | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return undefined;
  const m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/.exec(u.pathname);
  if (m === null) return undefined;
  const handle = m[1] as string;
  const id = m[2] as string;
  return { handle, id, url: `${X_ORIGIN}/${handle}/status/${id}` };
}

export function isXUrl(url: string): boolean {
  return parseXPostUrl(url) !== undefined;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface XProbe extends BasicProbe {
  tweets: number;
  /** A "Sign in" / "Log in" call to action is shown (X shows one on every logged-out page). */
  loginPrompt: boolean;
}

const X_PROBE_JS = probeScript(`
  return {
    tweets: document.querySelectorAll('article[data-testid="tweet"]').length,
    loginPrompt: !!document.querySelector('[data-testid="loginButton"], a[href="/login"], a[href^="/i/flow/login"], [data-testid="LoginForm_Login_Button"]'),
  };
`);

interface Metric {
  label: string;
  text: string;
}

interface RawTweet {
  text: string;
  lang: string;
  handle: string;
  datetime: string;
  href: string;
  replies: Metric | null;
  reposts: Metric | null;
  likes: Metric | null;
  /** The article's visible text, for the LLM fallback. */
  inner: string;
  /** Below the "Discover more" heading on a status page: unrelated to the thread. */
  afterDiscover: boolean;
}

const TWEETS_JS = `(() => {
  const out = [];
  const discover = Array.from(document.querySelectorAll("h2")).find((h) => /discover more/i.test(h.textContent || ""));
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    const textEl = a.querySelector('[data-testid="tweetText"]');
    const user = a.querySelector('[data-testid="User-Name"]');
    let handle = "";
    if (user) {
      for (const link of user.querySelectorAll('a[href^="/"]')) {
        const t = (link.textContent || "").trim();
        if (t.startsWith("@")) { handle = t.slice(1); break; }
      }
    }
    const time = a.querySelector("time[datetime]");
    const timeLink = time ? time.closest('a[href*="/status/"]') : null;
    let href = timeLink ? (timeLink.getAttribute("href") || "") : "";
    if (!href) {
      const any = a.querySelector('a[href*="/status/"]');
      href = any ? (any.getAttribute("href") || "") : "";
    }
    const metric = (ids) => {
      for (const id of ids) {
        const b = a.querySelector('[data-testid="' + id + '"]');
        if (b) return { label: b.getAttribute("aria-label") || "", text: (b.textContent || "").trim() };
      }
      return null;
    };
    out.push({
      text: textEl ? (textEl.innerText || "") : "",
      lang: textEl ? (textEl.getAttribute("lang") || "") : "",
      handle,
      datetime: time ? (time.getAttribute("datetime") || "") : "",
      href,
      replies: metric(["reply"]),
      reposts: metric(["retweet", "unretweet"]),
      likes: metric(["like", "unlike"]),
      inner: (a.innerText || "").slice(0, 3000),
      afterDiscover: discover ? !!(discover.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
    });
  }
  return out;
})()`;

const STATUS_HREF_RE = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/;

/** The count in a metric button: the aria-label's full number first ("1,234 Likes"), then the short text ("1.2K"); 0 when the button shows none. */
export function metricCount(m: Metric | null): number | undefined {
  if (m === null) return undefined;
  return parseCount(m.label) ?? parseCount(m.text) ?? 0;
}

interface ItemOptions {
  kind: SocialItem["kind"];
  parentUrl?: string;
}

/** Deterministic mapping of one probed article. Undefined when it has no status link (nothing to identify it by). */
export function tweetToCandidate(raw: RawTweet, o: ItemOptions): Record<string, unknown> | undefined {
  const m = STATUS_HREF_RE.exec(raw.href);
  if (m === null) return undefined;
  const hrefHandle = m[1] as string;
  const id = m[2] as string;
  const handle = raw.handle !== "" ? raw.handle : hrefHandle;
  const { text, truncated } = clipText(raw.text);
  return compact({
    id: `x:${id}`,
    platform: "x",
    kind: o.kind,
    url: `${X_ORIGIN}/${hrefHandle}/status/${id}`,
    author: safeAuthor(`@${handle}`),
    text,
    truncated,
    created_at: toIso(raw.datetime),
    score: metricCount(raw.likes),
    replies: metricCount(raw.replies),
    reposts: metricCount(raw.reposts),
    lang: raw.lang !== "" ? raw.lang : undefined,
    parent_url: o.parentUrl,
  });
}

// ---------------------------------------------------------------------------
// LLM fallback
// ---------------------------------------------------------------------------

export const XExtractionSchema = z.object({
  posts: z.array(
    z.object({
      item: z.number().describe("Index [n] of the block this post was read from"),
      handle: z.string().nullable().describe("The author's @handle without the @, exactly as printed; null when none is shown"),
      text: z.string().describe("The post's own text, not the text of a quoted post or of the author's name line"),
      created_at: z.string().nullable().describe("ISO 8601 date-time when the block shows a full date, else null; never guess"),
      replies: z.number().nullable().describe("Reply count shown, else null"),
      reposts: z.number().nullable().describe("Repost count shown, else null"),
      likes: z.number().nullable().describe("Like count shown, else null"),
    }),
  ),
});
export type XExtraction = z.infer<typeof XExtractionSchema>;

const SYSTEM_PROMPT = [
  "You read the visible text of posts on X (Twitter) and return structured records.",
  "Each numbered block is one post as the page shows it; a block may start with a line 'status: /handle/status/id' giving its link. The blocks are the only source of truth.",
  "Rules:",
  "- One entry per block that contains a post, with item set to the block's [n]. Skip blocks that are adverts, 'Who to follow' boxes or empty.",
  "- handle is the @handle printed in the author line, without the @; null when none.",
  "- text is the post's own text only; do not include the author line, the date, metric numbers or a quoted post's text.",
  "- Counts: 1.2K means 1200, 3M means 3000000. null when a count is not shown.",
  "- created_at only when a full date is visible; relative times like '3h' are null.",
  "- Never invent anything the block does not state.",
].join("\n");

/** Turn LLM output into candidates, using the probed status links for id and url when the block had one. */
export function assembleFromLlm(
  extraction: XExtraction,
  raws: readonly RawTweet[],
  o: ItemOptions & { fallbackUrl: string },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of extraction.posts) {
    const raw = raws[p.item];
    if (raw === undefined) continue;
    const m = STATUS_HREF_RE.exec(raw.href);
    const { text, truncated } = clipText(p.text);
    const handle = p.handle?.replace(/^@/, "").trim() ?? "";
    const author = handle !== "" ? `@${handle}` : m !== null ? `@${m[1] as string}` : undefined;
    out.push(
      compact({
        id: m !== null ? `x:${m[2] as string}` : `x:${shortHash(raw.inner)}`,
        platform: "x",
        kind: o.kind,
        url: m !== null ? `${X_ORIGIN}/${m[1] as string}/status/${m[2] as string}` : o.fallbackUrl,
        author: safeAuthor(author),
        text,
        truncated,
        created_at: toIso(raw.datetime) ?? toIso(p.created_at),
        score: p.likes ?? undefined,
        replies: p.replies ?? undefined,
        reposts: p.reposts ?? undefined,
        lang: raw.lang !== "" ? raw.lang : undefined,
        parent_url: o.parentUrl,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export function createXSearchRecipe(options: SocialRecipeOptions = {}): SocialRecipe {
  const o = resolveOptions(options);

  const buildUrl = (q: SocialSearchQuery): string | null => {
    if (q.mode === "thread") {
      const ref = q.url === undefined ? undefined : parseXPostUrl(q.url);
      return ref === undefined ? null : rebase(ref.url, X_ORIGIN, o.baseUrl);
    }
    return q.query === undefined ? null : buildXSearchUrl(q, o.baseUrl);
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

  const onStatus = (status: number): RecipeError | undefined => {
    if (status === 403) {
      return new RecipeError(
        "blocked",
        "X answered HTTP 403 to this browser (it blocks anonymous and automated visitors); if the profile is not logged in, run accounts connect x",
        { retryable: false },
      );
    }
    if (status === 404) return new RecipeError("provider", "X answered HTTP 404: the post does not exist or was removed", { retryable: false });
    return defaultStatusError(SITE_NAME, status);
  };

  async function search(
    page: Page,
    q: SocialSearchQuery,
    ctx: RecipeContext,
    guard: ReturnType<typeof timeGuard>,
    caveat: (m: string) => void,
  ): Promise<SocialItem[]> {
    if (q.query === undefined) throw new RecipeError("invalid_input", "X search needs a query");
    const url = buildXSearchUrl(q, o.baseUrl);
    await navigateTo(page, url, ctx, { site: SITE_NAME, guard, onStatus });
    const state = await waitForTweets(page, ctx, guard);
    if (state === "empty") {
      caveat(`X showed no posts for "${q.query}".`);
      return [];
    }
    await scrollFor(page, q.per_platform, guard);
    guard.check("before extraction");
    const raws = await page.evaluate<RawTweet[]>(TWEETS_JS);
    const items = await extract(raws, { kind: "post", fallbackUrl: url }, ctx, caveat);
    return items.slice(0, q.per_platform);
  }

  async function thread(
    page: Page,
    q: SocialSearchQuery,
    ctx: RecipeContext,
    guard: ReturnType<typeof timeGuard>,
    caveat: (m: string) => void,
  ): Promise<SocialItem[]> {
    const ref = q.url === undefined ? undefined : parseXPostUrl(q.url);
    if (ref === undefined) throw new RecipeError("invalid_input", `not an X post URL: ${q.url ?? "(none)"}`);
    await navigateTo(page, rebase(ref.url, X_ORIGIN, o.baseUrl), ctx, { site: SITE_NAME, guard, onStatus });
    const state = await waitForTweets(page, ctx, guard);
    if (state === "empty") {
      caveat("X showed no post at that URL.");
      return [];
    }
    await scrollFor(page, q.per_platform + 1, guard);
    guard.check("before extraction");
    const all = await page.evaluate<RawTweet[]>(TWEETS_JS);
    const raws = all.filter((r) => !r.afterDiscover);
    if (raws.length < all.length) caveat("Posts under X's \"Discover more\" section were ignored as unrelated to the thread.");
    // The focused post is the article whose status link carries the requested id; earlier articles are ancestors.
    let focus = raws.findIndex((r) => STATUS_HREF_RE.exec(r.href)?.[2] === ref.id);
    if (focus < 0) focus = 0;
    const postRaw = raws[focus];
    const replyRaws = raws.slice(focus + 1);
    const post = postRaw === undefined ? [] : await extract([postRaw], { kind: "post", fallbackUrl: ref.url }, ctx, caveat);
    const comments =
      replyRaws.length === 0 ? [] : await extract(replyRaws, { kind: "comment", parentUrl: ref.url, fallbackUrl: ref.url }, ctx, caveat);
    const postItem = post[0];
    if (postItem === undefined) {
      caveat("The post itself could not be read; only replies are returned.");
      return comments.slice(0, q.per_platform);
    }
    return [{ ...postItem, id: `x:${ref.id}`, url: ref.url }, ...comments.filter((c) => c.id !== postItem.id).slice(0, q.per_platform)];
  }

  /** Wait until articles appear, or the page says there are none, or a wall shows; `timeout` when nothing happens. */
  async function waitForTweets(page: Page, ctx: RecipeContext, guard: ReturnType<typeof timeGuard>): Promise<"results" | "empty"> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(o.maxResultsWaitMs, guard.remaining() * 0.6));
    let last: XProbe | undefined;
    for (;;) {
      guard.check("while waiting for posts");
      const probe = await runProbe<XProbe>(page, X_PROBE_JS);
      if (probe !== undefined) {
        last = probe;
        const wall = classifyWall(probe, WALL_RULES);
        if (wall !== undefined) throw wall;
        if (probe.tweets > 0) return "results";
        if (NO_RESULTS_RE.test(probe.text)) return "empty";
      }
      if (Date.now() - start >= budget) {
        if (last !== undefined && last.loginPrompt && last.tweets === 0) {
          throw new RecipeError("blocked", "X showed a login prompt instead of posts; run accounts connect x", {
            retryable: false,
            needsLogin: true,
          });
        }
        throw new RecipeError("timeout", `no posts appeared on X within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(o.pollMs);
    }
  }

  async function scrollFor(page: Page, wanted: number, guard: ReturnType<typeof timeGuard>): Promise<void> {
    for (let i = 0; i < o.maxScrolls; i++) {
      guard.check("while scrolling");
      const count = (await runProbe<XProbe>(page, X_PROBE_JS))?.tweets ?? 0;
      if (count >= wanted) return;
      await scrollDown(page, Math.min(o.settleMs, Math.max(0, guard.remaining() - 500)));
    }
  }

  async function extract(
    raws: RawTweet[],
    io: ItemOptions & { fallbackUrl: string },
    ctx: RecipeContext,
    caveat: (m: string) => void,
  ): Promise<SocialItem[]> {
    const deterministic = validateItems(
      raws.map((r) => tweetToCandidate(r, io)).filter((c): c is Record<string, unknown> => c !== undefined),
      ctx,
      SITE_NAME,
    );
    if (deterministic.length >= MIN_PROBE_ITEMS || raws.length === 0 || deterministic.length === raws.length) return deterministic;

    ctx.log.info("x: DOM probe found too few posts, falling back to LLM extraction", { probed: raws.length, validated: deterministic.length });
    const blocks = raws.map((r, i) => {
      const link = STATUS_HREF_RE.exec(r.href);
      const head = link !== null ? `status: ${link[0]}\n` : "";
      return `[${i}]\n${head}${r.inner}`;
    });
    const extraction = await extractWithLlm(ctx, {
      site: SITE_NAME,
      system: SYSTEM_PROMPT,
      content: ["Posts visible on an X page, one block per post:", "", ...blocks].join("\n"),
      schema: XExtractionSchema,
    });
    const fromLlm = validateItems(assembleFromLlm(extraction, raws, io), ctx, SITE_NAME);
    if (fromLlm.length === 0) return deterministic;
    caveat("X posts were read by the model from the page text, so counts and dates may be approximate.");
    // Prefer the deterministic record where both exist (exact metrics), keep the model's for the rest.
    const byId = new Map<string, SocialItem>(fromLlm.map((i) => [i.id, i]));
    for (const d of deterministic) byId.set(d.id, d);
    return [...byId.values()];
  }

  return {
    site: X_SITE,
    paramsSchema: SocialSearchQuerySchema,
    resultSchema: z.array(SocialItemSchema),
    buildUrl,
    run,
  };
}

/** The recipe against live X. */
export const xSearchRecipe: SocialRecipe = createXSearchRecipe();
