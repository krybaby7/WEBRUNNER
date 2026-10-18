import { z } from "zod";
import type { NormalizedReviewsQuery, Review, ReviewKind, ReviewSubject } from "../../../schemas/reviews.js";
import { detectBotWall } from "../../fetch/botwall.js";
import { FetchServiceError, type FetchService } from "../../fetch/index.js";
import { LlmError, type LlmClient } from "../../llm/types.js";
import { BROWSER_LIKE_HEADERS, describeIssues, redactSecrets, requestText, statusError, type FetchImpl, type TextResponse } from "../http.js";
import {
  APPROXIMATE_DATE_CAVEAT,
  kindsDefaultingTo,
  normalizeRating,
  parseReviewDate,
  reviewId,
  toIsoUtc,
  truncateReviewText,
} from "../normalize.js";
import { ReviewSourceError, type ReviewHooks, type ReviewSearchResult, type ReviewSourceProvider } from "../types.js";

/**
 * Trustpilot (PLAN.md 14.6). The subject becomes a review page:
 *   - a `trustpilot.com/review/<x>` URL is used as is;
 *   - any other URL gives its host (without `www.`) for `/review/<host>`;
 *   - a name goes through `/search?query=<name>` and the first `/review/` link wins.
 *
 * The page is fetched raw with a browser-like User-Agent and its embedded JSON
 * is parsed: `<script id="__NEXT_DATA__">` first, JSON-LD `Review` items
 * second. The field mapping for both is FROM DOCS, UNVERIFIED: from the
 * development environment every Trustpilot URL answered with an AWS WAF
 * "Verifying Connection" challenge (HTTP 403, recorded as a fixture). That
 * challenge, or any bot wall, falls back to `FetchService.fetchPage` in auto
 * mode (which renders in the browser) and schema-driven LLM extraction over
 * the Markdown; with no LLM the source fails with `blocked`.
 */

const CANONICAL_BASE = "https://www.trustpilot.com";
/** Markdown handed to the extractor; the page's reviews sit well within this. */
const FALLBACK_MAX_CHARS = 60_000;

