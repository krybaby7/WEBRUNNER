import type { NoteClaim } from "./types.js";

/**
 * Checks that an extractor quote comes from the page the extractor was shown.
 *
 * The extractor is asked for verbatim quotes, but nothing guaranteed it, and
 * the writer's quotes are only checked against the extractor's. So every
 * extractor quote is checked here against the page text, in tiers that go
 * from strict to lenient. The check must never lose true information: a claim
 * whose quote fails every tier is kept, with an empty quote and low confidence.
 *
 * Tiers, first match wins:
 * 1. exact: the quote is a substring of the page as shown.
 * 2. normalized: the same after `normalizeForMatch` on both sides, also
 *    against the page with its parentheticals left out, since quotes often
 *    skip a "(born 1879)" or a pronunciation.
 * 3. stitched: a quote joined with ellipses passes when each fragment of a
 *    useful length is found, in order.
 * 4. fuzzy: word-level. The quote lines up, in order, with one contiguous
 *    stretch of the page, with edits worth at most 15 percent of its words:
 *    page words the quote left out, and small function words ("the", "of")
 *    the quote added or changed. Every other quote word, numbers included,
 *    must be on the page in that stretch, and no negation may be added or lost.
 */

/**
 * Fragments of an ellipsis-stitched quote shorter than this (after
 * normalization) need not be found. Twenty characters is three or four words:
 * shorter pieces such as "and", "In 2021," or "the report said" occur on
 * almost any page, so finding them proves nothing, and models use them as glue
 * around an ellipsis. A short fragment that carries a digit is still required,
 * since a number is a fact. A stitched quote needs at least one fragment this
 * long to pass.
 */
export const MIN_FRAGMENT_CHARS = 20;

/**
 * The fuzzy tier allows edits worth up to 100 minus this percent of the
 * quote's words: one slip in a 7 to 13 word quote, six or seven in a
 * 300-character one. That covers the copying slips models make (a dropped
 * word or footnote marker, an added or swapped article) while an invented
 * quote, whose content words are not on the page in order, fails however long
 * it is. Quotes of six words or fewer get no edits: there one slip is already
 * a sixth of the meaning.
 */
export const FUZZY_MIN_MATCH_PERCENT = 85;

