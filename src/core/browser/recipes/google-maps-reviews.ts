import type { Page, Request as PageRequest, Response as PageResponse } from "playwright";
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
} from "../../reviews/sources/shared-browser.js";
import type { ReviewSearchResult } from "../../reviews/types.js";
import { RecipeError, type RecipeContext } from "./types.js";

/**
 * Google Maps reviews recipe (PLAN.md 14.6, 4.5, WP19b).
 *
 * Personal use only: reading Google Maps automatically is against Google's
 * terms (PLAN.md 14.0). No stealth, no CAPTCHA solving: a bot wall is
 * `blocked`. The recipe navigates, dismisses the consent dialog (reject
 * preferred, as in flights), opens the first result when a list is shown,
 * opens the "Reviews" tab, scrolls the reviews pane at most three times,
 * clicks the read-only "More" expanders inside reviews, and reads
 * `div[data-review-id]`. It never types.
 *
 * Live findings, 2026-10-21, headless Chromium in the development environment
 * (3 page loads): `https://www.google.com/maps/search/Hotel%20Lutetia%20Paris?hl=en`
 * answered HTTP 200 with the Maps shell, but the application bundle
 * `https://www.google.com/maps/_/js/k=maps.m.en....` answered HTTP 403, so the
 * page never rendered (body text "Collapse side panel" only, no consent
 * dialog, no results). The fixture page under `test/fixtures/reviews/browser/`
 * is therefore SYNTHETIC: it follows the Maps place-page markup known from
 * the public DOM (`h1` name, `[role="img"][aria-label="4.6 stars"]`, the
 * "1,234 reviews" count, `button[data-item-id="address"]`, a
 * `button[role="tab"]` named "Reviews for ...", a scrollable pane of
 * `div[data-review-id]` cards each holding a `button[data-href*="/maps/contrib/"]`
 * with the reviewer's name, `[role="img"][aria-label="N stars"]`, a relative
 * time ("2 months ago"), the text in `span.wiI7pd` behind a "More" button, an
 * optional "Response from the owner" block and a "N likes" button). The
 * owner's first run from a home IP is the real test of the selectors; the
 * schema-driven LLM fallback covers a redesign.
 *
 * A refused script is `blocked` at once (WP32): the recipe watches the
 * responses for the application bundle (`/maps/_/js/`), and a 403 or failed
 * load there, with nothing of the app on the page, ends the run instead of
 * waiting out the 30 s budget. A page that has finished loading but shows no
 * app container for `appStartMs` is reported the same way. Checked live on
 * 2026-10-26 from a home IP: the rendered page had a search input, map
 * canvases and headings by its load event; with the bundle answered 403 (via
 * request interception) the body held only scripts and a `<noscript>`.
 *
 * First logged-in run from the home IP, 2026-10-27 (WP36): the selectors
 * match the live page (`div.jftiEf[data-review-id]` wrapping an inner
 * `div[data-review-id]` that holds the reviewer button, the star img, the
 * relative time and `span.wiI7pd`). The overview tab already shows three
 * cards, and opening the Reviews tab replaces them: the recipe used to take
 * those as the tab's cards and read the page in the gap that followed, so it
 * found none. It now waits for cards that were not there before the click.
 * It also counted the outer and inner div of each card when deciding whether
 * to scroll, so 10 reviews looked like 20; only the innermost count now.
 * `google-maps-place-live.html` reproduces that page.
 *
 * Lists of matches, live on 2026-10-28 (WP41): a search with several matches
 * shows a list in a `[role="main"]` whose `h1` reads "Results" and whose cards
 * carry star ratings, which the place check took for a place: the recipe read
 * "Results" as the name, mixed the first cards' rating and count, and found no
 * reviews. Opening a result adds a second `[role="main"]`, labelled with the
 * place's name, and leaves the list in the page. So a place is now the last
 * main panel with a heading and no results feed, the subject is read only from
 * it, and a list opens the result whose name best matches the search. The
 * weekly hours are one "Copy open hours" button per day ("Wednesday, 9 AM to
 * 12 AM, Copy open hours") over a hidden table. `google-maps-list-live.html`
 * and `google-maps-list-place-live.html` reproduce those pages.
 */

export const GOOGLE_MAPS_REVIEWS_SITE = "google_maps_reviews";
export const GOOGLE_MAPS_SEARCH_URL = "https://www.google.com/maps/search/";

/** Tabs are named "Reviews for <place>" or just "Reviews". */
const REVIEWS_TAB_RE = /^\s*Reviews\b/i;
const MORE_REVIEWS_RE = /\bmore reviews\b/i;
const NO_RESULTS_RE = /\b(?:can.t find|couldn.t find|no results found|did not match any)\b/i;