export interface TrustpilotOptions {
  fetchImpl?: FetchImpl;
  /** The shared fetch service; its auto mode is the way past a bot wall. */
  fetch?: FetchService;
  /** The extractor for the Markdown fallback. */
  llm?: LlmClient;
  /** Replaces https://www.trustpilot.com. For tests. */
  baseUrl?: string;
  /** Clock in epoch milliseconds, for relative dates. Default Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// __NEXT_DATA__ (from docs, unverified)
// ---------------------------------------------------------------------------

const NextReview = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  text: z.string().nullish(),
  rating: z.number().nullish(),
  likes: z.number().nullish(),
  language: z.string().nullish(),
  dates: z.object({ publishedDate: z.string().nullish(), experiencedDate: z.string().nullish() }).nullish(),
  consumer: z.object({ displayName: z.string().nullish() }).nullish(),
  reply: z.object({ message: z.string().nullish(), publishedDate: z.string().nullish() }).nullish(),
  labels: z.object({ verification: z.object({ isVerified: z.boolean().nullish() }).nullish() }).nullish(),
});
const StarCounts = z.object({
  total: z.number().nullish(),
  oneStar: z.number().nullish(),
  twoStars: z.number().nullish(),
  threeStars: z.number().nullish(),
  fourStars: z.number().nullish(),
  fiveStars: z.number().nullish(),
});
const NextBusinessUnit = z.object({
  displayName: z.string().nullish(),
  identifyingName: z.string().nullish(),
  trustScore: z.number().nullish(),
  numberOfReviews: z.union([z.number(), StarCounts]).nullish(),
  websiteUrl: z.string().nullish(),
  categories: z.array(z.object({ displayName: z.string().nullish(), name: z.string().nullish() })).nullish(),
});
const Histogram = z.object({
  total: z.number().nullish(),
  one: z.number().nullish(),
  two: z.number().nullish(),
  three: z.number().nullish(),
  four: z.number().nullish(),
  five: z.number().nullish(),
});
const NextData = z.object({
  props: z.object({
    pageProps: z.object({
      businessUnit: NextBusinessUnit.nullish(),
      reviews: z.array(NextReview).nullish(),
      filters: z.object({ reviewStatistics: z.object({ ratings: Histogram.nullish() }).nullish() }).nullish(),
    }),
  }),
});

/** HTML comments can mention the script tags we look for; they never carry the data. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function count(n: number | null | undefined): number | undefined {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function distribution(parts: Array<number | undefined>): ReviewSubject["rating_distribution"] | undefined {
  if (parts.some((p) => p === undefined)) return undefined;
  const [one, two, three, four, five] = parts as number[];
  return { "1": one as number, "2": two as number, "3": three as number, "4": four as number, "5": five as number };
}

function reviewUrl(id: string): string {
  return `${CANONICAL_BASE}/reviews/${encodeURIComponent(id)}`;
}

function clean(s: string | null | undefined): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  return t !== undefined && t !== "" ? t : undefined;
}

/** Reviews and subject from the page's `__NEXT_DATA__` script, or undefined when the page carries none. */
export function parseNextData(html: string, pageUrl: string): ReviewSearchResult | undefined {
  const m = /<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(stripComments(html));
  if (m === null) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1] as string);
  } catch {
    return undefined;
  }
  const parsed = NextData.safeParse(raw);
  if (!parsed.success) return undefined;
  const { businessUnit, reviews, filters } = parsed.data.props.pageProps;
  if (reviews === undefined || reviews === null) return undefined;

  const stars = typeof businessUnit?.numberOfReviews === "object" && businessUnit.numberOfReviews !== null ? businessUnit.numberOfReviews : undefined;
  const total = typeof businessUnit?.numberOfReviews === "number" ? businessUnit.numberOfReviews : stars?.total;
  const hist = filters?.reviewStatistics?.ratings;
  const ratingDistribution =
    distribution([count(stars?.oneStar), count(stars?.twoStars), count(stars?.threeStars), count(stars?.fourStars), count(stars?.fiveStars)]) ??
    distribution([count(hist?.one), count(hist?.two), count(hist?.three), count(hist?.four), count(hist?.five)]);
  const categories = (businessUnit?.categories ?? []).map((c) => clean(c.displayName ?? c.name)).filter((c): c is string => c !== undefined);
  const trustScore = businessUnit?.trustScore;
  const reviewCount = count(total ?? hist?.total);

  const subject: ReviewSubject = {
    source: "trustpilot",
    name: clean(businessUnit?.displayName) ?? clean(businessUnit?.identifyingName) ?? hostLabel(pageUrl),
    url: pageUrl,
    ...(typeof trustScore === "number" && Number.isFinite(trustScore) && { rating_avg: Math.min(5, Math.max(0, Math.round(trustScore * 10) / 10)) }),
    ...(reviewCount !== undefined && { review_count: reviewCount }),
    ...(ratingDistribution !== undefined && { rating_distribution: ratingDistribution }),
    ...(categories.length > 0 && { categories }),
  };

  const mapped = reviews.map((r): Review => {
    const { text, truncated } = truncateReviewText(r.text ?? "");
    const rating = typeof r.rating === "number" ? normalizeRating(r.rating, 5) : undefined;
    const author = clean(r.consumer?.displayName);
    const title = clean(r.title);
    const createdAt = toIsoUtc(r.dates?.publishedDate);
    const replyText = clean(r.reply?.message);
    const replyAt = toIsoUtc(r.reply?.publishedDate);
    const verified = r.labels?.verification?.isVerified;
    const language = clean(r.language);
    const likes = count(r.likes);
    return {
      id: reviewId("trustpilot", r.id, text),
      source: "trustpilot",
      url: reviewUrl(r.id),
      ...(author !== undefined && { author }),
      ...(rating !== undefined && { rating }),
      ...(title !== undefined && { title }),
      text,
      truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(likes !== undefined && likes > 0 && { helpful_votes: likes }),
      ...(typeof verified === "boolean" && { verified }),
      ...(language !== undefined && { language }),
      ...(replyText !== undefined && { response: { text: replyText, ...(replyAt !== undefined && { created_at: replyAt }) } }),
    };
  });
  return { subject, reviews: mapped };
}

