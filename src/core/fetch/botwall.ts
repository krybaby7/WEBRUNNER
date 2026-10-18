/**
 * Bot-wall classification for the fast fetch path (PLAN.md section 4.2).
 *
 * `classifyBotWall` answers one question: does this response look like an
 * anti-bot interstitial rather than the page that was asked for? A true result
 * makes auto mode fall back to the browser engine.
 *
 * Thin-but-legitimate pages (HTTP 200 with under 500 characters of visible
 * text) are deliberately NOT bot walls: they are reported through `isThin` so
 * the caller can decide separately.
 */

/** A page is "thin" when it has this many visible characters or fewer. */
export const THIN_THRESHOLD_CHARS = 500;

/** Body signatures only fire on pages with less visible text than this. */
const SHORT_PAGE_CHARS = 2000;

/** A 403 or 429 with less visible text than this counts as a bot wall by itself. */
const SHORT_ERROR_BODY_CHARS = 1000;

/** Only the head of very large bodies is scanned for signatures. */
const SCAN_LIMIT_CHARS = 200_000;

export type HeaderBag = Headers | Record<string, string>;

function normalizeHeaders(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The text a reader would see, as a single whitespace-collapsed string. Works
 * on HTML and on Markdown (links reduced to their labels, images dropped,
 * list/heading/table markers removed).
 */
export function visibleText(input: string): string {
  const s = input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? " ")
    // Markdown: images, links, block markers, table rules and pipes.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+>]|\d+\.)\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/[|`*_~]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function visibleTextLength(input: string): number {
  return visibleText(input).length;
}

/**
 * True when the Markdown (or HTML) has {@link THIN_THRESHOLD_CHARS} or fewer
 * visible characters. This is the complement of the "more than 500 chars of
 * body text" rule in PLAN.md section 3.2.
 */
export function isThin(markdown: string): boolean {
  return visibleTextLength(markdown) <= THIN_THRESHOLD_CHARS;
}

export interface BotWallSignature {
  /** Stable identifier, used in logs and tests. */
  id: string;
  /** Header check on lowercased header names. A hit is decisive at any status and body length. */
  header?: (headers: Record<string, string>) => boolean;
  /** Body pattern, matched against the raw body. */
  body?: RegExp;
  /**
   * "short": fires only on pages with little visible text, so articles that
   * merely mention the phrase are safe. "error": also fires on any non-2xx
   * response, whatever its length.
   */
  scope?: "short" | "error";
}

/**
 * Signature table. Add a row to teach the classifier a new vendor or phrase.
 */
export const BOT_WALL_SIGNATURES: readonly BotWallSignature[] = [
  // Cloudflare
  { id: "cloudflare-mitigated-header", header: (h) => /challenge/i.test(h["cf-mitigated"] ?? "") },
  {
    id: "cloudflare-just-a-moment",
    body: /<title>\s*just a moment\.{0,3}\s*<\/title>|^\s*just a moment\.{3}/i,
    scope: "error",
  },
  { id: "cloudflare-chl-marker", body: /cf[-_]chl|_cf_chl_opt|\/cdn-cgi\/challenge-platform\//i, scope: "error" },
  { id: "cloudflare-turnstile", body: /challenges\.cloudflare\.com\/(?:turnstile|cdn-cgi)/i, scope: "short" },
  {
    id: "cloudflare-attention",
    body: /attention required!\s*\|\s*cloudflare|sorry, you have been blocked/i,
    scope: "error",
  },
  {
    id: "cloudflare-verify-human",
    body: /verify(?:ing)? you are (?:a )?human|checking if the site connection is secure|checking your browser before accessing/i,
    scope: "short",
  },
  // JavaScript-required interstitials and SPA shells
  {
    id: "enable-javascript",
    body: /please enable javascript|enable javascript and cookies to continue|javascript is (?:required|disabled)|you need to enable javascript|this (?:site|page|website) requires javascript/i,
    scope: "short",
  },
  // Akamai
  {
    id: "akamai-reference",
    body: /you don'?t have permission to access[\s\S]{0,200}on this server[\s\S]{0,200}reference\s*#\s*[\w.]+/i,
    scope: "error",
  },
  { id: "akamai-bot-manager", body: /_abck|akamai-?bot|ak_bmsc|bm-verify/i, scope: "short" },
  // PerimeterX / HUMAN
  {
    id: "perimeterx",
    body: /px-captcha|perimeterx|_pxhd|px-cdn\.net|press\s*(?:&amp;|&)\s*hold to confirm you are/i,
    scope: "error",
  },
  // DataDome, Imperva/Incapsula, Sucuri
  { id: "datadome", body: /captcha-delivery\.com|datadome/i, scope: "short" },
  { id: "incapsula", body: /_incapsula_resource|incapsula incident id/i, scope: "error" },
  { id: "sucuri", body: /sucuri website firewall|access denied - sucuri/i, scope: "short" },
  // Generic phrases
  { id: "access-denied", body: /\baccess denied\b|\baccess to this page has been denied\b/i, scope: "short" },
  {
    id: "unusual-traffic",
    body: /unusual traffic from your (?:computer )?network|are you a robot\??|confirm you(?:'|’)?re not a robot/i,
    scope: "short",
  },
  { id: "captcha-page", body: /<title>[^<]*captcha[^<]*<\/title>/i, scope: "short" },
];

/**
 * Returns the id of the first matching signature, or undefined. Exposed so
 * callers and tests can log why a response was classified as a bot wall.
 */
export function detectBotWall(status: number, headers: HeaderBag, bodyText: string): string | undefined {
  const body = bodyText.length > SCAN_LIMIT_CHARS ? bodyText.slice(0, SCAN_LIMIT_CHARS) : bodyText;
  const lowered = normalizeHeaders(headers);
  const visibleLength = visibleTextLength(body);

  const isShort = visibleLength < SHORT_PAGE_CHARS;
  const isError = status >= 400 || status < 200;

  for (const sig of BOT_WALL_SIGNATURES) {
    if (sig.header?.(lowered)) return sig.id;
    const applies = sig.scope === "error" ? isError || isShort : isShort;
    if (sig.body && applies && sig.body.test(body)) return sig.id;
  }

  if ((status === 403 || status === 429) && visibleLength < SHORT_ERROR_BODY_CHARS) {
    return `http-${status}-short-body`;
  }
  return undefined;
}

/**
 * True when the response looks like a bot wall. A 200 response with a thin
 * body and no signature is NOT a bot wall; use {@link isThin} for that.
 */
export function classifyBotWall(status: number, headers: HeaderBag, bodyText: string): boolean {
  return detectBotWall(status, headers, bodyText) !== undefined;
}