/** The Maps application bundle, e.g. `https://www.google.com/maps/_/js/k=maps.m.en....`. */
const MAPS_BUNDLE_RE = /\/maps\/_\/js\//;

/**
 * Anything the Maps application renders once its script runs (search box, map
 * canvas, a heading, the results feed, a place link, review cards), or a dialog
 * or form Google shows in its place (consent). The shell alone has none of
 * these; WP19b's cloud run saw only a "Collapse side panel" button.
 */
const APP_SELECTOR = 'input, canvas, h1, [role="feed"], [role="dialog"], form, a[href*="/maps/place/"], div[data-review-id]';

/** A page without the app and with less visible text than this is the bare shell. */
const SHELL_TEXT_MAX = 200;

function isMapsBundle(request: PageRequest): boolean {
  return request.resourceType() === "script" && MAPS_BUNDLE_RE.test(request.url());
}

export interface GoogleMapsReviewsRecipeOptions {
  /** Replaces https://www.google.com/maps/search/ (tests point it at a fixture server). */
  searchBaseUrl?: string;
  /** Longest wait for a place page or a results list, in ms. Also capped at 60% of the time left. Default 30000. */
  maxWaitMs?: number;
  /** Poll interval while waiting. Default 300. */
  pollMs?: number;
  /** How many times the reviews pane is scrolled to load more. Default 3 (PLAN.md 14.6). */
  maxScrolls?: number;
  /** Longest wait for the first review cards after the tab was opened. Default 8000. */
  reviewsWaitMs?: number;
  /** How long a fully loaded page may show no app container before it counts as refused. Default 5000. */
  appStartMs?: number;
  /** How long a place page may take to show its Reviews tab (or "More reviews") after its name. Default 3000. */
  tabWaitMs?: number;
}

/** True for a URL on a google.* host under /maps/ (search, place), or a short maps.app.goo.gl link. */
export function isGoogleMapsUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const u = new URL(url);
    if (/^maps\.app\.goo\.gl$/i.test(u.hostname) || /^goo\.gl$/i.test(u.hostname)) return true;
    return /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /^\/maps(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/** The search text: subject plus location when given. */
export function mapsSearchText(q: Pick<NormalizedReviewsQuery, "subject" | "location">): string {
  return q.location !== undefined ? `${q.subject} ${q.location}` : q.subject;
}

export function buildGoogleMapsSearchUrl(q: Pick<NormalizedReviewsQuery, "subject" | "location">, base: string = GOOGLE_MAPS_SEARCH_URL): string {
  return `${base}${encodeURIComponent(mapsSearchText(q))}?hl=en`;
}

function withEnglish(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("hl")) u.searchParams.set("hl", "en");
    return u.toString();
  } catch {
    return url;
  }
}

/** Lower-case words without accents, for matching a result's name to the search. */
function nameWords(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
}

const LATIN_RE = /\p{Script=Latin}/u;

/**
 * Which result of a list to open: Google's first, which also weighs the
 * location, unless its name is written in the subject's script, lacks some of
 * the subject's words, and a later result has them all. Live on 2026-10-28:
 * "Koshary El Tahrir" listed "Al Tahreer Koshary Restaurant" first and the
 * place itself second; "Koshary Sayed Hanafy Downtown" listed the Downtown
 * branch first under an Arabic name, then a Nasr City branch named in English.
 */
export function bestResultIndex(subject: string, labels: readonly string[]): number {
  const wanted = nameWords(subject);
  const first = labels[0];
  if (first === undefined || wanted.length === 0) return 0;
  const hasAll = (label: string): boolean => {
    const words = new Set(nameWords(label));
    return wanted.every((w) => words.has(w));
  };
  if (hasAll(first) || LATIN_RE.test(first) !== LATIN_RE.test(subject)) return 0;
  return Math.max(0, labels.findIndex(hasAll));
}

// ---------------------------------------------------------------------------
// Page probes (strings: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

/**
 * `placeRoot()`: the opened place's own panel, the last `[role="main"]` with a
 * heading and no results feed. A list of matches stays in the page under an
 * opened place, so the page's first `h1` and star rating may be the list's.
 * A page with no such panel is a place only when it shows no results feed.
 */
const PLACE_ROOT_JS = `const placeRoot = () => {
    const panes = Array.from(document.querySelectorAll('[role="main"]')).filter((m) => {
      const h = m.querySelector("h1");
      return !m.querySelector('[role="feed"]') && !!h && (h.textContent || "").trim() !== "";
    });
    if (panes.length > 0) return panes[panes.length - 1];
    return document.querySelector('[role="feed"]') ? null : document;
  };`;