// ---------------------------------------------------------------------------
// JSON-LD (from docs, unverified)
// ---------------------------------------------------------------------------

interface LdNode {
  [key: string]: unknown;
}

function isNode(v: unknown): v is LdNode {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typesOf(node: LdNode): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/** Every object reachable from the JSON-LD roots, depth first. */
function walk(value: unknown, out: LdNode[]): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, out);
    return;
  }
  if (!isNode(value)) return;
  out.push(value);
  for (const v of Object.values(value)) walk(v, out);
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return clean(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isNode(v)) return str(v["name"] ?? v["@value"]);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Reviews and subject from JSON-LD `Review` items, or undefined when the page has none. */
export function parseJsonLd(html: string, pageUrl: string): ReviewSearchResult | undefined {
  const nodes: LdNode[] = [];
  for (const m of stripComments(html).matchAll(/<script[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1] as string), nodes);
    } catch {
      // A malformed block is skipped; the others may still parse.
    }
  }
  const reviews = nodes.filter((n) => typesOf(n).includes("Review"));
  if (reviews.length === 0) return undefined;
  const business = nodes.find((n) => typesOf(n).some((t) => /^(?:LocalBusiness|Organization|Product|Corporation|Store)$/.test(t)) && n["name"] !== undefined);
  const aggregate = business !== undefined && isNode(business["aggregateRating"]) ? business["aggregateRating"] : undefined;
  const ratingAvg = aggregate !== undefined ? num(aggregate["ratingValue"]) : undefined;
  const reviewCount = aggregate !== undefined ? count(num(aggregate["reviewCount"] ?? aggregate["ratingCount"])) : undefined;

  const subject: ReviewSubject = {
    source: "trustpilot",
    name: (business !== undefined ? str(business["name"]) : undefined) ?? hostLabel(pageUrl),
    url: pageUrl,
    ...(ratingAvg !== undefined && { rating_avg: Math.min(5, Math.max(0, Math.round(ratingAvg * 10) / 10)) }),
    ...(reviewCount !== undefined && { review_count: reviewCount }),
  };

  const mapped = reviews.map((n): Review => {
    const { text, truncated } = truncateReviewText(str(n["reviewBody"]) ?? str(n["description"]) ?? "");
    const ratingNode = isNode(n["reviewRating"]) ? n["reviewRating"] : undefined;
    const ratingValue = ratingNode !== undefined ? num(ratingNode["ratingValue"]) : undefined;
    const best = ratingNode !== undefined ? num(ratingNode["bestRating"]) : undefined;
    const rating = ratingValue !== undefined ? normalizeRating(ratingValue, best === 10 ? 10 : best === 100 ? 100 : 5) : undefined;
    const link = str(n["url"]) ?? str(n["@id"]);
    const nativeId = link !== undefined ? /\/reviews\/([A-Za-z0-9_-]+)/.exec(link)?.[1] : undefined;
    const author = str(n["author"]);
    const title = str(n["headline"]) ?? str(n["name"]);
    const createdAt = toIsoUtc(str(n["datePublished"]));
    const language = str(n["inLanguage"]);
    const id = reviewId("trustpilot", nativeId, `${author ?? ""}\n${text}`);
    return {
      id,
      source: "trustpilot",
      ...(nativeId !== undefined ? { url: reviewUrl(nativeId) } : link !== undefined && URL.canParse(link) && { url: link }),
      ...(author !== undefined && { author }),
      ...(rating !== undefined && { rating }),
      ...(title !== undefined && { title }),
      text,
      truncated,
      ...(createdAt !== undefined && { created_at: createdAt }),
      ...(language !== undefined && { language }),
    };
  });
  return { subject, reviews: mapped };
}

