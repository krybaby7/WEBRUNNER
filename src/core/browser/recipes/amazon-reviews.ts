import type { Page } from "playwright";
import { NormalizedReviewsQuerySchema, type NormalizedReviewsQuery } from "../../../schemas/reviews.js";
import {
  BASIC_PROBE_FIELDS_JS,
  MIN_PROBE_REVIEWS,
  ReviewSearchResultSchema,
  SubjectNotFoundError,
  absoluteUrl,
  assembleReview,
  assembleSubject,
  blockedReason,
  caveatSink,
  dedupeReviews,
  extractReviewsWithLlm,
  mergeSubject,
  navigateTo,
  parseCount,
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
 * Amazon customer reviews recipe (PLAN.md 14.6, 4.5, WP19b).
 *
 * Personal use only: reading Amazon automatically is against Amazon's terms
 * (PLAN.md 14.0). No stealth, no CAPTCHA solving. The recipe navigates to the
 * search page, takes the first organic result's ASIN, opens the reviews list
 * and reads `[data-hook="review"]`. It never types, never adds to a cart and
 * never clicks "Helpful".
 *
 * Verified live on 2026-10-21 from a headless Chromium in the development
 * environment (3 page loads):
 *
 *   https://www.amazon.com/s?k=Sony%20WH-1000XM5                     HTTP 200, 16 `[data-component-type="s-search-result"]`
 *     blocks; the first product link `a[href*="/dp/B0B2FCT81R"]` (hrefs carry `/ref=sr_1_1?...` and tracking params).
 *   https://www.amazon.com/product-reviews/B0B2FCT81R?reviewerType=all_reviews&sortBy=recent&pageNumber=1
 *     REDIRECTED to https://www.amazon.com/ap/signin?openid.return_to=...product-reviews... and that sign-in
 *     page was itself wrapped in Amazon's soft bot check: a 4 KB body with
 *     `form[action="/errors_page/validateCaptcha"]`, the text "Click the button below to continue
 *     shopping" and a "Continue shopping" submit button (no image CAPTCHA). The recipe reads the
 *     `/ap/signin` URL first and reports `blocked` with `needsLogin: true`, because a signed-in
 *     visitor would get the list; the "Enter the characters you see below" image CAPTCHA (same form
 *     action) is reported as plain `blocked`.
 *   https://www.amazon.com/dp/B0B2FCT81R                              HTTP 200; the product page carried
 *     `[data-hook="rating-out-of-text"]` "4.4 out of 5", `[data-hook="total-review-count"]`,
 *     `[data-hook="average-star-rating"]` and histogram rows
 *     `a[aria-label="72 percent of reviews have 5 stars"]`, but NO `[data-hook="review"]` block
 *     (the reviews medley is not rendered for signed-out automated visitors), so the reviews fixture
 *     under test/fixtures/reviews/browser/ is SYNTHETIC, following Amazon's documented review markup.
 *
 * Re-checked live on 2026-10-21 from a Claude Code cloud session (logged out): `/product-reviews/<ASIN>`
 * still redirected to `/ap/signin`, but the product page rendered its "Top reviews from the United
 * States" medley in 5 of 16 loads (13 `[data-hook="review"]` blocks under `#localTopReviews`; the
 * other loads served a variant with no medley or an empty one, and none of the last 7 loads from
 * that IP had it, so repeated visits seem to suppress it). The medley is rendered client-side (not in the served HTML) and uses its own hooks
 * for the title (`reviewTitle`, an h5) and the text (`reviewRichContentContainer`); rating
 * (`review-star-rating`), date, author (`.a-profile-name`), verified badge and helpful votes use the
 * list's hooks. Decision (PLAN.md 14.10): when the list needs a login, the recipe reads the product
 * page's medley instead, with a caveat; when no medley renders it reports the original `needs_login`.
 * Fixture: amazon-product-medley-live.html (sanitized, names replaced).
 */

export const AMAZON_REVIEWS_SITE = "amazon_reviews";
export const AMAZON_BASE_URL = "https://www.amazon.com";

export const AMAZON_NEEDS_LOGIN_MESSAGE = "Amazon shows reviews only to signed-in visitors; run accounts connect amazon";
export const AMAZON_MEDLEY_CAVEAT =
  "Amazon shows its full review list only to signed-in visitors, so these are the top reviews from the product page (up to about 13, in Amazon's own order); run accounts connect amazon to read the full list.";