/**
 * `readHours(root, visibleOnly)`: the weekly hours, Monday first, from the
 * "Copy open hours" buttons ("Wednesday, 9 AM to 12 AM, Copy open hours"),
 * else from the hours table's rows. Rows whose first cell is not a weekday,
 * such as the rating distribution's, are skipped.
 */
const READ_HOURS_JS = `const readHours = (root, visibleOnly) => {
    const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const shown = (el) => !visibleOnly || el.getClientRects().length > 0;
    const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const dayOf = (s) => DAYS.find((d) => (s || "").toLowerCase().startsWith(d.toLowerCase()));
    const byDay = {};
    for (const el of root.querySelectorAll('[aria-label*="open hours" i]')) {
      if (!shown(el)) continue;
      const m = /^([A-Za-z]+)[^,]*,\\s*(.+?),\\s*copy open hours$/i.exec(clean(el.getAttribute("aria-label")));
      const day = m ? dayOf(m[1]) : undefined;
      if (day && !byDay[day]) byDay[day] = m[2];
    }
    if (Object.keys(byDay).length === 0) {
      for (const tr of root.querySelectorAll("table tr")) {
        if (!shown(tr)) continue;
        const cells = Array.from(tr.querySelectorAll("td, th")).map((c) => clean(c.textContent)).filter((t) => t);
        const day = cells.length > 1 ? dayOf(cells[0]) : undefined;
        if (day && !byDay[day]) byDay[day] = cells.slice(1).join(", ");
      }
    }
    return DAYS.filter((d) => byDay[d]).map((d) => d + ": " + byDay[d]);
  };`;

/** The hours view that "See more hours" opens; another place's hidden hours can linger in the page, so only what is shown counts. */
const HOURS_VIEW_JS = `(() => {
  ${READ_HOURS_JS}
  return readHours(document, true);
})()`;

/** The read-only button that opens a place's weekly hours ("Open · Closes 1 AM · See more hours"). */
const SEE_MORE_HOURS_SELECTOR = 'button[aria-label*="See more hours" i]';
const OVERVIEW_TAB_RE = /^\s*Overview\b/i;

/** The names of the results on a list, in page order. */
const RESULT_LABELS_JS = `(() => Array.from(document.querySelectorAll('a[href*="/maps/place/"]')).map((a) => (a.getAttribute("aria-label") || a.textContent || "").replace(/\\s+/g, " ").trim()))()`;

interface MapsProbe extends BasicProbe {
  heading: string;
  resultLinks: number;
  hasReviewsTab: boolean;
  hasMoreReviews: boolean;
  hasRating: boolean;
  reviewCards: number;
  /** The load event has fired. */
  ready: boolean;
  /** Something of the Maps application (or a consent dialog) is on the page: `APP_SELECTOR`. */
  hasApp: boolean;
}

const PROBE_JS = `(() => {
  ${PLACE_ROOT_JS}
  const text = document.body ? (document.body.innerText || "") : "";
  const root = placeRoot();
  const scope = root || document;
  const h1 = root ? root.querySelector("h1") : null;
  const tabs = Array.from(scope.querySelectorAll('button[role="tab"]'));
  const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
  const name = (el) => ((el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim());
  return {${BASIC_PROBE_FIELDS_JS}
    heading: h1 ? (h1.textContent || "").replace(/\\s+/g, " ").trim() : "",
    resultLinks: document.querySelectorAll('a[href*="/maps/place/"]').length,
    hasReviewsTab: tabs.some((t) => /^\\s*Reviews\\b/i.test(name(t))),
    hasMoreReviews: buttons.some((b) => /\\bmore reviews\\b/i.test(name(b))),
    hasRating: !!(root && root.querySelector('[role="img"][aria-label*="star" i]')),
    reviewCards: scope.querySelectorAll("div[data-review-id]").length,
    ready: document.readyState === "complete",
    hasApp: !!document.querySelector('${APP_SELECTOR}'),
  };
})()`;

