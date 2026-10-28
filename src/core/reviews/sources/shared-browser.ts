import { errors as playwrightErrors, type Page } from "playwright";
import { z } from "zod";
import { log as defaultLog, type Logger } from "../../../log.js";
import { ReviewSchema, ReviewSubjectSchema, type NormalizedReviewsQuery, type Review, type ReviewKind, type ReviewSource, type ReviewSubject } from "../../../schemas/reviews.js";
import { RecipeError, type Recipe, type RecipeContext } from "../../browser/recipes/types.js";
import type { BrowserSession } from "../../browser/types.js";
import { detectBotWall } from "../../fetch/browser.js";
import { LlmError, type LlmClient } from "../../llm/types.js";
import { APPROXIMATE_DATE_CAVEAT, kindsDefaultingTo, parseReviewDate, reviewId, truncateReviewText } from "../normalize.js";
import { ReviewSourceError, type ReviewHooks, type ReviewSearchResult, type ReviewSourceErrorCode, type ReviewSourceProvider } from "../types.js";

/**
 * What the browser review sources share (PLAN.md 14.6, 14.8, WP19b): the
 * provider base that drives a `Recipe` on a pooled page and maps its errors,
 * plus the recipe-side helpers (consent dismissal as in flights, bot-wall
 * detection, navigation, review assembly and the schema-driven LLM fallback).
 *
 * Browser sources only navigate, wait, scroll and click read-only controls.
 * They never type and never log in; a login wall is `blocked` with `needsLogin`.
 */

/** A browser review recipe: the normalised query in, one subject and its reviews out. */
export type ReviewsRecipe = Recipe<NormalizedReviewsQuery, ReviewSearchResult>;

export const ReviewSearchResultSchema = z.object({ subject: ReviewSubjectSchema, reviews: z.array(ReviewSchema) });

/** Default time budget for one browser source: page loads, scrolling and extraction included (PLAN.md 14.6). */
export const BROWSER_SOURCE_DEFAULT_TIMEOUT_MS = 60_000;

/** The deterministic probe must yield at least this many valid reviews or the LLM fallback runs. */
export const MIN_PROBE_REVIEWS = 3;

/** Longest page text handed to the LLM fallback. */
export const MAX_LLM_TEXT_CHARS = 30_000;

// One set of id, text and kind helpers for every review source (normalize.ts).
export { kindsDefaultingTo, reviewId, truncateReviewText };

/**
 * The subject could not be matched on the site (no search result). A
 * `RecipeError` so recipes can throw it like any other; the provider base maps
 * it to `not_found`.
 */
