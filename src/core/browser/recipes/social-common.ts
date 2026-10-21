import { createHash } from "node:crypto";
import { errors as playwrightErrors, type Page } from "playwright";
import type { z } from "zod";
import {
  SOCIAL_TEXT_MAX_CHARS,
  SocialItemSchema,
  type SocialItem,
  type SocialPlatform,
  type SocialSearchQuery,
} from "../../../schemas/social.js";
import { detectBotWall } from "../../fetch/browser.js";
import { LlmError } from "../../llm/types.js";
import { RecipeError, type Recipe, type RecipeContext } from "./types.js";

/**
 * Shared plumbing for the social browser recipes (PLAN.md 14.5, WP18b):
 * X, Facebook and old.reddit. One recipe per site; each takes the
 * `SocialSearchQuery` itself as its params (`mode: "search"` carries `query`,
 * `mode: "thread"` carries `url`) and returns validated `SocialItem[]`.
 *
 * Rules every recipe follows (PLAN.md 14.0, "logged-in browsing is passive"):
 * navigate, wait, scroll and click read-only controls only (consent, age
 * gate, "view more comments"). Never `fill`, `type` or `press`; never log in,
 * like, reply, follow, share, post, join or subscribe. A login wall is
 * `RecipeError("blocked", ..., { needsLogin: true })` whose message names
 * `accounts connect <platform>`; a CAPTCHA, checkpoint or bot wall is
 * `blocked` without `needsLogin`.
 */
export type SocialRecipe = Recipe<SocialSearchQuery, SocialItem[]>;

export type BrowserSocialPlatform = Extract<SocialPlatform, "x" | "facebook" | "reddit">;

export interface SocialRecipeOptions {
  /**
   * Origin that replaces the site's own in every URL the recipe opens, for
   * example a local fixture server. Default: the live site.
   */
  baseUrl?: string;
  /** Longest wait for the first results, in ms. Also capped at 60% of the time left. Default 20000. */
  maxResultsWaitMs?: number;
  /** Pause after each scroll so lazy content can arrive, in ms. Default 1200. */
  settleMs?: number;
  /** Poll interval while waiting, in ms. Default 250. */
  pollMs?: number;
  /** Most scrolls on one page. Default 3. */
  maxScrolls?: number;
}

export interface ResolvedSocialRecipeOptions {
  baseUrl: string | undefined;
  maxResultsWaitMs: number;
  settleMs: number;
  pollMs: number;
  maxScrolls: number;
}

export function resolveOptions(options: SocialRecipeOptions): ResolvedSocialRecipeOptions {
  return {
    baseUrl: options.baseUrl?.replace(/\/+$/, ""),
    maxResultsWaitMs: options.maxResultsWaitMs ?? 20_000,
    settleMs: options.settleMs ?? 1200,
    pollMs: options.pollMs ?? 250,
    maxScrolls: options.maxScrolls ?? 3,
  };
}

/** Swap the site origin for the configured base URL (tests), or leave the URL alone. */
export function rebase(url: string, siteOrigin: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined || !url.startsWith(siteOrigin)) return url;
  return `${baseUrl}${url.slice(siteOrigin.length)}`;
}

/**
 * The inverse: a link found on a page served from the base URL, read as a link
 * on the site itself. Root-relative links resolve against the base URL's origin
 * (losing any path prefix), so a link on that origin counts as a site link too.
 */
