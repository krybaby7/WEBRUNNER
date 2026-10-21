import type { Page } from "playwright";
import { NormalizedReviewsQuerySchema, type NormalizedReviewsQuery } from "../../../schemas/reviews.js";
import {
  BASIC_PROBE_FIELDS_JS,
  CONSENT_CAVEAT,
  MIN_PROBE_REVIEWS,
  ReviewSearchResultSchema,
  SubjectNotFoundError,
  assembleReview,
  assembleSubject,
  blockedReason,
  caveatSink,
  dedupeReviews,
  dismissConsent,
  errMsg,
  extractReviewsWithLlm,
  mergeSubject,
  navigateTo,
  reviewsFromExtraction,
  sleep,
  timeGuard,
  toRecipeError,
  type BasicProbe,
  type RawReview,
  type RawSubject,
  type ReviewsRecipe,
  type TimeGuard,
} from "../../reviews/sources/shared-browser.js";
import type { ReviewSearchResult } from "../../reviews/types.js";
import { RecipeError, type RecipeContext } from "./types.js";

/**
 * Google Play reviews recipe (PLAN.md 14.6, 4.5, WP19b).
 *
 * Personal use only: reading Google Play automatically is against Google's
 * terms (PLAN.md 14.0). No stealth, no CAPTCHA solving. The recipe navigates,
 * dismisses a consent dialog when one appears, opens the app's details page,
 * clicks the read-only "See all reviews" control, scrolls at most three times
 * and reads the review cards. It never types.
 *
 * Verified live on 2026-10-21 from a headless Chromium in the development
 * environment (2 page loads, both HTTP 200, no consent dialog, no CAPTCHA;
 * the Play UI bundle on gstatic.com was blocked by the browser's ORB policy,
 * so the pages were read as served, without client-side rendering):
 *
 *   https://play.google.com/store/search?q=Notion&c=apps&hl=en
 *     result links: `a[href="/store/apps/details?id=notion.id"]` (first), then
 *     com.cron.calendar, com.penguin.instantnote, ... (relative hrefs).
 *   https://play.google.com/store/apps/details?id=notion.id&hl=en&gl=us&showAllReviews=true
 *     title "Notion: AI Workspace - Apps on Google Play"; `h1` holds the name;
 *     developer `a[href="/store/apps/developer?id=Notion+Labs,+Inc."]`;
 *     header rating `div[itemprop="starRating"] > div[role="img"][aria-label="Rated 4.6 stars out of five stars"]`
 *     with the count next to it in `div.g1rdde` "401K reviews"; the category
 *     links `a[href*="/store/apps/category/"]` in the page's nav are site
 *     navigation, not the app's categories (ignored unless outside nav/header).
 *     Reviews section: each card is
 *       div.EGFGHd > header.c1bOId[data-review-id=<uuid>] (avatar img, div.X5PpBb name,
 *         button[aria-label="More review actions"] with a menu, div[role="img"][aria-label="Rated 4 stars out of five stars"],
 *         span.bp9Aid "February 26, 2026")
 *       + div.h3YV2d (the text)
 *       + div[data-review-id=<uuid>][data-original-thumbs-up-count="82"] > div.AJTPZc "82 people found this review helpful"
 *         + footer "Did you find this helpful? Yes / No".
 *     The server-rendered page carried 3 cards; "See all reviews" is a
 *     `button` whose label span reads "See all reviews" (it opens a dialog with
 *     more cards when the UI bundle runs). No card on the live page had a
 *     developer reply, so the fixture's reply block is synthetic, following
 *     Play's known `div.ocpBU` shape (developer name, date, text).
 */

export const GOOGLE_PLAY_REVIEWS_SITE = "google_play_reviews";
export const GOOGLE_PLAY_ORIGIN = "https://play.google.com";
export const GOOGLE_PLAY_SEARCH_URL = `${GOOGLE_PLAY_ORIGIN}/store/search`;
export const GOOGLE_PLAY_DETAILS_URL = `${GOOGLE_PLAY_ORIGIN}/store/apps/details`;

const SEE_ALL_REVIEWS_RE = /\bsee all reviews\b/i;
const NO_RESULTS_RE = /\b(?:no results|couldn.t find|we couldn.t find anything)\b/i;
const NOT_FOUND_RE = /requested URL (?:was )?not found|item not found|We.re sorry, the requested URL/i;