export class SubjectNotFoundError extends RecipeError {
  constructor(message: string) {
    super("provider", message, { retryable: false });
    this.name = "SubjectNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Small utilities shared by the recipes
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

export function isHttpUrl(value: string | undefined | null): value is string {
  if (value === undefined || value === null) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolve `href` against `base`; undefined when the result is not an http(s) URL. */
export function absoluteUrl(href: string | undefined | null, base: string): string | undefined {
  if (href === undefined || href === null || href.trim() === "") return undefined;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface TimeGuard {
  remaining(): number;
  /** Throws a `timeout` RecipeError when the deadline passed or the run was aborted. */
  check(what: string): void;
  /** `ms`, capped at what is left (never below 1 s so Playwright does not reject the option). */
  cap(ms: number): number;
}

export function timeGuard(ctx: RecipeContext, site: string): TimeGuard {
  const remaining = (): number => ctx.deadline - Date.now();
  return {
    remaining,
    check(what: string): void {
      if (ctx.signal?.aborted === true) throw new RecipeError("timeout", `${site} search aborted ${what}`);
      if (remaining() <= 0) throw new RecipeError("timeout", `${site} search ran out of time ${what}`);
    },
    cap(ms: number): number {
      return Math.max(1000, Math.min(ms, remaining()));
    },
  };
}

/** A caveat sink that pushes each sentence once. */
export function caveatSink(ctx: RecipeContext): (msg: string) => void {
  return (msg: string): void => {
    if (ctx.caveats !== undefined && !ctx.caveats.includes(msg)) ctx.caveats.push(msg);
  };
}

/**
 * The LLM client a source passes when it has none: the recipe then fails with
 * code `config` only if the deterministic probe did not produce enough reviews.
 */
export function missingLlmClient(site: string): LlmClient {
  return {
    complete: () =>
      Promise.reject(
        new RecipeError(
          "config",
          `${site} reviews could not be read deterministically and no LLM is available for the fallback extraction; set ANTHROPIC_API_KEY`,
          { retryable: false },
        ),
      ),
  };
}

// ---------------------------------------------------------------------------
// Navigation, consent and bot walls (the flights recipe's approach)
// ---------------------------------------------------------------------------

const REJECT_NAMES = [
  "reject all", "alle ablehnen", "tout refuser", "rechazar todo", "rifiuta tutto", "alles afwijzen",
  "odrzuć wszystko", "recusar tudo", "rejeitar tudo", "avvisa alla", "afvis alle", "avslå alle",
  "hylkää kaikki", "απόρριψη όλων", "отклонить все", "tümünü reddet", "odmítnout vše",
  "mindent elutasítok", "respinge tot", "respingeți tot", "refuser tout", "全部拒绝", "すべて拒否", "모두 거부",
];
const ACCEPT_NAMES = [
  "accept all", "alle akzeptieren", "tout accepter", "aceptar todo", "accetta tutto", "alles accepteren",
  "zaakceptuj wszystko", "aceitar tudo", "godkänn alla", "accepter alle", "godta alle", "hyväksy kaikki",
  "αποδοχή όλων", "принять все", "tümünü kabul et", "přijmout vše", "mindent elfogadok", "acceptați tot",
  "全部接受", "すべて同意", "모두 수락", "i agree", "ich stimme zu", "j'accepte",
];

function namesRegex(names: readonly string[]): RegExp {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^\\s*(${escaped.join("|")})\\s*$`, "i");
}
export const REJECT_RE = namesRegex(REJECT_NAMES);
export const ACCEPT_RE = namesRegex(ACCEPT_NAMES);

export const CONSENT_CAVEAT = "A cookie consent dialog was shown and dismissed (reject preferred) before reading reviews.";

/** Click the first matching consent button in any frame: reject preferred, then accept. True when one was clicked. */
export async function dismissConsent(page: Page): Promise<boolean> {
  for (const re of [REJECT_RE, ACCEPT_RE]) {
    for (const frame of page.frames()) {
      try {
        const button = frame.getByRole("button", { name: re }).first();
        if ((await button.count()) === 0) continue;
        await button.click({ timeout: 3000 });
        return true;
      } catch {
        // Not clickable (detached, covered): try the next candidate.
      }
    }
  }
  return false;
}

/** What every recipe reads from a page before deciding what it is looking at. */
export interface BasicProbe {
  url: string;
  title: string;
  text: string;
  textLength: number;
  recaptcha: boolean;
}

/** Fragment for `page.evaluate`: the fields of `BasicProbe` as object-literal entries (the project compiles without the DOM lib). */
export const BASIC_PROBE_FIELDS_JS = `
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 4000),
    textLength: text.length,
    recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha, iframe[src*="hcaptcha"], .h-captcha'),`;

export const BASIC_PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  return {${BASIC_PROBE_FIELDS_JS}
  };
})()`;

/** Why a page is a bot wall, or undefined when it looks fine. */
export function blockedReason(probe: BasicProbe): string | undefined {
  if (/\/sorry\//.test(probe.url)) return "sorry/index";
  if (probe.recaptcha) return "recaptcha";
  if (/unusual traffic/i.test(probe.text)) return "unusual traffic";
  return detectBotWall({ title: probe.title, text: probe.text, textLength: probe.textLength });
}

/**
 * Load `url` with one retry on transient failures. HTTP 403 and 429 are
 * `blocked`, 5xx is `provider`.
 */
export async function navigateTo(page: Page, url: string, ctx: RecipeContext, site: string): Promise<void> {
  const guard = timeGuard(ctx, site);
  for (let attempt = 0; ; attempt++) {
    guard.check("while loading the page");
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: guard.cap(30_000) });
      const status = response?.status();
      if (status === 429 || status === 403) {
        throw new RecipeError("blocked", `${site} answered HTTP ${status}; it is blocking this browser or network`, { retryable: false });
      }
      if (status !== undefined && status >= 500) {
        throw new RecipeError("provider", `${site} answered HTTP ${status}`, { retryable: true });
      }
      return;
    } catch (err) {
      if (err instanceof RecipeError && err.code === "blocked") throw err;
      const retryable = !(err instanceof playwrightErrors.TimeoutError) && ctx.signal?.aborted !== true;
      if (attempt >= 1 || !retryable || guard.remaining() < 8000) throw err;
      ctx.log.warn(`${site} navigation failed, retrying once`, { error: errMsg(err) });
      await sleep(1000);
    }
  }
}

/** Map anything a recipe step threw onto a `RecipeError` (or pass `LlmError` through for the caller). */
export function toRecipeError(err: unknown, ctx: RecipeContext, site: string): unknown {
  if (err instanceof RecipeError) return err;
  if (err instanceof LlmError) return err;
  const aborted = ctx.signal?.aborted === true;
  if (err instanceof playwrightErrors.TimeoutError || aborted) {
    return new RecipeError("timeout", `${site} search timed out: ${errMsg(err)}`, { cause: err });
  }
  if (ctx.deadline - Date.now() <= 0 && /closed|Target/.test(errMsg(err))) {
    return new RecipeError("timeout", `${site} search ran out of time`, { cause: err });
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(errMsg(err))?.[1];
  if (net !== undefined) {
    return new RecipeError("provider", `navigation to ${site} failed: ${net}`, { cause: err, retryable: true });
  }
  return new RecipeError("provider", `${site} recipe failed: ${errMsg(err)}`, { cause: err, retryable: false });
}

// ---------------------------------------------------------------------------
// Review assembly
// ---------------------------------------------------------------------------

/**
 * A star rating from a label or text as review sites print it: "4 stars",
 * "4.0 out of 5 stars", "Rated 4.5 stars out of five stars", "4,5 Sterne".
 * Ratings are 1..5 in half steps; anything else is undefined.
 */
export function parseStarsLabel(label: string | undefined | null): number | undefined {
  const value = parseStarsValue(label);
  return value === undefined ? undefined : normalizeStars(value);
}

/** The number in a star label without half-step rounding ("Rated 4.6 stars" -> 4.6), for subject averages. */
export function parseStarsValue(label: string | undefined | null): number | undefined {
  if (label === undefined || label === null) return undefined;
  const m = /(?:^|[^\d.])(\d(?:[.,]\d+)?)\s*(?:\/\s*5|out of (?:5|five)|stars?\b|étoiles?|sterne|estrellas?|stelle)/i.exec(label);
  if (m === null) return undefined;
  const value = Number((m[1] as string).replace(",", "."));
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : undefined;
}

export function normalizeStars(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0 || value > 5) return undefined;
  const half = Math.round(value * 2) / 2;
  return Math.min(5, Math.max(1, half));
}

/** "401K reviews" -> 401000; "12,345 global ratings" -> 12345; "1.2M" -> 1200000. */
export function parseCount(text: string | undefined | null): number | undefined {
  if (text === undefined || text === null) return undefined;
  const m = /(\d[\d,.]*)\s?([KkMm])?(?![A-Za-z])/.exec(text.replace(/\u00a0/g, " "));
  if (m === null) return undefined;
  const raw = m[1] as string;
  const suffix = m[2]?.toUpperCase();
  let n: number;
  if (suffix !== undefined) n = Number(raw.replace(",", ".")) * (suffix === "K" ? 1000 : 1_000_000);
  else n = Number(raw.replaceAll(",", "").replace(/\.(?=\d{3}\b)/g, ""));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

/** "12 people found this helpful" -> 12; "One person found this helpful" -> 1; "3 likes" -> 3. */
export function parseHelpful(text: string | undefined | null): number | undefined {
  if (text === undefined || text === null) return undefined;
  const t = text.trim();
  if (/^one person\b/i.test(t)) return 1;
  const m = /^(\d[\d,.]*)\s*([KkMm])?/.exec(t);
  return m === null ? undefined : parseCount(t);
}

/** What a probe or the LLM reads for one review before validation. */
export interface RawReview {
  nativeId?: string | undefined;
  url?: string | undefined;
  author?: string | undefined;
  /** Already on the 1..5 scale, or a label `parseStarsLabel` understands via `ratingLabel`. */
  rating?: number | undefined;
  ratingLabel?: string | undefined;
  title?: string | undefined;
  text?: string | undefined;
  /** Relative or absolute, as printed. */
  dateText?: string | undefined;
  helpfulText?: string | undefined;
  helpfulVotes?: number | undefined;
  verified?: boolean | undefined;
  version?: string | undefined;
  responseText?: string | undefined;
  responseDateText?: string | undefined;
}

export interface AssembleOptions {
  nowMs: number;
  /** Receives APPROXIMATE_DATE_CAVEAT when a relative date was approximated. */
  caveat: (msg: string) => void;
}

function clean(value: string | undefined): string | undefined {
  const v = value?.replace(/\s+/g, " ").trim();
  return v === undefined || v === "" ? undefined : v;
}

/** Validate one raw review into a `Review`, or undefined when it has no text and no rating. */
export function assembleReview(source: ReviewSource, raw: RawReview, o: AssembleOptions): Review | undefined {
  const body = truncateReviewText(raw.text ?? "");
  const rating = raw.rating !== undefined ? normalizeStars(raw.rating) : parseStarsLabel(raw.ratingLabel);
  if (body.text === "" && rating === undefined) return undefined;
  const author = clean(raw.author);
  const title = clean(raw.title);
  const date = raw.dateText !== undefined ? parseReviewDate(raw.dateText, o.nowMs) : undefined;
  if (date?.approximate === true) o.caveat(APPROXIMATE_DATE_CAVEAT);
  const helpful = raw.helpfulVotes ?? parseHelpful(raw.helpfulText);
  const responseText = raw.responseText !== undefined ? truncateReviewText(raw.responseText).text : "";
  const responseDate = raw.responseDateText !== undefined ? parseReviewDate(raw.responseDateText, o.nowMs) : undefined;
  if (responseDate?.approximate === true) o.caveat(APPROXIMATE_DATE_CAVEAT);
  const candidate = {
    id: reviewId(source, raw.nativeId, `${author ?? ""}\n${body.text !== "" ? body.text : (title ?? "")}`),
    source,
    ...(isHttpUrl(raw.url) && { url: raw.url }),
    ...(author !== undefined && { author }),
    ...(rating !== undefined && { rating }),
    ...(title !== undefined && { title }),
    text: body.text,
    truncated: body.truncated,
    ...(date !== undefined && { created_at: date.iso }),
    ...(helpful !== undefined && { helpful_votes: helpful }),
    ...(raw.verified !== undefined && { verified: raw.verified }),
    ...(clean(raw.version) !== undefined && { version: clean(raw.version) }),
    ...(responseText !== "" && {
      response: { text: responseText, ...(responseDate !== undefined && { created_at: responseDate.iso }) },
    }),
  };
  const checked = ReviewSchema.safeParse(candidate);
  return checked.success ? checked.data : undefined;
}

/** Drop duplicate ids, keep the source's order, cut at `limit`. */
export function dedupeReviews(reviews: readonly Review[], limit: number): Review[] {
  const seen = new Set<string>();
  const out: Review[] = [];
  for (const r of reviews) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export interface RawSubject {
  name?: string | undefined;
  url?: string | undefined;
  ratingLabel?: string | undefined;
  rating?: number | undefined;
  reviewCountText?: string | undefined;
  reviewCount?: number | undefined;
  distribution?: Partial<Record<"1" | "2" | "3" | "4" | "5", number>> | undefined;
  address?: string | undefined;
  categories?: readonly string[] | undefined;
  priceLevel?: string | undefined;
  /** Weekly opening hours, one "Day: hours" line per day, Monday first. */
  hours?: readonly string[] | undefined;
}

/** Validate a subject; `fallbackName` (the query subject) is used when the page gave no name. */
export function assembleSubject(source: ReviewSource, raw: RawSubject, fallbackName: string): ReviewSubject {
  const value = raw.rating ?? parseStarsValue(raw.ratingLabel);
  const rating = value !== undefined && Number.isFinite(value) && value >= 0 && value <= 5 ? Math.round(value * 10) / 10 : undefined;
  const count = raw.reviewCount ?? parseCount(raw.reviewCountText);
  const categories = [...new Set((raw.categories ?? []).map((c) => c.replace(/\s+/g, " ").trim()).filter((c) => c !== ""))];
  const hours = [...new Set((raw.hours ?? []).map((h) => h.replace(/\s+/g, " ").trim()).filter((h) => h !== ""))].slice(0, 7);
  const d = raw.distribution;
  const distribution =
    d !== undefined && (["1", "2", "3", "4", "5"] as const).every((k) => typeof d[k] === "number" && Number.isFinite(d[k] as number))
      ? { "1": Math.round(d["1"] as number), "2": Math.round(d["2"] as number), "3": Math.round(d["3"] as number), "4": Math.round(d["4"] as number), "5": Math.round(d["5"] as number) }
      : undefined;
  const candidate = {
    source,
    name: clean(raw.name) ?? fallbackName,
    ...(isHttpUrl(raw.url) && { url: raw.url }),
    ...(rating !== undefined && { rating_avg: rating }),
    ...(count !== undefined && { review_count: count }),
    ...(distribution !== undefined && { rating_distribution: distribution }),
    ...(clean(raw.address) !== undefined && { address: clean(raw.address) }),
    ...(categories.length > 0 && { categories }),
    ...(clean(raw.priceLevel) !== undefined && { price_level: clean(raw.priceLevel) }),
    ...(hours.length > 0 && { hours }),
  };
  const checked = ReviewSubjectSchema.safeParse(candidate);
  if (checked.success) return checked.data;
  return { source, name: fallbackName };
}

// ---------------------------------------------------------------------------
// Schema-driven LLM fallback (PLAN.md 4.5: selectors are a fast path only)
// ---------------------------------------------------------------------------

export const ExtractedReviewSchema = z.object({
  author: z.string().nullable().describe("Reviewer display name as printed, else null"),
  rating: z.number().nullable().describe("Stars 1..5 as printed, else null"),
  title: z.string().nullable().describe("Review title when the site shows one, else null"),
  text: z.string().describe("The review text, verbatim, without the author, date or rating"),
  date_text: z.string().nullable().describe("The date exactly as printed, e.g. '2 months ago' or 'March 3, 2026', else null"),
  helpful_votes: z.number().nullable().describe("Count of helpful votes or likes when printed, else null"),
  verified: z.boolean().nullable().describe("true when marked 'Verified Purchase' or similar, false when marked unverified, else null"),
  response_text: z.string().nullable().describe("The owner's, developer's or seller's reply text when shown, else null"),
  response_date_text: z.string().nullable().describe("The reply's date as printed, else null"),
});
export type ExtractedReview = z.infer<typeof ExtractedReviewSchema>;

export const ExtractedSubjectSchema = z.object({
  name: z.string().nullable().describe("Name of the place, app or product the page is about"),
  rating_avg: z.number().nullable().describe("Average rating 0..5 as printed, else null"),
  review_count: z.number().nullable().describe("Total number of reviews or ratings as printed, else null"),
  address: z.string().nullable(),
  categories: z.array(z.string()).describe("Category labels shown for the subject; empty when none"),
  price_level: z.string().nullable().describe("Price level such as '$$' when shown, else null"),
});

export const ReviewsExtractionSchema = z.object({ subject: ExtractedSubjectSchema, reviews: z.array(ExtractedReviewSchema) });
export type ReviewsExtraction = z.infer<typeof ReviewsExtractionSchema>;

const SYSTEM_PROMPT = [
  "You read the visible text of a review page and return the reviews on it as structured records.",
  "The page text is the only source of truth. Never use outside knowledge, never invent reviews, ratings, dates or names.",
  "Rules:",
  "- One entry per customer review visible in the text, in page order. Skip the subject's own description, navigation, ads and other products.",
  "- rating is the star count the page prints for that review (1 to 5), else null.",
  "- date_text is copied exactly as printed ('2 months ago', 'March 3, 2026'); do not convert it.",
  "- text is the review body verbatim; cut nothing unless the page itself cut it.",
  "- response_text is the owner's, developer's or seller's reply when the page shows one under the review.",
  "- subject describes the one place, app or product the page is about; copy the average rating and review count only when printed.",
].join("\n");

export interface LlmExtractionInput {
  site: string;
  source: ReviewSource;
  /** Visible text of the review pane or page. */
  pageText: string;
  pageUrl: string;
  query: NormalizedReviewsQuery;
  ctx: RecipeContext;
  /** Site-specific sentence appended to the prompt, for example where the reviews sit. */
  hint?: string;
}

/** Hand the page text to the extractor model and validate what comes back. */
export async function extractReviewsWithLlm(input: LlmExtractionInput): Promise<ReviewsExtraction> {
  const { ctx } = input;
  const text = input.pageText.length > MAX_LLM_TEXT_CHARS ? `${input.pageText.slice(0, MAX_LLM_TEXT_CHARS)}\n[truncated]` : input.pageText;
  const content = [
    `Site: ${input.site}. Subject searched: ${input.query.subject}${input.query.location !== undefined ? ` (${input.query.location})` : ""}.`,
    `Page: ${input.pageUrl}`,
    ...(input.hint !== undefined ? [input.hint] : []),
    "",
    "Page text:",
    text,
  ].join("\n");
  const remainingMs = Math.max(1000, ctx.deadline - Date.now());
  const timeoutSignal = AbortSignal.timeout(remainingMs);
  const signal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
  const response = await ctx.llm.complete({
    role: "extractor",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    schema: ReviewsExtractionSchema,
    effort: "medium",
    maxTokens: 16_000,
    ...(ctx.meter !== undefined && { meter: ctx.meter }),
    signal,
  });
  const parsed = ReviewsExtractionSchema.safeParse(response.parsed);
  if (!parsed.success) {
    throw new RecipeError("provider", `the ${input.site} extractor did not return the expected structure`, { retryable: true });
  }
  return parsed.data;
}

/** Turn an LLM extraction into validated reviews. */
export function reviewsFromExtraction(source: ReviewSource, extracted: ReviewsExtraction, o: AssembleOptions): Review[] {
  const out: Review[] = [];
  for (const r of extracted.reviews) {
    const review = assembleReview(
      source,
      {
        author: r.author ?? undefined,
        rating: r.rating ?? undefined,
        title: r.title ?? undefined,
        text: r.text,
        dateText: r.date_text ?? undefined,
        helpfulVotes: r.helpful_votes ?? undefined,
        verified: r.verified ?? undefined,
        responseText: r.response_text ?? undefined,
        responseDateText: r.response_date_text ?? undefined,
      },
      o,
    );
    if (review !== undefined) out.push(review);
  }
  return out;
}

/** Merge the LLM's subject fields into what the probe found (the probe wins where it has a value). */
export function mergeSubject(source: ReviewSource, probe: RawSubject, extracted: ReviewsExtraction["subject"], fallbackName: string): ReviewSubject {
  return assembleSubject(
    source,
    {
      ...probe,
      name: probe.name ?? extracted.name ?? undefined,
      rating: probe.rating ?? (probe.ratingLabel !== undefined ? undefined : (extracted.rating_avg ?? undefined)),
      reviewCount: probe.reviewCount ?? (probe.reviewCountText !== undefined ? undefined : (extracted.review_count ?? undefined)),
      address: probe.address ?? extracted.address ?? undefined,
      categories: probe.categories !== undefined && probe.categories.length > 0 ? probe.categories : extracted.categories,
      priceLevel: probe.priceLevel ?? extracted.price_level ?? undefined,
    },
    fallbackName,
  );
}

// ---------------------------------------------------------------------------
// Provider base
// ---------------------------------------------------------------------------

export interface BrowserReviewSourceOptions {
  /** Shared browser session. Without it the source is not configured. */
  browser?: BrowserSession;
  /** Used for the fallback extraction only. Without it a page the probe cannot read fails with code `config`. */
  llm?: LlmClient;
  /** Whole-search budget in ms. Default 60000. */
  timeoutMs?: number;
  log?: Logger;
}

/**
 * Runs a `ReviewsRecipe` on a pooled page with the deadline, the signal (which
 * closes the page so pending Playwright calls reject promptly) and a caveat
 * sink, and maps every failure onto a `ReviewSourceError`.
 */
export abstract class BrowserReviewSourceBase implements ReviewSourceProvider {
  abstract readonly name: ReviewSource;
  abstract readonly defaultKinds: readonly ReviewKind[];
  /** Human-readable site name for messages. */
  protected abstract readonly site: string;
  protected abstract readonly recipe: ReviewsRecipe;

  private readonly browser: BrowserSession | undefined;
  private readonly llm: LlmClient | undefined;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: BrowserReviewSourceOptions = {}) {
    this.browser = options.browser;
    this.llm = options.llm;
    this.timeoutMs = options.timeoutMs ?? BROWSER_SOURCE_DEFAULT_TIMEOUT_MS;
    this.logger = options.log ?? defaultLog;
  }

  isConfigured(): boolean {
    return this.browser !== undefined;
  }

  async search(q: NormalizedReviewsQuery, signal: AbortSignal, hooks: ReviewHooks = {}): Promise<ReviewSearchResult> {
    const browser = this.browser;
    if (browser === undefined) throw this.error("no browser session is available", "config", false);
    if (signal.aborted) throw this.error(`${this.site} search aborted before it started`, "timeout", true);

    let page: Page;
    try {
      page = await browser.acquire();
    } catch (err) {
      throw this.error(`could not open a browser page: ${errMsg(err)}`, "provider", true, err);
    }
    const acquired = page;
    const onAbort = (): void => {
      acquired.close().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const caveats: string[] = [];
    const surface = (): void => {
      if (hooks.caveats !== undefined) for (const c of caveats) if (!hooks.caveats.includes(c)) hooks.caveats.push(c);
    };
    try {
      const result = await this.recipe.run(acquired, q, {
        llm: this.llm ?? missingLlmClient(this.site),
        log: this.logger,
        deadline: Date.now() + this.timeoutMs,
        signal,
        caveats,
        ...(hooks.meter !== undefined && { meter: hooks.meter }),
      });
      surface();
      const checked = ReviewSearchResultSchema.safeParse(result);
      if (!checked.success) {
        throw this.error(`${this.site} recipe returned an invalid result: ${checked.error.issues[0]?.message ?? "schema"}`, "provider", false);
      }
      return {
        subject: { ...checked.data.subject, source: this.name },
        reviews: dedupeReviews(checked.data.reviews.map((r) => ({ ...r, source: this.name })), q.per_source),
      };
    } catch (err) {
      surface();
      throw this.mapError(err, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.release(acquired);
    }
  }

  private mapError(err: unknown, signal: AbortSignal): ReviewSourceError {
    if (err instanceof ReviewSourceError) return err;
    if (err instanceof SubjectNotFoundError) return this.error(err.message, "not_found", false, err);
    if (err instanceof RecipeError) {
      return new ReviewSourceError(err.message, {
        source: this.name,
        code: err.code,
        retryable: err.retryable,
        needsLogin: err.needsLogin,
        cause: err,
      });
    }
    if (err instanceof LlmError) {
      const code: ReviewSourceErrorCode = err.code === "config" ? "config" : err.code === "timeout" ? "timeout" : "provider";
      return this.error(err.message, code, err.retryable, err);
    }
    if (signal.aborted) return this.error(`${this.site} search was cancelled or timed out`, "timeout", true, err);
    return this.error(`${this.site} search failed: ${errMsg(err)}`, "provider", false, err);
  }

  private error(text: string, code: ReviewSourceErrorCode, retryable: boolean, cause?: unknown): ReviewSourceError {
    return new ReviewSourceError(text, { source: this.name, code, retryable, ...(cause !== undefined && { cause }) });
  }
}
