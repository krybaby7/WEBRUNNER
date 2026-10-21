/**
 * Dates as review sites print them (PLAN.md 14.6): "2 months ago" becomes an
 * approximate ISO 8601 UTC timestamp and the caller adds `APPROXIMATE_DATE_CAVEAT`
 * once; "March 3, 2026" and ISO strings are exact.
 *
 * Absolute dates are parsed in UTC by hand, so the result never depends on the
 * server's time zone.
 */

/** Caveat for a call whose `created_at` values were approximated from relative text. */
export const APPROXIMATE_DATE_CAVEAT =
  'Some created_at values are approximate: the site printed a relative date such as "2 months ago".';

export interface ParsedReviewDate {
  /** ISO 8601 UTC. */
  iso: string;
  /** True when computed from a relative phrase; the real date may differ by up to one unit. */
  approximate: boolean;
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Leading words sites put before a date: "Edited 2 days ago", "Reviewed in the United States on March 3, 2026". */
const PREFIX_RE = /^(?:edited|updated|posted|written|reviewed(?:\s+in\s+[a-z .'-]+?\s+on)?)\s+(?:on\s+)?/i;
const RELATIVE_RE = /^(?:about |over |almost |~)?(an?|one|\d+)\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago$/i;
const MONTH_DAY_YEAR_RE = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i;
const DAY_MONTH_YEAR_RE = /^(\d{1,2})\.?\s+([a-z]+)\.?,?\s+(\d{4})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function utcDate(year: number, month: number, day: number): string | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month, day);
  const d = new Date(ms);
  // Reject "February 31".
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return undefined;
  return d.toISOString();
}

/**
 * Parse one date string. Relative phrases ("a day ago", "3 weeks ago", "Edited
 * 2 days ago", "yesterday") are approximated from `nowMs`; "March 3, 2026",
 * "3 March 2026" and ISO 8601 strings are exact. Undefined when nothing matches.
 */
export function parseReviewDate(raw: string, nowMs: number): ParsedReviewDate | undefined {
  const text = raw.replace(/\s+/g, " ").trim().replace(PREFIX_RE, "").trim();
  if (text === "") return undefined;
  const lower = text.toLowerCase();

  if (/^(?:just now|today|moments? ago|a moment ago)$/.test(lower)) {
    return { iso: new Date(nowMs).toISOString(), approximate: true };
  }
  if (lower === "yesterday") return { iso: new Date(nowMs - (UNIT_MS["day"] as number)).toISOString(), approximate: true };

  const rel = RELATIVE_RE.exec(lower);
  if (rel !== null) {
    const count = /^\d+$/.test(rel[1] as string) ? Number(rel[1]) : 1;
    const unit = UNIT_MS[rel[2] as string] as number;
    return { iso: new Date(nowMs - count * unit).toISOString(), approximate: true };
  }

  const mdy = MONTH_DAY_YEAR_RE.exec(text);
  if (mdy !== null) {
    const month = MONTHS[(mdy[1] as string).toLowerCase()];
    if (month === undefined) return undefined;
    const iso = utcDate(Number(mdy[3]), month, Number(mdy[2]));
    return iso === undefined ? undefined : { iso, approximate: false };
  }
  const dmy = DAY_MONTH_YEAR_RE.exec(text);
  if (dmy !== null) {
    const month = MONTHS[(dmy[2] as string).toLowerCase()];
    if (month === undefined) return undefined;
    const iso = utcDate(Number(dmy[3]), month, Number(dmy[1]));
    return iso === undefined ? undefined : { iso, approximate: false };
  }

  if (ISO_DATE_RE.test(text)) {
    // A bare date or a naive date-time is read as UTC.
    const normalised = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`;
    const ms = Date.parse(normalised.replace(" ", "T"));
    if (Number.isFinite(ms)) return { iso: new Date(ms).toISOString(), approximate: false };
  }
  return undefined;
}

/** True when the text looks like a relative date ("2 months ago", "Edited a day ago", "yesterday"). */
export function looksRelative(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim().replace(PREFIX_RE, "").toLowerCase();
  return RELATIVE_RE.test(t) || /^(?:just now|today|yesterday|moments? ago|a moment ago)$/.test(t);
}
