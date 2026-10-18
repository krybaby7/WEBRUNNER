import { SOCIAL_TEXT_MAX_CHARS, type SocialItem, type SocialSort } from "../../schemas/social.js";

/**
 * Merging of platform results, PLAN.md 14.5: dedupe by `url`, sort, cut at
 * `max_results`. Also the text clipping every item goes through.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Plain text cut at `SOCIAL_TEXT_MAX_CHARS`; `truncated` says when it was cut. */
export function clipText(text: string, maxChars: number = SOCIAL_TEXT_MAX_CHARS): { text: string; truncated: boolean } {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (clean.length <= maxChars) return { text: clean, truncated: false };
  return { text: clean.slice(0, maxChars).trimEnd(), truncated: true };
}

/** An author as shown, never an email address (PLAN.md 14.5). Empty or email-like values are dropped. */
export function safeAuthor(author: string | null | undefined): string | undefined {
  if (author === null || author === undefined) return undefined;
  const a = author.trim();
  if (a === "" || EMAIL.test(a)) return undefined;
  return a;
}

/**
 * Enforce the text limit on items a platform produced. Platforms built here
 * already clip; this guards the merged output against one that does not.
 */
export function finalizeItem(item: SocialItem): SocialItem {
  if (item.text.length <= SOCIAL_TEXT_MAX_CHARS && !EMAIL.test(item.author ?? "")) return item;
  const { text, truncated } = clipText(item.text);
  const author = safeAuthor(item.author);
  const { author: _dropped, ...rest } = item;
  return { ...rest, ...(author !== undefined && { author }), text, truncated: truncated || item.truncated };
}

function timeOf(item: SocialItem): number | undefined {
  if (item.created_at === undefined) return undefined;
  const t = Date.parse(item.created_at);
  return Number.isNaN(t) ? undefined : t;
}

/** Descending on a possibly-unknown number; unknown values sort last. */
function descUnknownLast(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b - a;
}

/**
 * `engagement`: score descending with unknown scores last, then `created_at`
 * descending; `recent`: `created_at` descending with unknown dates last. Ties
 * fall back to the id so the order is deterministic.
 */
export function compareSocialItems(sort: SocialSort, a: SocialItem, b: SocialItem): number {
  if (sort === "engagement") {
    return descUnknownLast(a.score, b.score) || descUnknownLast(timeOf(a), timeOf(b)) || a.id.localeCompare(b.id);
  }
  return descUnknownLast(timeOf(a), timeOf(b)) || descUnknownLast(a.score, b.score) || a.id.localeCompare(b.id);
}

/** Dedupe by `url` (the first occurrence wins), sort, cut at `maxResults`. */
export function mergeSocialItems(items: SocialItem[], sort: SocialSort, maxResults: number): SocialItem[] {
  const seen = new Set<string>();
  const unique: SocialItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(finalizeItem(item));
  }
  unique.sort((a, b) => compareSocialItems(sort, a, b));
  return unique.slice(0, Math.max(0, Math.floor(maxResults)));
}