const ASIN_RE = /^[A-Z0-9]{10}$/;
const CAPTCHA_TEXT_RE = /enter the characters you see below|type the characters you see in this image|sorry, we just need to make sure you.re not a robot|click the button below to continue shopping/i;
const NO_RESULTS_RE = /\bno results for\b/i;
const NO_REVIEWS_RE = /\bno customer reviews\b|\bthere are 0 (?:customer )?reviews\b|\b0 global ratings\b/i;

export interface AmazonReviewsRecipeOptions {
  /** Replaces https://www.amazon.com (tests point it at a fixture server). */
  baseUrl?: string;
  /** Longest wait for each page, in ms. Also capped at 60% of the time left. Default 30000. */
  maxWaitMs?: number;
  pollMs?: number;
  /** How long a reviews page without review blocks gets to render them before the text fallback runs. Default 4000. */
  settleMs?: number;
  /** How long the product page gets to render its "Top reviews" medley when the list needs a login. Default 10000. */
  medleyWaitMs?: number;
}

/** ASIN from an amazon.* product URL: /dp/<ASIN>, /gp/product/<ASIN>, /product-reviews/<ASIN>, or /<slug>/dp/<ASIN>. */
export function parseAmazonAsin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname) && !/(^|\.)amzn\.(com|to|eu)$/i.test(u.hostname)) return undefined;
    const m = /\/(?:dp|gp\/product|gp\/aw\/d|product-reviews)\/([A-Z0-9]{10})(?:[/?#]|$)/i.exec(u.pathname);
    const asin = m?.[1]?.toUpperCase();
    return asin !== undefined && ASIN_RE.test(asin) ? asin : undefined;
  } catch {
    return undefined;
  }
}

export function isAmazonUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const host = new URL(url).hostname;
    return /(^|\.)amazon\.[a-z.]+$/i.test(host) || /(^|\.)amzn\.(com|to|eu)$/i.test(host);
  } catch {
    return false;
  }
}

export function buildAmazonSearchUrl(subject: string, base: string = AMAZON_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/s?k=${encodeURIComponent(subject)}`;
}

export function amazonSortFor(sort: NormalizedReviewsQuery["sort"]): "recent" | "helpful" {
  return sort === "recent" ? "recent" : "helpful";
}

export function buildAmazonProductUrl(asin: string, base: string = AMAZON_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/dp/${asin}`;
}