export function unrebase(url: string, siteOrigin: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return url;
  if (url.startsWith(baseUrl)) return `${siteOrigin}${url.slice(baseUrl.length)}`;
  try {
    const u = new URL(url);
    if (u.origin === new URL(baseUrl).origin) return `${siteOrigin}${u.pathname}${u.search}`;
  } catch {
    // not a URL
  }
  return url;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function firstLine(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

export function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Time guard
// ---------------------------------------------------------------------------

export interface TimeGuard {
  remaining(): number;
  /** Throws a `timeout` RecipeError when the deadline passed or the run was aborted. */
  check(what: string): void;
  /** A navigation or wait timeout that fits in the time left (at least 1 s). */
  navTimeout(cap?: number): number;
}

export function timeGuard(ctx: RecipeContext, site: string): TimeGuard {
  const remaining = (): number => ctx.deadline - Date.now();
  return {
    remaining,
    check(what) {
      if (ctx.signal?.aborted === true) throw new RecipeError("timeout", `${site} aborted ${what}`);
      if (remaining() <= 0) throw new RecipeError("timeout", `${site} ran out of time ${what}`);
    },
    navTimeout(cap = 30_000) {
      return Math.max(1000, Math.min(remaining(), cap));
    },
  };
}

// ---------------------------------------------------------------------------
// Caveats
// ---------------------------------------------------------------------------

export type Caveat = (msg: string) => void;

export function caveatSink(ctx: RecipeContext): Caveat {
  return (msg) => {
    if (ctx.caveats !== undefined && !ctx.caveats.includes(msg)) ctx.caveats.push(msg);
  };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavigateOptions {
  site: string;
  guard: TimeGuard;
  /**
   * Map an HTTP status to a RecipeError, or return undefined to accept it.
   * The default treats 403 and 429 as `blocked` and 5xx as a retryable
   * `provider` error.
   */
  onStatus?: (status: number) => RecipeError | undefined;
}

export function defaultStatusError(site: string, status: number): RecipeError | undefined {
  if (status === 403 || status === 429) {
    return new RecipeError("blocked", `${site} answered HTTP ${status}; it is blocking this browser or network`, { retryable: false });
  }
  if (status >= 500) return new RecipeError("provider", `${site} answered HTTP ${status}`, { retryable: true });
  return undefined;
}

/**
 * Open `url` (redirects followed), map the response status, retry once on a
 * network error when there is time. Returns the final status, or undefined
 * when Playwright had none (same-document navigation).
 */
export async function navigateTo(page: Page, url: string, ctx: RecipeContext, o: NavigateOptions): Promise<number | undefined> {
  const onStatus = o.onStatus ?? ((s: number) => defaultStatusError(o.site, s));
  for (let attempt = 0; ; attempt++) {
    o.guard.check("while loading the page");
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: o.guard.navTimeout() });
      const status = response?.status();
      if (status !== undefined) {
        const err = onStatus(status);
        if (err !== undefined) {
          // A challenge page (Cloudflare serves "Just a moment..." with a 503) is a block, whatever its status says.
          const probe = await runProbe<BasicProbe>(page, probeScript());
          const wall = probe === undefined ? undefined : detectBotWall(probe);
          if (wall !== undefined) throw blockedBy(o.site, `a bot check (${wall})`, probe?.url ?? url);
          throw err;
        }
      }
      return status;
    } catch (err) {
      if (err instanceof RecipeError) throw err;
      const retryable = !(err instanceof playwrightErrors.TimeoutError) && ctx.signal?.aborted !== true;
      if (attempt >= 1 || !retryable || o.guard.remaining() < 8000) throw err;
      ctx.log.warn(`${o.site}: navigation failed, retrying once`, { error: firstLine(err) });
      await sleep(1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Page probes (strings: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

export interface BasicProbe {
  url: string;
  title: string;
  /** First 4000 characters of the visible text. */
  text: string;
  textLength: number;
  /** Visible password inputs. */
  passwordFields: number;
  /** Visible CAPTCHA widgets (reCAPTCHA, hCaptcha, Turnstile). */
  captchaWidgets: number;
}

/**
 * Build a probe script. `extra` is the body of an arrow function returning an
 * object with site-specific fields; it may use `text` (the visible body text)
 * and `visible(el)`.
 */
export function probeScript(extra = "return {};"): string {
  return `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const widgets = Array.from(document.querySelectorAll(
    '.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"]'
  )).filter((el) => visible(el) && !el.closest(".grecaptcha-badge") && el.getAttribute("data-size") !== "invisible");
  const base = {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 4000),
    textLength: text.length,
    passwordFields: Array.from(document.querySelectorAll('input[type="password"]')).filter(visible).length,
    captchaWidgets: widgets.length,
  };
  const extra = (() => { ${extra} })();
  return Object.assign(base, extra);
})()`;
}

/** Evaluate a probe, tolerating one navigation under us (the context is destroyed by a redirect). */
export async function runProbe<T extends BasicProbe>(page: Page, script: string): Promise<T | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await page.evaluate<T>(script);
    } catch {
      await sleep(300);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Login walls and bot walls
// ---------------------------------------------------------------------------

export interface WallRules {
  /** Site name for messages, e.g. "X". */
  site: string;
  /** Platform named in the `accounts connect <platform>` hint. */
  platform: BrowserSocialPlatform;
  /** The page URL of a login page or login redirect. */
  loginUrl: RegExp;
  /** Visible text that only a login wall shows (checked on short pages). */
  loginText?: RegExp;
  /** The page URL of a checkpoint or challenge (blocked, not a login). */
  blockedUrl?: RegExp;
  /** Visible text of a block the generic bot-wall table does not know (checked on short pages). */
  blockedText?: RegExp;
}

/** A login form on a page this long is more likely a header widget than a login wall. */
const LOGIN_WALL_MAX_CHARS = 4000;
const SHORT_PAGE_CHARS = 3000;

export function loginRequired(site: string, platform: BrowserSocialPlatform, detail: string): RecipeError {
  return new RecipeError("blocked", `${site} requires a logged-in session (${detail}); run accounts connect ${platform}`, {
    retryable: false,
    needsLogin: true,
  });
}

export function blockedBy(site: string, detail: string, url: string): RecipeError {
  return new RecipeError("blocked", `${site} served ${detail} at ${url}; no results were returned`, { retryable: false });
}

/**
 * Classify a probed page: checkpoint or challenge first, then the bot-wall
 * table, then login walls. Undefined when the page looks usable.
 */
export function classifyWall(probe: BasicProbe, rules: WallRules): RecipeError | undefined {
  const shortPage = probe.textLength < SHORT_PAGE_CHARS;
  if (rules.blockedUrl?.test(probe.url) === true) return blockedBy(rules.site, "a security checkpoint", probe.url);
  if (probe.captchaWidgets > 0) return blockedBy(rules.site, "a CAPTCHA", probe.url);
  if (shortPage && rules.blockedText?.test(probe.text) === true) return blockedBy(rules.site, "a network block page", probe.url);
  const wall = detectBotWall(probe);
  if (wall !== undefined) return blockedBy(rules.site, `a bot check (${wall})`, probe.url);
  if (rules.loginUrl.test(probe.url)) return loginRequired(rules.site, rules.platform, `redirected to ${probe.url}`);
  if (probe.passwordFields > 0 && probe.textLength < LOGIN_WALL_MAX_CHARS) {
    return loginRequired(rules.site, rules.platform, "the page is a login form");
  }
  if (shortPage && rules.loginText?.test(probe.text) === true) {
    return loginRequired(rules.site, rules.platform, "the page asks the visitor to log in");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/** Scroll to the bottom and wait for lazy content. */
export async function scrollDown(page: Page, settleMs: number): Promise<void> {
  try {
    await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight)");
  } catch {
    // A navigation under us; the caller probes again.
  }
  await sleep(settleMs);
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace, cut at the schema maximum and say so. */
export function clipText(raw: string): { text: string; truncated: boolean } {
  const text = raw
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= SOCIAL_TEXT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, SOCIAL_TEXT_MAX_CHARS), truncated: true };
}

const SUFFIX_MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * First count in a label: "1,234 Likes" is 1234, "1.2K" is 1200, "3M" is
 * 3000000. Undefined when there is no number.
 */
export function parseCount(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const m = /(\d+(?:[,.]\d+)*)\s*([KMB])?(?![\p{L}\d])/iu.exec(raw.replace(/\u00a0/g, " "));
  if (m === null) return undefined;
  const digits = m[1] as string;
  const suffix = m[2]?.toLowerCase();
  if (suffix !== undefined) {
    const n = Number(digits.replace(/,/g, ""));
    return Number.isFinite(n) ? Math.round(n * (SUFFIX_MULT[suffix] ?? 1)) : undefined;
  }
  const n = Number(digits.replace(/[,.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** ISO 8601 UTC from a `datetime` attribute, or undefined when it does not parse. */
export function toIso(datetime: string | null | undefined): string | undefined {
  if (datetime === null || datetime === undefined || datetime.trim() === "") return undefined;
  const ms = Date.parse(datetime);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An author string for the item: trimmed, never an email address. */
export function safeAuthor(raw: string | null | undefined): string | undefined {
  const a = raw?.trim();
  if (a === undefined || a === "" || EMAIL_RE.test(a)) return undefined;
  return a;
}

/** Keep only defined values so optional schema fields stay absent. */
export function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Validate candidates against `SocialItemSchema`, dropping (and logging) the rest, deduplicated by id. */
export function validateItems(candidates: unknown[], ctx: RecipeContext, site: string): SocialItem[] {
  const out: SocialItem[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const parsed = SocialItemSchema.safeParse(c);
    if (!parsed.success) {
      ctx.log.debug(`${site}: dropped an item that failed validation`, {
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

export interface ExtractionRequest<T> {
  site: string;
  system: string;
  content: string;
  schema: z.ZodType<T>;
}

/** One extractor call under the deadline, the caller's signal and the shared meter; the answer validated against the schema. */
export async function extractWithLlm<T>(ctx: RecipeContext, req: ExtractionRequest<T>): Promise<T> {
  const remainingMs = Math.max(1000, ctx.deadline - Date.now());
  const timeoutSignal = AbortSignal.timeout(remainingMs);
  const signal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
  const response = await ctx.llm.complete({
    role: "extractor",
    system: req.system,
    messages: [{ role: "user", content: req.content }],
    schema: req.schema,
    effort: "medium",
    maxTokens: 16_000,
    ...(ctx.meter !== undefined && { meter: ctx.meter }),
    signal,
  });
  const parsed = req.schema.safeParse(response.parsed);
  if (!parsed.success) {
    throw new RecipeError("provider", `the extractor did not return the expected structure for ${req.site}`, { retryable: true });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Normalise anything a recipe threw into a RecipeError (LlmError passes through; the provider maps its code). */
export function toRecipeError(err: unknown, ctx: RecipeContext, site: string): unknown {
  if (err instanceof RecipeError || err instanceof LlmError) return err;
  const aborted = ctx.signal?.aborted === true;
  if (err instanceof playwrightErrors.TimeoutError || aborted) {
    return new RecipeError("timeout", `${site} timed out: ${firstLine(err)}`, { cause: err });
  }
  const msg = firstLine(err);
  if (ctx.deadline - Date.now() <= 0 && /closed|Target|destroyed/.test(msg)) {
    return new RecipeError("timeout", `${site} ran out of time`, { cause: err });
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(msg)?.[1];
  if (net !== undefined) return new RecipeError("provider", `navigation to ${site} failed: ${net}`, { cause: err, retryable: true });
  return new RecipeError("provider", `${site} recipe failed: ${msg}`, { cause: err, retryable: false });
}