// ---------------------------------------------------------------------------
// LLM extraction over Markdown (the bot-wall fallback)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = [
  "You read the Markdown of a Trustpilot company review page and return its content as structured data.",
  "Return the business as `subject`: its name, the TrustScore (a number from 1 to 5) as rating_avg, the total review count as review_count, and its categories; use null for anything the page does not show.",
  "Return every customer review on the page in `reviews`, in page order: author display name, star rating from 1 to 5, title, the full review text, the date as printed (an absolute date or a relative phrase, copied verbatim), whether the site marks it verified, its language code when shown, the business's reply text when there is one, and the review's own URL when the Markdown links to one (https://www.trustpilot.com/reviews/<id>).",
  "Copy text verbatim; never invent, merge or summarise reviews. Ignore navigation, filters, cookie notices, 'write a review' prompts and ads. If the page is a challenge or error page with no reviews, return an empty list.",
].join("\n");

const ExtractedReview = z.object({
  url: z.string().nullable(),
  author: z.string().nullable(),
  rating: z.number().min(1).max(5).nullable(),
  title: z.string().nullable(),
  text: z.string(),
  date: z.string().nullable(),
  verified: z.boolean().nullable(),
  language: z.string().nullable(),
  response: z.string().nullable(),
});
const Extraction = z.object({
  subject: z.object({
    name: z.string().nullable(),
    rating_avg: z.number().nullable(),
    review_count: z.number().int().nullable(),
    categories: z.array(z.string()).nullable(),
  }),
  reviews: z.array(ExtractedReview),
});
export type TrustpilotExtraction = z.infer<typeof Extraction>;

