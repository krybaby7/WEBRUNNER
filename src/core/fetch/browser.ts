import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { errors as playwrightErrors, type Page } from "playwright";
import TurndownService from "turndown";
import { log } from "../../log.js";
import type { BrowserSession } from "../browser/types.js";
import { FetchError, type FetchOpts, type FetchResult, type Fetcher } from "./types.js";

/**
 * Browser fetcher, PLAN.md 3.2 (browser mode) and 4.2.
 *
 * Navigates in the shared persistent context, waits for the page to settle,
 * extracts the main content with Mozilla Readability on the live DOM and
 * converts it to Markdown on the Node side.
 */

// -- bot-wall detection ----------------------------------------------------------

/**
 * Signature table, matched against the rendered title and visible body text
 * (never raw HTML). The same signatures as the fast path, duplicated here on
 * purpose so the two fetchers stay independent.
 *
 * Title signatures always apply. Body signatures apply only when the visible
 * text is short, so a long article that merely mentions "please enable
 * JavaScript" is not mistaken for a challenge page.
 */
const BOT_WALL_SIGNATURES: ReadonlyArray<{ name: string; where: "title" | "body"; pattern: RegExp }> = [
  { name: "cloudflare-challenge-title", where: "title", pattern: /^\s*just a moment/i },
  { name: "cloudflare-attention-title", where: "title", pattern: /attention required!?\s*\|\s*cloudflare/i },
  { name: "access-denied-title", where: "title", pattern: /^\s*access denied\b/i },
  { name: "robot-check-title", where: "title", pattern: /\b(are you a robot|robot check|security check)\b/i },
  { name: "captcha-title", where: "title", pattern: /\bcaptcha\b/i },
  { name: "imperva-title", where: "title", pattern: /pardon our interruption/i },
  { name: "cloudflare-checking-browser", where: "body", pattern: /checking your browser before accessing/i },
  { name: "cloudflare-verify", where: "body", pattern: /(verifying|verify) (that )?you are (a )?human|performing security verification/i },
  { name: "enable-js-and-cookies", where: "body", pattern: /enable javascript and cookies to continue/i },
  { name: "enable-js", where: "body", pattern: /(please|you need to) enable javascript/i },
  { name: "captcha-body", where: "body", pattern: /\b(captcha|recaptcha|hcaptcha)\b/i },
  { name: "unusual-traffic", where: "body", pattern: /unusual traffic from your computer network/i },
  { name: "press-and-hold", where: "body", pattern: /press\s*(&|and)\s*hold/i },
  { name: "blocked", where: "body", pattern: /(you have been blocked|access to this page has been denied|request unsuccessful\. incapsula)/i },
];

const SHORT_BODY_CHARS = 3000;

export interface PageProbe {
  title: string;
  text: string;
  textLength: number;
}

/** Name of the first matching signature, or undefined when the page looks fine. */
export function detectBotWall(probe: PageProbe): string | undefined {
  for (const sig of BOT_WALL_SIGNATURES) {
    if (sig.where === "title") {
      if (sig.pattern.test(probe.title)) return sig.name;
    } else if (probe.textLength < SHORT_BODY_CHARS && sig.pattern.test(probe.text)) {
      return sig.name;
    }
  }
  return undefined;
}

// -- in-page scripts (strings, because this project compiles without the DOM lib) -----

const PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  return { title: document.title || "", text: text.slice(0, 4000), textLength: text.length };
})()`;

/** Function expression, run against the live DOM. Expects a global `Readability`. */
const EXTRACT_FN = `(function () {
  var text = document.body ? (document.body.innerText || "") : "";
  var result = { title: document.title || "", html: "", bodyText: text, readable: false, error: "" };
  try {
    if (typeof Readability === "function") {
      var article = new Readability(document.cloneNode(true)).parse();
      if (article && article.content && article.textContent && article.textContent.trim()) {
        // Parse into an inert document (no image loads, no handlers), then absolutize links.
        var doc = new DOMParser().parseFromString(article.content, "text/html");
        var base = document.baseURI;
        var fix = function (el, attr) {
          var v = el.getAttribute(attr);
          if (!v) return;
          try { el.setAttribute(attr, new URL(v, base).href); } catch (e) { /* leave as is */ }
        };
        doc.querySelectorAll("a[href]").forEach(function (el) { fix(el, "href"); });
        doc.querySelectorAll("img[src]").forEach(function (el) { fix(el, "src"); });
        result.html = doc.body.innerHTML;
        result.readable = true;
        if (article.title) result.title = article.title;
      }
    }
  } catch (e) {
    result.error = String(e);
  }
  return result;
})`;

interface Extracted {
  title: string;
  html: string;
  bodyText: string;
  readable: boolean;
  error: string;
}

let readabilitySource: string | undefined;
function loadReadabilitySource(): string {
  readabilitySource ??= readFileSync(
    createRequire(import.meta.url).resolve("@mozilla/readability/Readability.js"),
    "utf8",
  );
  return readabilitySource;
}

/** Inject Readability via addScriptTag; on pages whose CSP blocks that, evaluate it inline instead. */
async function extractFromPage(page: Page): Promise<Extracted> {
  const source = loadReadabilitySource();
  let injected = false;
  try {
    await page.addScriptTag({ content: source });
    injected = (await page.evaluate<boolean>(`typeof Readability === "function"`)) === true;
  } catch {
    // CSP or navigation raced us; fall through to inline evaluation.
  }
  if (injected) return page.evaluate<Extracted>(`${EXTRACT_FN}()`);
  return page.evaluate<Extracted>(`(function () {\n${source}\n;return (${EXTRACT_FN})();\n})()`);
}

// -- markdown ----------------------------------------------------------------------------

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  td.remove(["script", "style", "noscript"]);
  return td;
}

function normalizeWhitespace(s: string): string {
  return s.replaceAll("\r\n", "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateMarkdown(md: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (md.length <= maxChars) return { markdown: md, truncated: false };
  let cut = md.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
  return { markdown: cut, truncated: true };
}

// -- fetcher ---------------------------------------------------------------------------------

export interface BrowserFetcherOptions {
  /**
   * How long to keep re-checking a page that looks like a bot wall before
   * giving up. Managed challenges often clear themselves in a few seconds in
   * a real browser. Bounded by the fetch timeout. Default 4000.
   */
  challengeGraceMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class BrowserFetcher implements Fetcher {
  readonly name = "browser" as const;
  private readonly challengeGraceMs: number;
  private readonly turndown = createTurndown();

  constructor(
    private readonly session: BrowserSession,
    options: BrowserFetcherOptions = {},
  ) {
    this.challengeGraceMs = options.challengeGraceMs ?? 4000;
  }

  isConfigured(): boolean {
    return true;
  }

  async fetch(url: string, opts: FetchOpts, signal: AbortSignal): Promise<FetchResult> {
    this.assertHttpUrl(url);
    if (signal.aborted) throw this.abortedError();

    const deadline = Date.now() + opts.timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());

    let page: Page | undefined;
    let onAbort: (() => void) | undefined;
    try {
      page = await this.session.acquire();
      const acquired = page;
      onAbort = (): void => {
        // Closing the page makes every pending Playwright call on it reject promptly.
        acquired.close().catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      // A JS alert/confirm/prompt would freeze the page forever.
      acquired.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });

      const response = await acquired.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
      const status = response?.status();

      if (opts.waitFor !== undefined) {
        await acquired.waitForSelector(opts.waitFor, { timeout: remaining() });
      } else {
        // Many pages never reach network idle (analytics, polling). The cap is
        // the fetch timeout; running into it is not an error, we extract what is there.
        await acquired.waitForLoadState("networkidle", { timeout: remaining() }).catch((err: unknown) => {
          if (!(err instanceof playwrightErrors.TimeoutError)) throw err;
          log.debug("networkidle not reached, extracting anyway", { url });
        });
      }

      const probe = await this.checkForBotWall(acquired, remaining);
      if (probe.wall !== undefined) {
        throw new FetchError("browser", "blocked", `bot wall detected (${probe.wall}) at ${acquired.url()}`, false, status);
      }
      if (status !== undefined && status >= 400) {
        if ((status === 403 || status === 429) && probe.probe.textLength < 500) {
          throw new FetchError("browser", "blocked", `blocked with HTTP ${status} at ${acquired.url()}`, false, status);
        }
        if (status !== 403 && status !== 429) {
          throw new FetchError("browser", "provider", `HTTP ${status} from ${acquired.url()}`, status >= 500, status);
        }
      }

      const extracted = await extractFromPage(acquired);
      if (extracted.error !== "") log.debug("readability failed in page", { url, error: extracted.error });

      const markdown = extracted.readable
        ? normalizeWhitespace(this.turndown.turndown(extracted.html))
        : normalizeWhitespace(extracted.bodyText);
      if (markdown === "") {
        throw new FetchError("browser", "provider", `page at ${acquired.url()} produced no extractable text`, true, status);
      }

      const out = truncateMarkdown(markdown, opts.maxChars);
      return {
        url,
        final_url: acquired.url(),
        title: extracted.title.trim() || (await acquired.title()),
        markdown: out.markdown,
        truncated: out.truncated,
        method: "browser",
        fetched_at: new Date().toISOString(),
        botWall: false,
      };
    } catch (err) {
      throw this.toFetchError(err, signal, url);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      if (page !== undefined) await this.session.release(page);
    }
  }

  /** Probe the page, re-probing during the grace window if it looks like a challenge that may clear. */
  private async checkForBotWall(
    page: Page,
    remaining: () => number,
  ): Promise<{ wall: string | undefined; probe: PageProbe }> {
    let probe = await page.evaluate<PageProbe>(PROBE_JS);
    let wall = detectBotWall(probe);
    if (wall === undefined) return { wall, probe };

    const graceEnd = Date.now() + Math.min(this.challengeGraceMs, remaining());
    while (wall !== undefined && Date.now() < graceEnd) {
      await sleep(500);
      try {
        probe = await page.evaluate<PageProbe>(PROBE_JS);
        wall = detectBotWall(probe);
      } catch {
        // The challenge navigated the page under us; probe again next round.
      }
    }
    if (wall === undefined) {
      await page.waitForLoadState("domcontentloaded", { timeout: remaining() }).catch(() => undefined);
    }
    return { wall, probe };
  }

  private assertHttpUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchError("browser", "invalid_input", `not a valid URL: ${url}`, false);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new FetchError("browser", "invalid_input", `unsupported URL scheme ${parsed.protocol}`, false);
    }
  }

  private abortedError(): FetchError {
    return new FetchError("browser", "timeout", "browser fetch aborted", true);
  }

  private toFetchError(err: unknown, signal: AbortSignal, url: string): FetchError {
    if (err instanceof FetchError) return err;
    if (signal.aborted) return this.abortedError();
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof playwrightErrors.TimeoutError) {
      return new FetchError("browser", "timeout", `timed out loading ${url}: ${firstLine(message)}`, true);
    }
    const net = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
    if (net !== undefined) {
      const permanent = net === "ERR_NAME_NOT_RESOLVED" || net === "ERR_INVALID_URL" || net === "ERR_UNSAFE_PORT";
      return new FetchError("browser", "provider", `navigation to ${url} failed: ${net}`, !permanent);
    }
    return new FetchError("browser", "provider", `browser fetch of ${url} failed: ${firstLine(message)}`, false);
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}