export interface GooglePlayReviewsRecipeOptions {
  /** Replaces https://play.google.com/store/search (tests). */
  searchBaseUrl?: string;
  /** Replaces https://play.google.com/store/apps/details (tests). */
  detailsBaseUrl?: string;
  /** Longest wait for each page, in ms. Also capped at 60% of the time left. Default 30000. */
  maxWaitMs?: number;
  pollMs?: number;
  /** Scrolls of the reviews list. Default 3. */
  maxScrolls?: number;
  /** Longest wait for the list to grow after "See all reviews" was clicked. Default 5000. */
  expandWaitMs?: number;
}

/** Package id from a `play.google.com/store/apps/details?id=<pkg>` URL (also accepts a `market://details?id=` link). */
export function parsePlayPackageId(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    const play = /(^|\.)play\.google\.com$/i.test(u.hostname) && /\/store\/apps\/details\/?$/.test(u.pathname);
    const market = u.protocol === "market:" && /details/.test(u.pathname + u.hostname);
    if (!play && !market) return undefined;
    const id = u.searchParams.get("id")?.trim();
    return id !== undefined && /^[A-Za-z0-9_.]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Package id from a result link's href, absolute or relative (`/store/apps/details?id=<pkg>`). */
export function packageIdFromHref(href: string | null | undefined): string | undefined {
  if (href === null || href === undefined) return undefined;
  try {
    const u = new URL(href, GOOGLE_PLAY_ORIGIN);
    if (!/\/store\/apps\/details\/?$/.test(u.pathname)) return undefined;
    const id = u.searchParams.get("id")?.trim();
    return id !== undefined && /^[A-Za-z0-9_.]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function isGooglePlayUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return /(^|\.)play\.google\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function buildGooglePlaySearchUrl(subject: string, base: string = GOOGLE_PLAY_SEARCH_URL): string {
  const params = new URLSearchParams({ q: subject, c: "apps", hl: "en" });
  return `${base}?${params.toString()}`;
}

export function buildGooglePlayDetailsUrl(pkg: string, base: string = GOOGLE_PLAY_DETAILS_URL): string {
  const params = new URLSearchParams({ id: pkg, hl: "en", gl: "us", showAllReviews: "true" });
  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Page probes (strings: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

interface SearchProbe extends BasicProbe {
  firstHref: string | null;
}

const SEARCH_PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const a = document.querySelector('a[href*="/store/apps/details?id="]');
  return {${BASIC_PROBE_FIELDS_JS}
    firstHref: a ? a.getAttribute("href") : null,
  };
})()`;

interface DetailsProbe extends BasicProbe {
  heading: string;
  cards: number;
}

const CARD_SELECTOR_JS = `Array.from(document.querySelectorAll("[data-review-id]")).filter((el) => {
    const card = el.parentElement && el.parentElement.querySelector('[role="img"][aria-label*="Rated" i]') ? el.parentElement : el;
    return !!card.querySelector('[role="img"][aria-label*="Rated" i]');
  })`;

const DETAILS_PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const h1 = document.querySelector("h1");
  const ids = new Set(${CARD_SELECTOR_JS}.map((el) => el.getAttribute("data-review-id")));
  return {${BASIC_PROBE_FIELDS_JS}
    heading: h1 ? (h1.textContent || "").replace(/\\s+/g, " ").trim() : "",
    cards: ids.size,
  };
})()`;

const SUBJECT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const h1 = document.querySelector("h1");
  const inCard = (el) => !!el.closest("[data-review-id]") || !!(el.parentElement && el.parentElement.closest("[data-review-id]"));
  const rated = Array.from(document.querySelectorAll('[role="img"][aria-label*="Rated" i]')).find((el) => !inCard(el) && !el.closest("header[data-review-id]"));
  const starBlock = document.querySelector('[itemprop="starRating"] [role="img"][aria-label]');
  let reviewCountText;
  for (const el of document.querySelectorAll("div, span")) {
    if (el.children.length > 0) continue;
    const t = clean(el.textContent);
    if (/^[\\d.,]+\\s*[KkMm]?\\s+reviews?$/i.test(t)) { reviewCountText = t; break; }
  }
  const dev = document.querySelector('a[href*="/store/apps/dev"]');
  const categories = Array.from(document.querySelectorAll('a[href*="/store/apps/category/"]'))
    .filter((a) => !a.closest("nav, header, footer"))
    .map((a) => clean(a.textContent)).filter((t) => t && t.length < 60);
  return {
    name: h1 ? clean(h1.textContent) : undefined,
    url: location.href,
    ratingLabel: (starBlock || rated) ? ((starBlock || rated).getAttribute("aria-label") || undefined) : undefined,
    reviewCountText,
    categories,
    developer: dev ? clean(dev.textContent) : undefined,
  };
})()`;

interface PlaySubject extends RawSubject {
  developer?: string | undefined;
}

const SCROLL_JS = `(() => {
  const cards = ${CARD_SELECTOR_JS};
  const first = cards[cards.length - 1] || cards[0];
  let node = first ? first.parentElement : null;
  let pane = null;
  while (node && node !== document.body) {
    const s = getComputedStyle(node);
    if (node.scrollHeight > node.clientHeight + 10 && /(auto|scroll)/.test(s.overflowY)) { pane = node; break; }
    node = node.parentElement;
  }
  if (pane) { pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new Event("scroll")); }
  else window.scrollTo(0, document.documentElement.scrollHeight);
  return new Set(${CARD_SELECTOR_JS}.map((el) => el.getAttribute("data-review-id"))).size;
})()`;

const COLLECT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const DATE_RE = /^(?:[A-Z][a-z]+\\.? \\d{1,2}, \\d{4}|\\d{1,2} [A-Z][a-z]+\\.? \\d{4})$/;
  const NOISE_RE = /^(more review actions|flag inappropriate|show review history|did you find this helpful\\??|yes|no|helpful)$/i;
  const seen = new Set();
  const out = [];
  for (const el of ${CARD_SELECTOR_JS}) {
    const id = el.getAttribute("data-review-id") || "";
    if (seen.has(id)) continue;
    seen.add(id);
    const card = el.parentElement && el.parentElement.querySelector('[role="img"][aria-label*="Rated" i]') ? el.parentElement : el;
    const header = card.querySelector("header") || card.querySelector('[data-review-id="' + id + '"]');
    const rec = { nativeId: id || undefined };
    const star = card.querySelector('[role="img"][aria-label*="Rated" i]');
    if (star) rec.ratingLabel = star.getAttribute("aria-label") || undefined;
    const headerLeaves = header ? Array.from(header.querySelectorAll("*")).filter((n) => n.children.length === 0 && !n.closest('button, [role="menu"], [role="img"]')) : [];
    for (const leaf of headerLeaves) {
      const t = clean(leaf.textContent);
      if (!t || NOISE_RE.test(t)) continue;
      if (DATE_RE.test(t)) { if (!rec.dateText) rec.dateText = t; continue; }
      if (!rec.author) rec.author = t;
    }
    const footer = Array.from(card.children).find((c) => c !== header && c.hasAttribute("data-review-id"));
    if (footer) {
      const n = footer.getAttribute("data-original-thumbs-up-count");
      if (n && /^\\d+$/.test(n)) rec.helpfulVotes = Number(n);
      else {
        const m = /(\\d[\\d,]*) people found this review helpful|one person found this review helpful/i.exec(footer.innerText || "");
        if (m) rec.helpfulText = m[0];
      }
    }
    const textNode = Array.from(card.children).find((c) => c !== header && c !== footer && clean(c.textContent) && !c.querySelector("header"));
    if (textNode) rec.text = clean(textNode.innerText || textNode.textContent);
    const rest = Array.from(card.children).filter((c) => c !== header && c !== footer && c !== textNode);
    for (const block of rest) {
      const lines = (block.innerText || "").split("\\n").map(clean).filter(Boolean);
      const dateIdx = lines.findIndex((l) => DATE_RE.test(l));
      if (dateIdx < 0 || lines.length < 3) continue;
      rec.responseDateText = lines[dateIdx];
      rec.responseText = lines.filter((l, i) => i !== dateIdx && i > 0).join("\\n") || undefined;
      break;
    }
    out.push(rec);
  }
  return out;
})()`;

