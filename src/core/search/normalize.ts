/**
 * `published_at` normalization, PLAN.md section 4.1 (DECIDED).
 *
 * Anything Date.parse accepts becomes ISO 8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ).
 * A date-only value becomes midnight UTC. Anything unparseable is omitted,
 * never passed through raw.
 *
 * Refinements that keep the output deterministic and keep garbage out:
 * - A date-time without a zone designator is read as UTC. Date.parse would
 *   otherwise read it in the machine's local zone.
 * - Numbers are epoch seconds (values of 1e12 and above are taken as
 *   milliseconds). Zero, negatives and non-finite numbers are omitted.
 * - A string with no 4-digit year is omitted. Date.parse's legacy fallback
 *   accepts junk such as "foo 2" (2001-02-01), and every real provider date
 *   format carries a 4-digit year.
 */

const ISO_NO_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const HAS_ZONE = /(?:\bZ|GMT|UTC|\bUT|\b[ECMP][SD]T|[+-]\d{2}:?\d{2})\s*(?:\([^)]*\))?$/i;
const EPOCH_DIGITS = /^\d{9,13}$/;
const FOUR_DIGIT_YEAR = /\d{4}/;

function fromMs(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function fromEpoch(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return fromMs(n >= 1e12 ? n : n * 1000);
}

export function normalizePublishedAt(input: unknown): string | undefined {
  if (typeof input === "number") return fromEpoch(input);
  if (input instanceof Date) return fromMs(input.getTime());
  if (typeof input !== "string") return undefined;

  const s = input.trim();
  if (s === "") return undefined;
  if (EPOCH_DIGITS.test(s)) return fromEpoch(Number(s));
  if (!FOUR_DIGIT_YEAR.test(s)) return undefined;

  if (ISO_NO_ZONE.test(s)) return fromMs(Date.parse(s.replace(" ", "T") + "Z"));
  if (!HAS_ZONE.test(s)) {
    // Zone-less formats (date-only ISO, "Mar 11, 2025") are read as UTC.
    const asUtc = Date.parse(`${s} UTC`);
    if (!Number.isNaN(asUtc)) return fromMs(asUtc);
  }
  return fromMs(Date.parse(s));
}