export type QuoteMatch = "exact" | "normalized" | "stitched" | "fuzzy" | "unverified" | "empty";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const ZERO_WIDTH_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi;
/** Turndown escapes Markdown characters in text ("1\. ", "\_", "\["); models copy them without the backslash. */
const MD_ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|~<>])/g;
/** Horizontal rules and table separator rows: lines of only `-`, `|`, `:`, `*` or `_`. */
const RULE_LINE_RE = /^[ \t]*(?:(?:[|:-][ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm;
/**
 * Blockquote, heading and bullet markers at the start of a line. Ordered-list
 * numbers ("2. ") are left alone so that normalizing a quote never removes a
 * digit from it.
 */
const LINE_MARKER_RE = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|[-*+\u2022\u2013\u2014][ \t]+)?/gm;
/** `[text](url)`, `![alt](src)` and `[text][ref]`, kept as their text. Link text may hold one level of brackets. */
const MD_LINK_RE = /!?\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g;
/** Footnote markers such as "[12]", which models leave out when copying. */
const FOOTNOTE_RE = /\[\d{1,3}\]/g;
/** Emphasis, code, strikethrough and table markup, and leftover brackets. */
const MARKUP_RE = /[*_`~|[\]]/g;
/** Quote marks and apostrophes, straight or curly, are dropped: models swap and drop them inside JSON strings. */
const QUOTE_MARK_RE = /["'\u2018-\u201F\u2032\u2033\u00AB\u00BB\u2039\u203A\u02BC]/g;
/** Hyphens, en and em dashes, the minus sign and their variants. */
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
/** A thousands separator between digit groups: "1,000" and "1 000" read as "1000". It never removes a digit. */
const DIGIT_GROUP_RE = /(\d)[ ,](?=\d{3}(?!\d))/g;
/** Punctuation trimmed from both ends of a quote: a sentence end the model added, or an ellipsis. */
const EDGE_PUNCT_RE = /^[\s.,;:!?()[\]{}]+|[\s.,;:!?()[\]{}]+$/g;

/**
 * Text reduced to what a quote check should compare: Unicode NFKC, no
 * zero-width characters, Markdown links and images reduced to their text,
 * emphasis, code, table and heading or bullet markup removed, quote marks and
 * apostrophes removed, every dash a "-", "…" read as "...", thousands
 * separators removed, whitespace collapsed to single spaces, lower case.
 * Applied to both sides of a comparison.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC") // also turns "…" into "...", non-breaking spaces into spaces, full-width forms into ASCII
    .replace(ZERO_WIDTH_RE, "")
    .replace(ENTITY_RE, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(MD_ESCAPE_RE, "$1")
    .replace(RULE_LINE_RE, "")
    .replace(LINE_MARKER_RE, "")
    .replace(MD_LINK_RE, "$1")
    .replace(FOOTNOTE_RE, "")
    .replace(MARKUP_RE, "")
    .replace(QUOTE_MARK_RE, "")
    .replace(DASH_RE, "-")
    .replace(/\s+/g, " ")
    .replace(/ ?-+ ?/g, "-")
    .replace(DIGIT_GROUP_RE, "$1")
    .toLowerCase()
    .trim();
}

/** A quote normalized for a substring search, without the punctuation at its ends. */
export function quoteNeedle(quote: string): string {
  return normalizeForMatch(quote).replace(EDGE_PUNCT_RE, "");
}

// ---------------------------------------------------------------------------
// Ellipsis fragments
// ---------------------------------------------------------------------------

/** "…", "...", ". . ." and the bracketed forms "[...]" and "(…)". */
const ELLIPSIS_RE = /[[(]?[ \t]*(?:\u2026|\.(?:[ \t]?\.){2,})[ \t]*[\])]?/;

/**
 * The fragments of an ellipsis-stitched quote that must be found, as needles,
 * or undefined when the quote has no ellipsis or no fragment long enough to be
 * evidence.
 */
function requiredFragments(quote: string): string[] | undefined {
  const pieces = quote.normalize("NFKC").split(ELLIPSIS_RE);
  if (pieces.length < 2) return undefined;
  const needles = pieces.map(quoteNeedle).filter((n) => n !== "");
  if (!needles.some((n) => n.length >= MIN_FRAGMENT_CHARS)) return undefined;
  return needles.filter((n) => n.length >= MIN_FRAGMENT_CHARS || /\d/.test(n));
}

function foundInOrder(haystack: string, needles: readonly string[]): boolean {
  let from = 0;
  for (const n of needles) {
    const at = haystack.indexOf(n, from);
    if (at < 0) return false;
    from = at + n.length;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Word-level fuzzy match
// ---------------------------------------------------------------------------

/** Words and numbers. A number keeps its decimal point ("3.5"); letters and digits split ("capital1" is two tokens). */
const TOKEN_RE = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}]+/gu;
/**
 * Articles, prepositions, conjunctions and pronouns: the only words a quote
 * may add or change in the fuzzy tier. Verbs are left out on purpose, so "was"
 * for "is" or "will" for "would" is not forgiven.
 */
const FUNCTION_WORDS = new Set(
  (
    "a an the and or of in on at to for from by with as into onto about over under " +
    "that this these those which who whom whose it its their there they them his her he she we our"
  ).split(" "),
);
/** Words whose loss or gain flips a statement. Apostrophes are already gone: "don't" is "dont". */
const NEGATIONS = new Set([
  "no",
  "not",
  "never",
  "none",
  "nor",
  "neither",
  "nothing",
  "nobody",
  "nowhere",
  "without",
  "cannot",
  "cant",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "wont",
  "wouldnt",
  "shouldnt",
  "couldnt",
  "hasnt",
  "havent",
  "hadnt",
  "mustnt",
  "neednt",
  "aint",
]);

function tokenize(normalized: string): string[] {
  return normalized.match(TOKEN_RE) ?? [];
}

const BLOCKED = 1 << 20;

/**
 * Semi-global edit distance over words: the cheapest way to line the quote up
 * with some contiguous stretch of the page starting at or after `from`.
 * Returns the end (exclusive) of the earliest stretch within `maxEdits`, or -1.
 *
 * One edit each: a page word the quote left out (never a negation); a
 * function word the quote added; a function word changed for another. Any
 * other word of the quote, numbers included, must match a page word: a quote
 * cannot slip in a name, a number or a "not" that the page does not have
 * there. A number on the page that the quote leaves out (a footnote marker,
 * say) costs one edit like any other page word.
 */
function fuzzyFind(quote: readonly string[], page: readonly string[], from: number, maxEdits: number): number {
  const m = quote.length;
  const quoteSmall = quote.map((w) => FUNCTION_WORDS.has(w));
  const addCost = quoteSmall.map((small) => (small ? 1 : BLOCKED));
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= m; i++) prev[i] = Math.min(BLOCKED, (prev[i - 1] ?? 0) + (addCost[i - 1] ?? BLOCKED));
  for (let j = from; j < page.length; j++) {
    const word = page[j] ?? "";
    const leaveOutCost = NEGATIONS.has(word) ? BLOCKED : 1;
    const pageSmall = FUNCTION_WORDS.has(word);
    cur[0] = 0;
    for (let i = 1; i <= m; i++) {
      const change = quote[i - 1] === word ? 0 : pageSmall && quoteSmall[i - 1] === true ? 1 : BLOCKED;
      const best = Math.min(
        (prev[i - 1] ?? 0) + change,
        (prev[i] ?? 0) + leaveOutCost,
        (cur[i - 1] ?? 0) + (addCost[i - 1] ?? BLOCKED),
      );
      cur[i] = Math.min(BLOCKED, best);
    }
    if ((cur[m] ?? BLOCKED) <= maxEdits) return j + 1;
    [prev, cur] = [cur, prev];
  }
  return -1;
}

function fuzzyInOrder(page: readonly string[], needles: readonly string[]): boolean {
  let from = 0;
  let matched = 0;
  for (const n of needles) {
    const quote = tokenize(n);
    if (quote.length === 0) continue;
    const maxEdits = Math.floor((quote.length * (100 - FUZZY_MIN_MATCH_PERCENT)) / 100);
    const end = fuzzyFind(quote, page, from, maxEdits);
    if (end < 0) return false;
    from = end;
    matched++;
  }
  return matched > 0;
}

/** Parenthetical asides, innermost first, two levels deep. */
const PAREN_RE = / ?\([^()]*\)/g;

function withoutParentheticals(normalized: string): string {
  return normalized.replace(PAREN_RE, "").replace(PAREN_RE, "");
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

/**
 * A checker for quotes taken from one page. `pageText` must be the text the
 * extractor was shown, no more: a quote from beyond a truncation point is
 * unverified. The page is normalized and tokenized once, on first need.
 */
export function makeQuoteChecker(pageText: string): (quote: string) => QuoteMatch {
  let normalized: string | undefined;
  let bare: string | undefined;
  let tokens: string[] | undefined;
  const normPage = (): string => (normalized ??= normalizeForMatch(pageText));
  /** The page with parentheticals left out: a quote may skip them, never add to them. */
  const barePage = (): string => (bare ??= withoutParentheticals(normPage()));
  const pageTokens = (): string[] => (tokens ??= tokenize(normPage()));

  return (quote) => {
    const q = quote.trim();
    if (q === "") return "empty";
    if (pageText.includes(q)) return "exact";
    const needle = quoteNeedle(q);
    if (needle === "") return "unverified";
    if (normPage().includes(needle) || barePage().includes(needle)) return "normalized";
    const stitched = ELLIPSIS_RE.test(q);
    const fragments = stitched ? requiredFragments(q) : [needle];
    if (fragments === undefined) return "unverified";
    if (stitched && (foundInOrder(normPage(), fragments) || foundInOrder(barePage(), fragments))) return "stitched";
    return fuzzyInOrder(pageTokens(), fragments) ? "fuzzy" : "unverified";
  };
}

/** Running counts for the one log line per research run. */
export interface QuoteTally {
  /** Non-empty quotes checked. */
  checked: number;
  exact: number;
  /** Normalized, stitched or fuzzy. */
  lenient: number;
  /** The part of `lenient` that needed the fuzzy tier. */
  fuzzy: number;
  unverified: number;
  /** Claims the extractor returned with no quote. */
  empty: number;
}

export function emptyQuoteTally(): QuoteTally {
  return { checked: 0, exact: 0, lenient: 0, fuzzy: 0, unverified: 0, empty: 0 };
}

/**
 * Checks each claim's quote against the page text the extractor was shown.
 * Every claim is kept. A quote that fails every tier is replaced by an empty
 * quote, and a claim without a quote is marked low confidence, so an invented
 * quote can neither reach the report nor vouch for a writer quote.
 */
export function checkClaimQuotes(claims: readonly NoteClaim[], pageText: string, tally: QuoteTally): NoteClaim[] {
  const check = makeQuoteChecker(pageText);
  return claims.map((claim) => {
    const match = check(claim.quote);
    if (match === "empty") tally.empty++;
    else {
      tally.checked++;
      if (match === "exact") tally.exact++;
      else if (match === "unverified") tally.unverified++;
      else {
        tally.lenient++;
        if (match === "fuzzy") tally.fuzzy++;
      }
    }
    if (match === "empty" || match === "unverified") return { ...claim, quote: "", confidence: "low" };
    return claim;
  });
}