/** Subject fields from the opened place's own panel, hours included (Monday first). */
const SUBJECT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  ${PLACE_ROOT_JS}
  const root = placeRoot() || document;
  const h1 = root.querySelector("h1");
  const ratingEl = root.querySelector('[role="img"][aria-label*="star" i]');
  let reviewCountText;
  for (const el of root.querySelectorAll("[aria-label], span, button")) {
    const label = clean(el.getAttribute("aria-label")) || (el.children.length === 0 ? clean(el.textContent) : "");
    const m = /^\\(?([\\d.,]+\\s*[KkMm]?)\\)?\\s*reviews?$/i.exec(label) || /^([\\d.,]+\\s*[KkMm]?)\\s+reviews?\\b/i.exec(label);
    if (m) { reviewCountText = m[1] + " reviews"; break; }
  }
  const addressEl = root.querySelector('button[data-item-id="address"], [data-item-id="address"], [data-tooltip="Copy address"]');
  let address = addressEl ? clean(addressEl.getAttribute("aria-label") || addressEl.textContent) : undefined;
  if (address) address = address.replace(/^address:\\s*/i, "");
  const categories = Array.from(root.querySelectorAll('button[jsaction*="category" i], [data-item-id="category"], a[href*="/maps/search/"][aria-label^="Category" i]'))
    .map((b) => clean(b.textContent)).filter((t) => t && t.length < 60);
  const priceEl = Array.from(root.querySelectorAll("[aria-label]")).find((el) => /^price/i.test(el.getAttribute("aria-label") || "") && /^[$€£¥·\\s-]+$/.test(clean(el.textContent)));
  ${READ_HOURS_JS}
  const shownHours = readHours(root, true);
  return {
    name: h1 ? clean(h1.textContent) : undefined,
    url: location.href,
    ratingLabel: ratingEl ? (ratingEl.getAttribute("aria-label") || undefined) : undefined,
    reviewCountText,
    address: address || undefined,
    categories,
    priceLevel: priceEl ? clean(priceEl.textContent) : undefined,
    hours: shownHours.length > 0 ? shownHours : readHours(root, false),
  };
})()`;

/** Scroll the pane that holds the review cards to its end; returns how many cards exist afterwards. */
const SCROLL_JS = `(() => {
  const first = document.querySelector("div[data-review-id]");
  let node = first ? first.parentElement : null;
  let pane = null;
  while (node && node !== document.body) {
    const s = getComputedStyle(node);
    if (node.scrollHeight > node.clientHeight + 10 && /(auto|scroll)/.test(s.overflowY)) { pane = node; break; }
    node = node.parentElement;
  }
  if (pane) { pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new Event("scroll")); }
  else window.scrollTo(0, document.documentElement.scrollHeight);
  return document.querySelectorAll("div[data-review-id]").length;
})()`;

/** Click the read-only "More" expanders inside review cards. Returns how many were clicked. */
const EXPAND_JS = `(() => {
  let n = 0;
  for (const b of document.querySelectorAll('div[data-review-id] button, div[data-review-id] [role="button"]')) {
    const label = (b.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    const text = (b.textContent || "").replace(/\\s+/g, " ").trim();
    const expander = /^(more|see more|read more|show more)$/i.test(text) || /^(see|read|show) more\\b/i.test(label);
    if (!expander || b.getAttribute("aria-expanded") === "true") continue;
    try { b.click(); n++; } catch (e) { /* ignore */ }
  }
  return n;
})()`;

/** One record per div[data-review-id]. */
const COLLECT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const TIME_RE = /^(?:edited\\s+)?(?:an?|\\d+)\\s+(?:second|minute|hour|day|week|month|year)s?\\s+ago(?:\\s+on\\s+google)?$|^(?:yesterday|today|just now)$/i;
  const NOISE_RE = /^(more|see more|read more|like|share|local guide|new|helpful|\\d+ reviews?|\\d+ photos?|·|•)$|^\\d+ (reviews?|photos?)\\b|^local guide\\b|^response from the owner/i;
  const out = [];
  for (const card of document.querySelectorAll("div[data-review-id]")) {
    if (card.querySelector("div[data-review-id]")) continue; // nested wrappers: read the innermost
    const rec = { nativeId: card.getAttribute("data-review-id") || undefined };
    const star = Array.from(card.querySelectorAll('[role="img"][aria-label]')).find((el) => /\\bstars?\\b|out of 5|\\/\\s*5/i.test(el.getAttribute("aria-label") || ""));
    if (star) rec.ratingLabel = star.getAttribute("aria-label") || undefined;
    const authorEl = card.querySelector('button[data-href*="/maps/contrib/"], a[href*="/maps/contrib/"], button[aria-label^="Photo of" i]');
    if (authorEl) {
      const href = authorEl.getAttribute("data-href") || authorEl.getAttribute("href");
      if (href) rec.url = href;
      const nameLine = (authorEl.innerText || authorEl.textContent || "").split("\\n").map(clean).find((l) => l && !NOISE_RE.test(l));
      const label = clean(authorEl.getAttribute("aria-label"));
      rec.author = nameLine || (label ? label.replace(/^photo of\\s+/i, "") : undefined);
    }
    let response = null;
    for (const el of card.querySelectorAll("div, section")) {
      if (/^\\s*response from the owner/i.test(el.innerText || "")) { response = el; break; }
    }
    const inside = (el, root) => !!root && root.contains(el);
    if (response) {
      const rl = Array.from(response.querySelectorAll("*")).filter((el) => el.children.length === 0 && clean(el.textContent));
      const timeLeaf = rl.find((el) => TIME_RE.test(clean(el.textContent)));
      if (timeLeaf) rec.responseDateText = clean(timeLeaf.textContent);
      const body = rl.filter((el) => el !== timeLeaf && !/^response from the owner/i.test(clean(el.textContent))).map((el) => clean(el.textContent));
      rec.responseText = body.join("\\n") || undefined;
    }
    const leaves = Array.from(card.querySelectorAll("*")).filter((el) => el.children.length === 0 && !inside(el, response) && !inside(el, authorEl) && el.tagName !== "SCRIPT" && el.tagName !== "STYLE");
    for (const el of leaves) {
      const t = clean(el.textContent);
      if (!rec.dateText && TIME_RE.test(t)) { rec.dateText = t; break; }
    }
    const preferred = card.querySelector("span.wiI7pd, [data-expandable-section], .MyEned");
    if (preferred && !inside(preferred, response)) rec.text = clean(preferred.innerText || preferred.textContent);
    if (!rec.text) {
      let best = "";
      for (const el of leaves) {
        const t = clean(el.textContent);
        if (!t || TIME_RE.test(t) || NOISE_RE.test(t) || t === rec.author) continue;
        if (t.length > best.length) best = t;
      }
      rec.text = best || undefined;
    }
    const like = Array.from(card.querySelectorAll('button[aria-label], [role="button"][aria-label]')).map((b) => b.getAttribute("aria-label") || "").find((l) => /^\\d[\\d,.]*\\s*(likes?|people found this helpful|helpful)/i.test(l));
    if (like) rec.helpfulText = like;
    out.push(rec);
  }
  return out;
})()`;

/**
 * Remember the review cards on the page now, so `FRESH_CARDS_JS` can tell them
 * from the cards the Reviews tab brings. The place overview shows a few cards
 * of its own; opening the tab removes them and builds a new pane. Live on
 * 2026-10-27 (Cairo Tower): 3 cards at the click, 0 at +230 ms, 10 at +850 ms.
 */
const REMEMBER_CARDS_JS = `(() => {
  window.__webrunnerMapsCards = new WeakSet(document.querySelectorAll("div[data-review-id]"));
  return document.querySelectorAll("div[data-review-id]").length;
})()`;

/** Reviews on the page: live cards nest one div[data-review-id] in another, so only the innermost count. */
const CARD_COUNT_JS = `(() => Array.from(document.querySelectorAll("div[data-review-id]")).filter((c) => !c.querySelector("div[data-review-id]")).length)()`;

/** Cards that were not on the page when `REMEMBER_CARDS_JS` ran. */
const FRESH_CARDS_JS = `(() => {
  const seen = window.__webrunnerMapsCards;
  return Array.from(document.querySelectorAll("div[data-review-id]")).filter((c) => !seen || !seen.has(c)).length;
})()`;

/** Visible text of the pane that holds the reviews (or the whole page). */
const PANE_TEXT_JS = `(() => {
  const first = document.querySelector("div[data-review-id]");
  let node = first ? first.parentElement : null;
  while (node && node !== document.body) {
    const s = getComputedStyle(node);
    if (node.scrollHeight > node.clientHeight + 10 && /(auto|scroll)/.test(s.overflowY)) return node.innerText || "";
    node = node.parentElement;
  }
  const main = document.querySelector('[role="main"]');
  return (main && main.innerText) || (document.body ? document.body.innerText : "") || "";
})()`;

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export function createGoogleMapsReviewsRecipe(options: GoogleMapsReviewsRecipeOptions = {}): ReviewsRecipe {
  const searchBaseUrl = options.searchBaseUrl ?? GOOGLE_MAPS_SEARCH_URL;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const pollMs = options.pollMs ?? 300;
  const maxScrolls = options.maxScrolls ?? 3;
  const reviewsWaitMs = options.reviewsWaitMs ?? 8000;
  const appStartMs = options.appStartMs ?? 5000;
  const tabWaitMs = options.tabWaitMs ?? 3000;
  const site = "Google Maps";

  /** A test base URL accepts any URL on its origin as a place page. */
  const onFixtureOrigin = (url: string): boolean => {
    if (searchBaseUrl === GOOGLE_MAPS_SEARCH_URL) return false;
    try {
      return new URL(url).origin === new URL(searchBaseUrl).origin;
    } catch {
      return false;
    }
  };

  const buildUrl = (q: NormalizedReviewsQuery): string | null => {
    if (q.subject_url !== undefined) return isGoogleMapsUrl(q.subject_url) || onFixtureOrigin(q.subject_url) ? withEnglish(q.subject_url) : null;
    return buildGoogleMapsSearchUrl(q, searchBaseUrl);
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

    // How the application bundle was refused, once it was: from cloud IPs it answers HTTP 403 and the page never renders.
    let refusal: string | undefined;
    const onResponse = (r: PageResponse): void => {
      if (refusal === undefined && r.status() >= 400 && isMapsBundle(r.request())) refusal = `answered HTTP ${r.status()}`;
    };
    const onRequestFailed = (r: PageRequest): void => {
      const failure = r.failure()?.errorText ?? "";
      // ERR_ABORTED is a cancellation (a navigation replaced the page), not a refusal.
      if (refusal === undefined && isMapsBundle(r) && !/ERR_ABORTED/.test(failure)) refusal = `failed with ${failure || "a network error"}`;
    };

    try {
      guard.check("before navigating");
      const url = buildUrl(q);
      if (url === null) {
        throw new SubjectNotFoundError(`Google Maps cannot look up a URL on ${new URL(q.subject_url as string).hostname}; pass the place's name instead`);
      }
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      page.on("response", onResponse);
      page.on("requestfailed", onRequestFailed);
      await navigateTo(page, url, ctx, site);
      await waitForPlace(page, ctx, { caveat, guard, refusal: () => refusal, subject: q.subject });

      const subjectRaw = await page.evaluate<RawSubject>(SUBJECT_JS).catch(() => ({}) as RawSubject);
      // Seen now, on the overview: the Reviews tab removes it.
      const hasHoursButton = (await page.locator(SEE_MORE_HOURS_SELECTOR).count().catch(() => 0)) > 0;
      await openReviews(page, ctx, { guard });
      await loadMore(page, q, ctx, { guard });

      guard.check("before reading reviews");
      const raws = await page.evaluate<RawReview[]>(COLLECT_JS);
      const source = "google_maps";
      const reviews = raws.map((r) => assembleReview(source, r, { nowMs, caveat })).filter((r): r is NonNullable<typeof r> => r !== undefined);
      ctx.log.debug("google maps reviews probe", { cards: raws.length, valid: reviews.length });

      if (reviews.length >= MIN_PROBE_REVIEWS) {
        if (hasHoursButton) await addHours(page, subjectRaw, ctx, { guard });
        return { subject: assembleSubject(source, subjectRaw, q.subject), reviews: dedupeReviews(reviews, q.per_source) };
      }

      guard.check("before the fallback extraction");
      const paneText = await page.evaluate<string>(PANE_TEXT_JS);
      const extracted = await extractReviewsWithLlm({
        site,
        source,
        pageText: paneText,
        pageUrl: page.url(),
        query: q,
        ctx,
        hint: "The reviews are in the place's Reviews pane; each starts with the reviewer's name, then a star rating and a relative date.",
      });
      const fromLlm = reviewsFromExtraction(source, extracted, { nowMs, caveat });
      const merged = dedupeReviews([...reviews, ...fromLlm], q.per_source);
      if (merged.length === 0) {
        caveat("Google Maps showed no reviews for this place.");
      } else {
        caveat("Google Maps reviews were read by the extractor model because the page structure was not recognised; fields may be incomplete.");
      }
      if (hasHoursButton) await addHours(page, subjectRaw, ctx, { guard });
      return { subject: mergeSubject(source, subjectRaw, extracted.subject, q.subject), reviews: merged };
    } catch (err) {
      throw toRecipeError(err, ctx, site);
    } finally {
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    }
  }

  /** Wait for a place page; open the best-matching result when a list appears; dismiss consent; detect walls and a refused script. */
  async function waitForPlace(
    page: Page,
    ctx: RecipeContext,
    o: { caveat: (m: string) => void; guard: ReturnType<typeof timeGuard>; refusal: () => string | undefined; subject: string },
  ): Promise<void> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(maxWaitMs, o.guard.remaining() * 0.6));
    const until = start + budget;
    let consentHandled = false;
    let clickedResult = false;
    let lastProbe: MapsProbe | undefined;
    let shellSince: number | undefined;
    for (;;) {
      o.guard.check("while waiting for the place page");
      let probe: MapsProbe | undefined;
      try {
        probe = await page.evaluate<MapsProbe>(PROBE_JS);
      } catch {
        // Navigation under us (consent redirect, result click): probe again.
      }
      if (probe !== undefined) {
        lastProbe = probe;
        const wall = blockedReason(probe);
        if (wall !== undefined) {
          throw new RecipeError("blocked", `Google Maps served a bot check (${wall}) at ${probe.url}; no reviews were returned`, { retryable: false });
        }
        const isPlace = probe.heading !== "" && (probe.hasReviewsTab || probe.hasMoreReviews || probe.reviewCards > 0 || probe.hasRating);
        if (isPlace) return;
        const refusal = o.refusal();
        if (refusal !== undefined && !probe.hasApp) {
          throw new RecipeError(
            "blocked",
            `Google Maps refused its own page script (the Maps application bundle ${refusal}), so the page never rendered; Google does this from some cloud and datacenter IPs. No reviews were returned`,
            { retryable: false },
          );
        }
        if (!consentHandled && (await dismissConsent(page))) {
          consentHandled = true;
          o.caveat(CONSENT_CAVEAT);
          await sleep(pollMs);
          continue;
        }
        if (probe.resultLinks > 0 && !clickedResult) {
          clickedResult = true;
          const labels = await page.evaluate<string[]>(RESULT_LABELS_JS).catch(() => [] as string[]);
          const index = bestResultIndex(o.subject, labels);
          const label = labels[index] ?? "";
          ctx.log.debug("google maps: opening a result", { index, label, results: labels.length });
          if (labels.length > 1 && label !== "") {
            o.caveat(`Google Maps listed ${labels.length} places for this search; the reviews are for "${label}", ${index > 0 ? "the one whose name matches" : "Google's top result"}.`);
          }
          try {
            await page.locator('a[href*="/maps/place/"]').nth(index).click({ timeout: Math.min(o.guard.cap(5000), 3000) });
          } catch (err) {
            // The result link is an overlay with no box of its own on some layouts: click it in the page instead.
            ctx.log.debug("google maps: locator click failed, clicking the link in the page", { error: errMsg(err) });
            await page.evaluate(`(() => { const a = document.querySelectorAll('a[href*="/maps/place/"]')[${index}]; if (a) a.click(); })()`).catch((e: unknown) => {
              ctx.log.warn("google maps: could not open the result", { error: errMsg(e) });
            });
          }
          await sleep(pollMs);
          continue;
        }
        if (probe.resultLinks === 0 && NO_RESULTS_RE.test(probe.text)) {
          throw new SubjectNotFoundError(`Google Maps found no place matching "${probe.title.replace(/ - Google Maps$/, "")}"`);
        }
        // Loaded, yet nothing of the app: its script was refused or never ran, even when no failed response was seen.
        if (probe.ready && !probe.hasApp && probe.textLength < SHELL_TEXT_MAX) {
          shellSince ??= Date.now();
          if (Date.now() - shellSince >= appStartMs) {
            throw new RecipeError(
              "blocked",
              `Google Maps finished loading but its application never started (no app container ${(appStartMs / 1000).toFixed(1)}s after the load event); the page's script was refused or did not run, as Google does from some cloud and datacenter IPs. No reviews were returned`,
              { retryable: false },
            );
          }
        } else {
          shellSince = undefined;
        }
      } else if (!consentHandled && (await dismissConsent(page))) {
        consentHandled = true;
        o.caveat(CONSENT_CAVEAT);
      }
      if (Date.now() >= until) {
        throw new RecipeError("timeout", `no Google Maps place page appeared within ${Math.round(budget / 1000)}s (page: ${lastProbe?.title ?? "unknown"})`);
      }
      await sleep(pollMs);
    }
  }

  /**
   * Open the Reviews tab (or "More reviews") and wait for the cards it brings.
   * Cards already on the place overview do not count: the tab replaces them,
   * and reading before the new pane arrives finds nothing.
   */
  async function openReviews(page: Page, ctx: RecipeContext, o: { guard: ReturnType<typeof timeGuard> }): Promise<void> {
    o.guard.check("before opening the reviews tab");
    const tab = page.getByRole("tab", { name: REVIEWS_TAB_RE }).first();
    const more = page.getByRole("button", { name: MORE_REVIEWS_RE }).first();
    // A place opened from a list builds its panel in stages: name and rating first, the tabs a moment later.
    const tabsBy = Date.now() + o.guard.cap(tabWaitMs);
    while ((await tab.count()) === 0 && (await more.count()) === 0 && Date.now() < tabsBy) await sleep(pollMs);
    const existing = await page.evaluate<number>(REMEMBER_CARDS_JS);
    try {
      if ((await tab.count()) > 0) {
        // Already on the Reviews tab (a place URL can open there): its cards are the ones to read.
        if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click({ timeout: o.guard.cap(5000) });
        else if (existing > 0) return;
      } else if ((await more.count()) > 0) await more.click({ timeout: o.guard.cap(5000) });
      else {
        if (existing === 0) ctx.log.debug("google maps: no reviews tab or button on the place page");
        return;
      }
    } catch (err) {
      ctx.log.warn("google maps: could not open the reviews tab", { error: errMsg(err) });
    }
    const until = Date.now() + o.guard.cap(reviewsWaitMs);
    let streak = 0;
    while (Date.now() < until) {
      streak = (await page.evaluate<number>(FRESH_CARDS_JS)) > 0 ? streak + 1 : 0;
      // Two polls in a row, so cards that flash up while the tab switches do not count.
      if (streak >= 2) return;
      await sleep(pollMs);
    }
    ctx.log.debug("google maps: no new review cards after opening the reviews", { overview_cards: existing });
  }

  /**
   * When the place panel showed no weekly hours but a "See more hours" button
   * (a place Maps opened directly shows only "Open · Closes 1 AM · See more
   * hours"), open them: back to the Overview tab if the Reviews tab replaced
   * it, then that read-only button, whose view replaces the place. Runs after
   * the reviews are read; a failure only leaves the hours out.
   */
  async function addHours(page: Page, subject: RawSubject, ctx: RecipeContext, o: { guard: ReturnType<typeof timeGuard> }): Promise<void> {
    if ((subject.hours?.length ?? 0) > 0 || o.guard.remaining() < 6000) return;
    try {
      const button = page.locator(SEE_MORE_HOURS_SELECTOR).first();
      if ((await button.count()) === 0) {
        const overview = page.getByRole("tab", { name: OVERVIEW_TAB_RE }).first();
        if ((await overview.count()) === 0) return;
        await overview.click({ timeout: o.guard.cap(3000) });
        await button.waitFor({ state: "attached", timeout: o.guard.cap(3000) });
      }
      await button.click({ timeout: o.guard.cap(3000) });
      const until = Date.now() + o.guard.cap(4000);
      while (Date.now() < until) {
        const hours = await page.evaluate<string[]>(HOURS_VIEW_JS);
        if (hours.length > 0) {
          subject.hours = hours;
          return;
        }
        await sleep(pollMs);
      }
      ctx.log.debug("google maps: the hours view showed no hours");
    } catch (err) {
      ctx.log.debug("google maps: could not read the opening hours", { error: errMsg(err) });
    }
  }

  /** Scroll the pane at most `maxScrolls` times until `per_source` cards exist, then expand the "More" buttons. */
  async function loadMore(page: Page, q: NormalizedReviewsQuery, ctx: RecipeContext, o: { guard: ReturnType<typeof timeGuard> }): Promise<void> {
    let count = await page.evaluate<number>(CARD_COUNT_JS);
    for (let i = 0; i < maxScrolls && count < q.per_source && count > 0; i++) {
      o.guard.check("while scrolling the reviews");
      const before = count;
      try {
        await page.evaluate(SCROLL_JS);
      } catch (err) {
        ctx.log.debug("google maps: scroll failed", { error: errMsg(err) });
        break;
      }
      const until = Date.now() + o.guard.cap(3000);
      do {
        await sleep(pollMs);
        count = await page.evaluate<number>(CARD_COUNT_JS);
      } while (count <= before && Date.now() < until);
      if (count <= before) break;
    }
    try {
      const expanded = await page.evaluate<number>(EXPAND_JS);
      if (expanded > 0) await sleep(Math.min(500, pollMs * 2));
    } catch (err) {
      ctx.log.debug("google maps: expanding review text failed", { error: errMsg(err) });
    }
  }

  return {
    site: GOOGLE_MAPS_REVIEWS_SITE,
    paramsSchema: NormalizedReviewsQuerySchema,
    resultSchema: ReviewSearchResultSchema,
    buildUrl,
    run,
  };
}

/** The recipe against live Google Maps. */
export const googleMapsReviewsRecipe: ReviewsRecipe = createGoogleMapsReviewsRecipe();