const PAGE_TEXT_JS = `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog && dialog.querySelector("[data-review-id]")) return dialog.innerText || "";
  const section = Array.from(document.querySelectorAll("section, [role='region'], c-wiz, div")).find((s) => /ratings and reviews/i.test((s.querySelector("h2, header") || {}).textContent || "") && s.querySelector("[data-review-id]"));
  return (section && section.innerText) || (document.body ? document.body.innerText : "") || "";
})()`;

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export function createGooglePlayReviewsRecipe(options: GooglePlayReviewsRecipeOptions = {}): ReviewsRecipe {
  const searchBaseUrl = options.searchBaseUrl ?? GOOGLE_PLAY_SEARCH_URL;
  const detailsBaseUrl = options.detailsBaseUrl ?? GOOGLE_PLAY_DETAILS_URL;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const pollMs = options.pollMs ?? 300;
  const maxScrolls = options.maxScrolls ?? 3;
  const expandWaitMs = options.expandWaitMs ?? 5000;
  const site = "Google Play";

  const buildUrl = (q: NormalizedReviewsQuery): string | null => {
    const pkg = parsePlayPackageId(q.subject_url);
    if (pkg !== undefined) return buildGooglePlayDetailsUrl(pkg, detailsBaseUrl);
    if (q.subject_url !== undefined) return null;
    return buildGooglePlaySearchUrl(q.subject, searchBaseUrl);
  };

  async function run(page: Page, params: NormalizedReviewsQuery, ctx: RecipeContext): Promise<ReviewSearchResult> {
    const parsed = NormalizedReviewsQuerySchema.safeParse(params);
    if (!parsed.success) {
      throw new RecipeError("invalid_input", `invalid reviews query: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    const q = parsed.data;
    const caveat = caveatSink(ctx);
    const guard = timeGuard(ctx, site);
    const nowMs = Date.now();
    const source = "google_play";

    try {
      guard.check("before navigating");
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      let pkg = parsePlayPackageId(q.subject_url);
      if (pkg === undefined && q.subject_url !== undefined) {
        throw new SubjectNotFoundError(`Google Play cannot look up a URL on ${new URL(q.subject_url).hostname}; pass the app's name or its Play Store URL`);
      }
      if (pkg === undefined) {
        await navigateTo(page, buildGooglePlaySearchUrl(q.subject, searchBaseUrl), ctx, site);
        pkg = await waitForSearchResult(page, q, { caveat, guard });
        ctx.log.debug("google play: first search result", { package: pkg });
      }

      await navigateTo(page, buildGooglePlayDetailsUrl(pkg, detailsBaseUrl), ctx, site);
      await waitForDetails(page, pkg, { caveat, guard });
      const subjectRaw = await page.evaluate<PlaySubject>(SUBJECT_JS).catch(() => ({}) as PlaySubject);
      await openAllReviews(page, ctx, guard);
      await scrollReviews(page, q, ctx, guard);

      guard.check("before reading reviews");
      const raws = await page.evaluate<RawReview[]>(COLLECT_JS);
      const reviews = raws.map((r) => assembleReview(source, r, { nowMs, caveat })).filter((r): r is NonNullable<typeof r> => r !== undefined);
      ctx.log.debug("google play reviews probe", { cards: raws.length, valid: reviews.length });
      const categories = [...(subjectRaw.categories ?? []), ...(subjectRaw.developer !== undefined ? [`Developer: ${subjectRaw.developer}`] : [])];
      const subjectWithDev: RawSubject = { ...subjectRaw, categories };

      if (reviews.length >= MIN_PROBE_REVIEWS) {
        return { subject: assembleSubject(source, subjectWithDev, q.subject), reviews: dedupeReviews(reviews, q.per_source) };
      }

      guard.check("before the fallback extraction");
      const pageText = await page.evaluate<string>(PAGE_TEXT_JS);
      const extracted = await extractReviewsWithLlm({
        site,
        source,
        pageText,
        pageUrl: page.url(),
        query: q,
        ctx,
        hint: "Reviews sit under 'Ratings and reviews'; each shows the reviewer's name, a star rating, a date like 'February 26, 2026', the text, and sometimes 'N people found this review helpful' and a reply from the developer.",
      });
      const fromLlm = reviewsFromExtraction(source, extracted, { nowMs, caveat });
      const merged = dedupeReviews([...reviews, ...fromLlm], q.per_source);
      if (merged.length === 0) caveat("Google Play showed no reviews for this app.");
      else caveat("Google Play reviews were read by the extractor model because the page structure was not recognised; fields may be incomplete.");
      return { subject: mergeSubject(source, subjectWithDev, extracted.subject, q.subject), reviews: merged };
    } catch (err) {
      throw toRecipeError(err, ctx, site);
    }
  }

  async function waitForSearchResult(page: Page, q: NormalizedReviewsQuery, o: { caveat: (m: string) => void; guard: TimeGuard }): Promise<string> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(maxWaitMs, o.guard.remaining() * 0.6));
    let consentHandled = false;
    let last: SearchProbe | undefined;
    for (;;) {
      o.guard.check("while waiting for Google Play search results");
      let probe: SearchProbe | undefined;
      try {
        probe = await page.evaluate<SearchProbe>(SEARCH_PROBE_JS);
      } catch {
        // navigation under us
      }
      if (probe !== undefined) {
        last = probe;
        const wall = blockedReason(probe);
        if (wall !== undefined) throw new RecipeError("blocked", `Google Play served a bot check (${wall}) at ${probe.url}`, { retryable: false });
        if (probe.firstHref !== null) {
          const pkg = packageIdFromHref(probe.firstHref);
          if (pkg !== undefined) return pkg;
        }
        if (NO_RESULTS_RE.test(probe.text) && probe.textLength > 0) {
          throw new SubjectNotFoundError(`Google Play found no app matching "${q.subject}"`);
        }
      }
      if (!consentHandled && (await dismissConsent(page))) {
        consentHandled = true;
        o.caveat(CONSENT_CAVEAT);
        continue;
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `no Google Play search results appeared within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(pollMs);
    }
  }

  async function waitForDetails(page: Page, pkg: string, o: { caveat: (m: string) => void; guard: TimeGuard }): Promise<void> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(maxWaitMs, o.guard.remaining() * 0.6));
    let consentHandled = false;
    let last: DetailsProbe | undefined;
    for (;;) {
      o.guard.check("while waiting for the app page");
      let probe: DetailsProbe | undefined;
      try {
        probe = await page.evaluate<DetailsProbe>(DETAILS_PROBE_JS);
      } catch {
        // navigation under us
      }
      if (probe !== undefined) {
        last = probe;
        const wall = blockedReason(probe);
        if (wall !== undefined) throw new RecipeError("blocked", `Google Play served a bot check (${wall}) at ${probe.url}`, { retryable: false });
        if (NOT_FOUND_RE.test(probe.text) && probe.textLength < 2000) throw new SubjectNotFoundError(`Google Play has no app with the package id ${pkg}`);
        if (probe.heading !== "" || probe.cards > 0) return;
      }
      if (!consentHandled && (await dismissConsent(page))) {
        consentHandled = true;
        o.caveat(CONSENT_CAVEAT);
        continue;
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `the Google Play app page did not render within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(pollMs);
    }
  }

  /** Click "See all reviews" when present and wait for the list (or dialog) to grow. */
  async function openAllReviews(page: Page, ctx: RecipeContext, guard: TimeGuard): Promise<void> {
    guard.check("before opening all reviews");
    const button = page.getByRole("button", { name: SEE_ALL_REVIEWS_RE }).first();
    try {
      if ((await button.count()) === 0) return;
      const before = await cardCount(page);
      await button.click({ timeout: guard.cap(5000) });
      const until = Date.now() + guard.cap(expandWaitMs);
      while (Date.now() < until) {
        await sleep(pollMs);
        if ((await cardCount(page)) > before) return;
      }
    } catch (err) {
      ctx.log.debug("google play: could not open all reviews", { error: errMsg(err) });
    }
  }

  async function scrollReviews(page: Page, q: NormalizedReviewsQuery, ctx: RecipeContext, guard: TimeGuard): Promise<void> {
    let count = await cardCount(page);
    for (let i = 0; i < maxScrolls && count > 0 && count < q.per_source; i++) {
      guard.check("while scrolling the reviews");
      const before = count;
      try {
        await page.evaluate(SCROLL_JS);
      } catch (err) {
        ctx.log.debug("google play: scroll failed", { error: errMsg(err) });
        break;
      }
      const until = Date.now() + guard.cap(3000);
      do {
        await sleep(pollMs);
        count = await cardCount(page);
      } while (count <= before && Date.now() < until);
      if (count <= before) break;
    }
  }

  async function cardCount(page: Page): Promise<number> {
    try {
      return await page.evaluate<number>(`new Set(${CARD_SELECTOR_JS}.map((el) => el.getAttribute("data-review-id"))).size`);
    } catch {
      return 0;
    }
  }

  return {
    site: GOOGLE_PLAY_REVIEWS_SITE,
    paramsSchema: NormalizedReviewsQuerySchema,
    resultSchema: ReviewSearchResultSchema,
    buildUrl,
    run,
  };
}

/** The recipe against live Google Play. */
export const googlePlayReviewsRecipe: ReviewsRecipe = createGooglePlayReviewsRecipe();