/** Map a validated extraction to the result shape. Exported for tests. */
export function mapExtraction(data: TrustpilotExtraction, pageUrl: string, nowMs: number, hooks?: ReviewHooks): ReviewSearchResult {
  const categories = (data.subject.categories ?? []).map((c) => clean(c)).filter((c): c is string => c !== undefined);
  const ratingAvg = data.subject.rating_avg;
  const reviewCount = count(data.subject.review_count);
  const subject: ReviewSubject = {
    source: "trustpilot",
    name: clean(data.subject.name) ?? hostLabel(pageUrl),
    url: pageUrl,
    ...(ratingAvg !== null && Number.isFinite(ratingAvg) && { rating_avg: Math.min(5, Math.max(0, Math.round(ratingAvg * 10) / 10)) }),
    ...(reviewCount !== undefined && { review_count: reviewCount }),
    ...(categories.length > 0 && { categories }),
  };
  let approximate = false;
  const reviews = data.reviews.map((r): Review => {
    const { text, truncated } = truncateReviewText(r.text);
    const nativeId = r.url !== null ? /\/reviews\/([A-Za-z0-9_-]+)/.exec(r.url)?.[1] : undefined;
    const author = clean(r.author);
    const title = clean(r.title);
    const date = r.date !== null ? parseReviewDate(r.date, nowMs) : undefined;
    if (date?.approximate === true) approximate = true;
    const rating = r.rating !== null ? normalizeRating(r.rating, 5) : undefined;
    const language = clean(r.language);
    const response = clean(r.response);
    return {
      id: reviewId("trustpilot", nativeId, `${author ?? ""}\n${text}`),
      source: "trustpilot",
      ...(nativeId !== undefined && { url: reviewUrl(nativeId) }),
      ...(author !== undefined && { author }),
      ...(rating !== undefined && { rating }),
      ...(title !== undefined && { title }),
      text,
      truncated,
      ...(date !== undefined && { created_at: date.iso }),
      ...(typeof r.verified === "boolean" && { verified: r.verified }),
      ...(language !== undefined && { language }),
      ...(response !== undefined && { response: { text: response } }),
    };
  });
  if (approximate && hooks?.caveats !== undefined && !hooks.caveats.includes(APPROXIMATE_DATE_CAVEAT)) hooks.caveats.push(APPROXIMATE_DATE_CAVEAT);
  return { subject, reviews };
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** The first `/review/<slug>` link that names a company. `/review/categories/...` links are navigation, not results. */
function firstCompanySlug(text: string, pattern: RegExp): string | undefined {
  for (const m of text.matchAll(pattern)) {
    const slug = m[1];
    if (slug !== undefined && slug.toLowerCase() !== "categories") return slug;
  }
  return undefined;
}

function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    const seg = /\/review\/([^/?#]+)/.exec(u.pathname)?.[1];
    return seg !== undefined ? decodeURIComponent(seg) : u.hostname;
  } catch {
    return "Trustpilot page";
  }
}

type HtmlOutcome = { kind: "html"; text: string } | { kind: "wall"; status: number; reason: string };

export class TrustpilotSource implements ReviewSourceProvider {
  readonly name = "trustpilot" as const;
  readonly defaultKinds: readonly ReviewKind[] = kindsDefaultingTo("trustpilot");
  private readonly fetchImpl: FetchImpl;
  private readonly fetch: FetchService | undefined;
  private readonly llm: LlmClient | undefined;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: TrustpilotOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.fetch = opts.fetch;
    this.llm = opts.llm;
    this.baseUrl = (opts.baseUrl ?? CANONICAL_BASE).replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
  }

  /** Keyless: the fast path needs nothing; the fallback needs the fetch service and the LLM. */
  isConfigured(): boolean {
    return true;
  }

  async search(q: NormalizedReviewsQuery, signal: AbortSignal, hooks?: ReviewHooks): Promise<ReviewSearchResult> {
    const pageUrl = await this.resolvePageUrl(q, signal, hooks);
    const outcome = await this.fetchHtml(pageUrl, signal, `Trustpilot has no review page at ${pageUrl}`);
    let result: ReviewSearchResult | undefined;
    if (outcome.kind === "html") {
      result = parseNextData(outcome.text, pageUrl) ?? parseJsonLd(outcome.text, pageUrl);
      if (result === undefined) {
        result = await this.extractViaFetchService(pageUrl, signal, hooks, "the page carries no embedded review JSON");
      }
    } else {
      result = await this.extractViaFetchService(pageUrl, signal, hooks, `a bot-wall challenge (${outcome.reason}, HTTP ${outcome.status})`);
    }
    return { subject: result.subject, reviews: result.reviews.slice(0, q.per_source) };
  }

  /** The review page for the subject (see the module comment). */
  private async resolvePageUrl(q: NormalizedReviewsQuery, signal: AbortSignal, hooks?: ReviewHooks): Promise<string> {
    if (q.subject_url !== undefined) {
      const u = new URL(q.subject_url);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "trustpilot.com" || host.endsWith(".trustpilot.com")) {
        const seg = /^\/review\/([^/?#]+)/.exec(u.pathname)?.[1];
        if (seg !== undefined) return `${this.baseUrl}/review/${seg}`;
        throw new ReviewSourceError(`trustpilot: ${q.subject_url} is not a company review page (trustpilot.com/review/<domain>)`, {
          source: this.name,
          code: "invalid_input",
          retryable: false,
        });
      }
      return `${this.baseUrl}/review/${host}`;
    }
    const searchUrl = `${this.baseUrl}/search?query=${encodeURIComponent(q.subject)}`;
    const outcome = await this.fetchHtml(searchUrl, signal, `Trustpilot search for "${q.subject}" returned nothing`);
    let seg: string | undefined;
    if (outcome.kind === "html") {
      seg = firstCompanySlug(outcome.text, /href="(?:https?:\/\/(?:www\.)?trustpilot\.com)?\/review\/([^"/?#]+)/gi);
    } else {
      const page = await this.renderPage(searchUrl, signal, `a bot-wall challenge on the search page (${outcome.reason}, HTTP ${outcome.status})`);
      seg = firstCompanySlug(page, /\]\((?:https?:\/\/(?:www\.)?trustpilot\.com)?\/review\/([^)\s/?#]+)/gi);
    }
    if (seg === undefined) {
      throw new ReviewSourceError(`trustpilot: no company matches "${q.subject}"`, { source: this.name, code: "not_found", retryable: false });
    }
    hooks?.caveats?.push(`trustpilot matched "${q.subject}" to the first search result, ${decodeURIComponent(seg)}.`);
    return `${this.baseUrl}/review/${seg}`;
  }

  /** Raw HTML, or the bot wall the site served instead. A 404 is `not_found`; other API-style failures throw. */
  private async fetchHtml(url: string, signal: AbortSignal, notFoundMessage: string): Promise<HtmlOutcome> {
    let res: TextResponse;
    try {
      res = await requestText({ source: this.name, url, fetchImpl: this.fetchImpl, signal, headers: { ...BROWSER_LIKE_HEADERS } });
    } catch (err) {
      // A network failure is no proof of a wall; the browser path may still work when there is one.
      if (err instanceof ReviewSourceError && err.code === "provider" && this.fetch !== undefined && this.llm !== undefined) {
        return { kind: "wall", status: 0, reason: redactSecrets(err.message) };
      }
      throw err;
    }
    const wall = detectBotWall(res.status, res.headers, res.text);
    if (wall !== undefined) return { kind: "wall", status: res.status, reason: wall };
    if (res.status === 404) throw statusError(this.name, 404, res.text, { notFoundMessage });
    if (res.status < 200 || res.status > 299) throw statusError(this.name, res.status, res.text);
    return { kind: "html", text: res.text };
  }

  /** The page as Markdown through the fetch service (auto mode renders in the browser past a wall). */
  private async renderPage(url: string, signal: AbortSignal, why: string): Promise<string> {
    if (this.fetch === undefined) {
      throw new ReviewSourceError(`trustpilot: ${why}; the fetch service is not available to render the page`, {
        source: this.name,
        code: "blocked",
        retryable: false,
      });
    }
    if (signal.aborted) throw new ReviewSourceError("trustpilot request was cancelled", { source: this.name, code: "timeout", retryable: true });
    try {
      const page = await this.fetch.fetchPage({ url, mode: "auto", max_chars: FALLBACK_MAX_CHARS });
      return page.markdown;
    } catch (err) {
      throw this.fromFetchError(err, why);
    }
  }

  private async extractViaFetchService(pageUrl: string, signal: AbortSignal, hooks: ReviewHooks | undefined, why: string): Promise<ReviewSearchResult> {
    if (this.llm === undefined) {
      throw new ReviewSourceError(`trustpilot: ${why}; reading the rendered page needs the Claude API (ANTHROPIC_API_KEY)`, {
        source: this.name,
        code: "blocked",
        retryable: false,
      });
    }
    const markdown = await this.renderPage(pageUrl, signal, why);
    let response;
    try {
      response = await this.llm.complete({
        role: "extractor",
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Page URL: ${pageUrl}\n\n<page>\n${markdown}\n</page>` }],
        schema: Extraction,
        effort: "medium",
        maxTokens: 16_000,
        ...(hooks?.meter !== undefined && { meter: hooks.meter }),
        signal,
      });
    } catch (err) {
      if (err instanceof LlmError && err.kind === "not_configured") {
        throw new ReviewSourceError(`trustpilot: ${why}; reading the rendered page needs the Claude API (${err.message})`, {
          source: this.name,
          code: "blocked",
          retryable: false,
          cause: err,
        });
      }
      throw err;
    }
    const parsed = Extraction.safeParse(response.parsed);
    if (!parsed.success) {
      throw new ReviewSourceError(`trustpilot: the extractor did not return the expected structure (${describeIssues(parsed.error.issues)})`, {
        source: this.name,
        code: "provider",
        retryable: true,
        cause: parsed.error,
      });
    }
    hooks?.caveats?.push("trustpilot reviews were read from the rendered page by the LLM extractor, not from the site's data; check details that matter.");
    return mapExtraction(parsed.data, pageUrl, this.now(), hooks);
  }

  private fromFetchError(err: unknown, why: string): ReviewSourceError {
    if (err instanceof FetchServiceError) {
      const code = err.code === "blocked" || err.code === "config" ? "blocked" : err.code === "timeout" ? "timeout" : "provider";
      return new ReviewSourceError(`trustpilot: ${why}; the browser fallback failed: ${redactSecrets(err.message)}`, {
        source: this.name,
        code,
        retryable: code === "timeout" || (code === "provider" && err.retryable),
        cause: err,
      });
    }
    return new ReviewSourceError(`trustpilot: ${why}; the browser fallback failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`, {
      source: this.name,
      code: "provider",
      retryable: false,
      cause: err,
    });
  }
}