export function buildAmazonReviewsUrl(asin: string, sort: NormalizedReviewsQuery["sort"], base: string = AMAZON_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/product-reviews/${asin}?reviewerType=all_reviews&sortBy=${amazonSortFor(sort)}&pageNumber=1`;
}

// ---------------------------------------------------------------------------
// Page probes (strings: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

interface AmazonProbe extends BasicProbe {
  signin: boolean;
  captchaForm: boolean;
  firstDp: string | null;
  reviews: number;
  hasProduct: boolean;
}

const PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const dp = document.querySelector('[data-component-type="s-search-result"] a[href*="/dp/"]');
  return {${BASIC_PROBE_FIELDS_JS}
    signin: /\\/ap\\/signin/.test(location.pathname) || !!document.querySelector('form[name="signIn"], #ap_email, #ap_email_login'),
    captchaForm: !!document.querySelector('form[action*="validateCaptcha"], #captchacharacters'),
    firstDp: dp ? dp.getAttribute("href") : null,
    reviews: document.querySelectorAll('[data-hook="review"]').length,
    hasProduct: !!document.querySelector('[data-hook="product-link"], [data-hook="rating-out-of-text"], [data-hook="total-review-count"], #cm_cr-product_info'),
  };
})()`;

interface AmazonSubject extends RawSubject {
  percentages?: Partial<Record<"1" | "2" | "3" | "4" | "5", number>> | undefined;
}

const SUBJECT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const link = document.querySelector('[data-hook="product-link"]') || document.getElementById("productTitle");
  const ratingText = document.querySelector('[data-hook="rating-out-of-text"]');
  const avgAlt = document.querySelector('[data-hook="average-star-rating"] .a-icon-alt, [data-hook="average-star-rating"]');
  const count = document.querySelector('[data-hook="total-review-count"], [data-hook="cr-filter-info-review-rating-count"]');
  const percentages = {};
  for (const el of document.querySelectorAll('[aria-label*="percent of reviews have"]')) {
    const m = /(\\d+)\\s*percent of reviews have (\\d) stars?/i.exec(el.getAttribute("aria-label") || "");
    if (m) percentages[m[2]] = Number(m[1]);
  }
  for (const row of document.querySelectorAll("#histogramTable tr, [data-hook='histogram-row']")) {
    const t = clean(row.textContent);
    const m = /(\\d)\\s*stars?\\D*(\\d+)%/i.exec(t);
    if (m && percentages[m[1]] === undefined) percentages[m[1]] = Number(m[2]);
  }
  return {
    name: link ? clean(link.textContent) : undefined,
    url: link ? (link.getAttribute("href") || location.href) : location.href,
    ratingLabel: ratingText ? clean(ratingText.textContent) : (avgAlt ? clean(avgAlt.textContent) : undefined),
    reviewCountText: count ? clean(count.textContent) : undefined,
    percentages: Object.keys(percentages).length === 5 ? percentages : undefined,
  };
})()`;

const COLLECT_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const out = [];
  for (const card of document.querySelectorAll('[data-hook="review"]')) {
    const rec = { nativeId: card.id || card.getAttribute("data-review-id") || undefined };
    const star = card.querySelector('[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt, [data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], i[data-hook*="star-rating"]');
    if (star) rec.ratingLabel = clean(star.textContent) || (star.getAttribute("class") || "").replace(/.*a-star-(\\d)(?:-(\\d))?.*/, (m, a, b) => a + (b ? "." + b : "") + " out of 5 stars");
    const title = card.querySelector('[data-hook="review-title"], [data-hook="reviewTitle"]');
    if (title) {
      const spans = Array.from(title.querySelectorAll("span")).map((s) => clean(s.textContent)).filter((t) => t && !/out of 5 stars/i.test(t));
      rec.title = spans.length ? spans[spans.length - 1] : clean(title.textContent).replace(/^\\d(?:\\.\\d)? out of 5 stars\\s*/i, "");
      const href = title.tagName === "A" ? title.getAttribute("href") : (title.querySelector("a") || {}).getAttribute ? title.querySelector("a").getAttribute("href") : null;
      if (href) rec.url = href;
    }
    const body = card.querySelector('[data-hook="review-body"], [data-hook="reviewRichContentContainer"]');
    if (body) rec.text = (body.innerText || body.textContent || "").replace(/\\s*Read more\\s*$/i, "").trim();
    const author = card.querySelector(".a-profile-name");
    if (author) rec.author = clean(author.textContent);
    const date = card.querySelector('[data-hook="review-date"]');
    if (date) rec.dateText = clean(date.textContent);
    rec.verified = !!card.querySelector('[data-hook="avp-badge"], [data-hook="avp-badge-linkless"]');
    const helpful = card.querySelector('[data-hook="helpful-vote-statement"]');
    if (helpful) rec.helpfulText = clean(helpful.textContent);
    const comment = card.querySelector('[data-hook="review-comment"], .review-comments .review-comment-text');
    if (comment) rec.responseText = clean(comment.innerText || comment.textContent);
    out.push(rec);
  }
  return out;
})()`;

const PAGE_TEXT_JS = `(() => {
  for (const sel of ['#cm_cr-review_list', '[data-hook="reviews-medley-widget"]', '#cm_cr-dp-review-list']) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || "").trim()) {
      const info = document.querySelector("#cm_cr-product_info");
      return ((info && info.innerText) || "") + "\\n\\n" + el.innerText;
    }
  }
  return document.body ? (document.body.innerText || "") : "";
})()`;

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export function createAmazonReviewsRecipe(options: AmazonReviewsRecipeOptions = {}): ReviewsRecipe {
  const baseUrl = (options.baseUrl ?? AMAZON_BASE_URL).replace(/\/+$/, "");
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const pollMs = options.pollMs ?? 300;
  const settleMs = options.settleMs ?? 4000;
  const medleyWaitMs = options.medleyWaitMs ?? 10_000;
  const site = "Amazon";

  const buildUrl = (q: NormalizedReviewsQuery): string | null => {
    const asin = parseAmazonAsin(q.subject_url);
    if (asin !== undefined) return buildAmazonReviewsUrl(asin, q.sort, baseUrl);
    if (q.subject_url !== undefined) return null;
    return buildAmazonSearchUrl(q.subject, baseUrl);
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
    const source = "amazon";

    try {
      guard.check("before navigating");
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      let asin = parseAmazonAsin(q.subject_url);
      if (asin === undefined && q.subject_url !== undefined) {
        throw new SubjectNotFoundError(`Amazon cannot look up a URL on ${new URL(q.subject_url).hostname}; pass the product's name or its Amazon URL`);
      }
      if (asin === undefined) {
        await navigateTo(page, buildAmazonSearchUrl(q.subject, baseUrl), ctx, site);
        asin = await waitForSearchResult(page, q, guard);
        ctx.log.debug("amazon: first search result", { asin });
      }

      await navigateTo(page, buildAmazonReviewsUrl(asin, q.sort, baseUrl), ctx, site);
      let state: "reviews" | "no_reviews";
      let medley = false;
      try {
        state = await waitForReviews(page, guard);
      } catch (err) {
        if (!(err instanceof RecipeError && err.needsLogin)) throw err;
        // The list wants a signed-in visitor; the product page's own top reviews often render for anyone.
        if (!(await readMedley(page, asin, ctx, guard))) throw err;
        ctx.log.debug("amazon: review list needs a login; reading the product page's top reviews", { asin });
        medley = true;
        state = "reviews";
        caveat(AMAZON_MEDLEY_CAVEAT);
      }
      const subjectRaw = await page.evaluate<AmazonSubject>(SUBJECT_JS).catch(() => ({}) as AmazonSubject);
      const subjectBase: RawSubject = {
        ...subjectRaw,
        url: absoluteUrl(subjectRaw.url, page.url()) ?? `${AMAZON_BASE_URL}/dp/${asin}`,
        distribution: distributionFromPercentages(subjectRaw, caveat),
      };
      if (state === "no_reviews") {
        caveat("Amazon lists no customer reviews for this product.");
        return { subject: assembleSubject(source, subjectBase, q.subject), reviews: [] };
      }

      guard.check("before reading reviews");
      const raws = await page.evaluate<RawReview[]>(COLLECT_JS);
      const pageUrl = page.url();
      const reviews = raws
        .map((r) => assembleReview(source, { ...r, url: absoluteUrl(r.url, pageUrl) }, { nowMs, caveat }))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
      ctx.log.debug("amazon reviews probe", { cards: raws.length, valid: reviews.length, medley });

      // The medley is short by design: whatever it shows is the answer, never a reason to call the model.
      if (reviews.length >= MIN_PROBE_REVIEWS || (medley && reviews.length > 0)) {
        return { subject: assembleSubject(source, subjectBase, q.subject), reviews: dedupeReviews(reviews, q.per_source) };
      }

      guard.check("before the fallback extraction");
      const pageText = await page.evaluate<string>(PAGE_TEXT_JS);
      const extracted = await extractReviewsWithLlm({
        site,
        source,
        pageText,
        pageUrl,
        query: q,
        ctx,
        hint: "Each review shows a reviewer name, 'N out of 5 stars', a title, 'Reviewed in <country> on <date>', optionally 'Verified Purchase', the text and 'N people found this helpful'.",
      });
      const fromLlm = reviewsFromExtraction(source, extracted, { nowMs, caveat });
      const merged = dedupeReviews([...reviews, ...fromLlm], q.per_source);
      if (merged.length === 0) caveat("Amazon showed no reviews on the first reviews page.");
      else caveat("Amazon reviews were read by the extractor model because the page structure was not recognised; fields may be incomplete.");
      return { subject: mergeSubject(source, subjectBase, extracted.subject, q.subject), reviews: merged };
    } catch (err) {
      throw toRecipeError(err, ctx, site);
    }
  }

  /** `blocked` for the sign-in redirect (with needsLogin) and for the CAPTCHA page. */
  function checkWalls(probe: AmazonProbe): void {
    if (probe.signin) {
      throw new RecipeError("blocked", AMAZON_NEEDS_LOGIN_MESSAGE, { retryable: false, needsLogin: true });
    }
    if (probe.captchaForm || (probe.textLength < 3000 && CAPTCHA_TEXT_RE.test(probe.text))) {
      throw new RecipeError("blocked", `Amazon served a CAPTCHA page at ${probe.url}; it is blocking this browser or network`, { retryable: false });
    }
    const wall = blockedReason(probe);
    if (wall !== undefined) throw new RecipeError("blocked", `Amazon served a bot check (${wall}) at ${probe.url}`, { retryable: false });
  }

  /**
   * Open the product page and wait for its client-side "Top reviews" medley.
   * True once review blocks are there; false when none render within the wait
   * (Amazon serves some visitors a variant without them). Scrolls the medley into
   * view once, half way through, in case it is lazy.
   */
  async function readMedley(page: Page, asin: string, ctx: RecipeContext, guard: TimeGuard): Promise<boolean> {
    guard.check("before opening the product page");
    await navigateTo(page, buildAmazonProductUrl(asin, baseUrl), ctx, site);
    const start = Date.now();
    const budget = Math.max(0, Math.min(medleyWaitMs, guard.remaining() * 0.5));
    let scrolled = false;
    for (;;) {
      guard.check("while waiting for the product page's reviews");
      let probe: AmazonProbe | undefined;
      try {
        probe = await page.evaluate<AmazonProbe>(PROBE_JS);
      } catch {
        // navigation under us
      }
      if (probe !== undefined) {
        if (probe.signin) return false;
        checkWalls(probe);
        if (probe.reviews > 0) return true;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= budget) return false;
      if (!scrolled && elapsed >= budget / 2) {
        scrolled = true;
        await page
          .evaluate(`(() => { const m = document.getElementById("reviewsMedley") || document.getElementById("cr-medley-top-reviews-wrapper"); if (m) m.scrollIntoView(); else window.scrollTo(0, document.body.scrollHeight * 0.6); })()`)
          .catch(() => undefined);
      }
      await sleep(pollMs);
    }
  }

  async function waitForSearchResult(page: Page, q: NormalizedReviewsQuery, guard: TimeGuard): Promise<string> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(maxWaitMs, guard.remaining() * 0.6));
    let last: AmazonProbe | undefined;
    for (;;) {
      guard.check("while waiting for Amazon search results");
      let probe: AmazonProbe | undefined;
      try {
        probe = await page.evaluate<AmazonProbe>(PROBE_JS);
      } catch {
        // navigation under us
      }
      if (probe !== undefined) {
        last = probe;
        checkWalls(probe);
        if (probe.firstDp !== null) {
          const asin = parseAmazonAsin(absoluteUrl(probe.firstDp, probe.url)) ?? asinFromPath(probe.firstDp);
          if (asin !== undefined) return asin;
        }
        if (NO_RESULTS_RE.test(probe.text)) throw new SubjectNotFoundError(`Amazon found no product matching "${q.subject}"`);
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `no Amazon search results appeared within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(pollMs);
    }
  }

  async function waitForReviews(page: Page, guard: TimeGuard): Promise<"reviews" | "no_reviews"> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(maxWaitMs, guard.remaining() * 0.6));
    let last: AmazonProbe | undefined;
    for (;;) {
      guard.check("while waiting for the Amazon reviews page");
      let probe: AmazonProbe | undefined;
      try {
        probe = await page.evaluate<AmazonProbe>(PROBE_JS);
      } catch {
        // navigation under us (the sign-in redirect)
      }
      if (probe !== undefined) {
        last = probe;
        checkWalls(probe);
        if (probe.reviews > 0) return "reviews";
        if (probe.hasProduct && NO_REVIEWS_RE.test(probe.text)) return "no_reviews";
        // A product page without review blocks: give the medley a moment, then let the fallback read the text.
        if (probe.hasProduct && Date.now() - start >= Math.min(settleMs, budget)) return "reviews";
      }
      if (Date.now() - start >= budget) {
        throw new RecipeError("timeout", `the Amazon reviews page did not render within ${Math.round(budget / 1000)}s (page: ${last?.title ?? "unknown"})`);
      }
      await sleep(pollMs);
    }
  }

  return {
    site: AMAZON_REVIEWS_SITE,
    paramsSchema: NormalizedReviewsQuerySchema,
    resultSchema: ReviewSearchResultSchema,
    buildUrl,
    run,
  };
}

function asinFromPath(href: string): string | undefined {
  const m = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i.exec(href);
  const asin = m?.[1]?.toUpperCase();
  return asin !== undefined && ASIN_RE.test(asin) ? asin : undefined;
}

/**
 * Amazon prints the histogram as percentages. With the total count known the
 * counts are derived (and said to be approximate); without it there is no distribution.
 */
export function distributionFromPercentages(
  subject: { percentages?: Partial<Record<"1" | "2" | "3" | "4" | "5", number>> | undefined; reviewCountText?: string | undefined },
  caveat: (m: string) => void,
): Record<"1" | "2" | "3" | "4" | "5", number> | undefined {
  const p = subject.percentages;
  const total = parseCount(subject.reviewCountText);
  if (p === undefined || total === undefined) return undefined;
  const keys = ["1", "2", "3", "4", "5"] as const;
  if (!keys.every((k) => typeof p[k] === "number" && Number.isFinite(p[k] as number))) return undefined;
  caveat("Amazon's rating_distribution counts are derived from the percentages it prints and the total rating count, so they are approximate.");
  const out = {} as Record<(typeof keys)[number], number>;
  for (const k of keys) out[k] = Math.round(((p[k] as number) / 100) * total);
  return out;
}

/** The recipe against live Amazon. */
export const amazonReviewsRecipe: ReviewsRecipe = createAmazonReviewsRecipe();
