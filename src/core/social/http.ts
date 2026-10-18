import { z } from "zod";
import { parseRetryAfter } from "../retry.js";
import { normalizePublishedAt } from "../search/normalize.js";
import { RECENCY_MS } from "../search/providers/shared.js";
import type { Recency } from "../search/types.js";
import type { SocialKind } from "../../schemas/social.js";
import { SocialProviderError, type SocialPlatform, type SocialProviderErrorOptions } from "./types.js";

/**
 * HTTP and mapping helpers shared by the API platforms of `social_search`
 * (PLAN.md 14.5). Not part of the public social API.
 */

const ERROR_BODY_PREVIEW_CHARS = 200;

export function hasKey(key: string | undefined): boolean {
  return typeof key === "string" && key.trim() !== "";
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Replace anything that looks like a credential: exact secret values, bearer tokens and `key=value` pairs. */
export function makeRedactor(secrets: ReadonlyArray<string | undefined>): (s: string) => string {
  const exact = secrets.filter((s): s is string => typeof s === "string" && s.length >= 6);
  return (s) => {
    let out = s;
    for (const secret of exact) out = out.split(secret).join("[redacted]");
    return out
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|client[_-]?secret|token|key|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi,
        "$1[redacted]",
      );
  };
}

/**
 * A `SocialProviderError` from an HTTP response. `retryAfterMs` is set on a 429
 * that carried `Retry-After`; `bodyPreview` is the start of the response body
 * (already redacted) so a platform can recognise an API-specific reason such
 * as YouTube's `quotaExceeded`.
 */
export class SocialHttpError extends SocialProviderError {
  readonly retryAfterMs?: number;
  readonly bodyPreview: string;

  constructor(message: string, options: SocialProviderErrorOptions & { retryAfterMs?: number; bodyPreview?: string }) {
    super(message, options);
    this.name = "SocialHttpError";
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.bodyPreview = options.bodyPreview ?? "";
  }
}

export interface SocialJsonRequest {
  platform: SocialPlatform;
  url: string;
  init?: RequestInit;
  fetchImpl: typeof fetch;
  /** Carries the per-platform timeout and the tool's wall clock. */
  signal: AbortSignal;
  /** Secret values to scrub from messages, on top of the pattern-based scrubbing. */
  secrets?: ReadonlyArray<string | undefined>;
  /** Pretty name of the service for messages, for example "Reddit API". Defaults to the platform name. */
  label?: string;
}

function abortError(platform: SocialPlatform, label: string, signal: AbortSignal): SocialProviderError {
  return new SocialProviderError(`${label} request timed out or was cancelled`, {
    platform,
    code: "timeout",
    retryable: true,
    cause: signal.reason,
  });
}

/** Race a promise against the signal so that a fetch implementation that ignores it still rejects promptly. */
function abortable<T>(platform: SocialPlatform, label: string, p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(platform, label, signal));
      return;
    }
    const onAbort = (): void => reject(abortError(platform, label, signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * One HTTP request returning the parsed JSON body. Every failure is a
 * `SocialProviderError`: an abort is `timeout`; a network error is a retryable
 * `provider`; a non-2xx status is a `SocialHttpError` with `status`, retryable
 * only for 429 and 5xx, carrying `retryAfterMs` from a 429's `Retry-After`;
 * an unparseable body is a non-retryable `provider`. Messages never carry a
 * secret. No retries here: platforms decide what to do with a failure.
 */
export async function fetchJson(req: SocialJsonRequest): Promise<unknown> {
  const { platform, url, fetchImpl, signal } = req;
  const label = req.label ?? platform;
  const redact = makeRedactor(req.secrets ?? []);
  if (signal.aborted) throw abortError(platform, label, signal);

  let text: string;
  let status: number;
  let retryAfter: string | null;
  try {
    const res = await abortable(
      platform,
      label,
      Promise.resolve().then(() => fetchImpl(url, { ...req.init, signal })),
      signal,
    );
    status = res.status;
    retryAfter = res.headers?.get("retry-after") ?? null;
    text = await abortable(platform, label, res.text(), signal);
  } catch (err) {
    if (err instanceof SocialProviderError) throw err;
    if (signal.aborted) throw abortError(platform, label, signal);
    throw new SocialProviderError(`${label} network error: ${redact(err instanceof Error ? err.message : String(err))}`, {
      platform,
      code: "provider",
      retryable: true,
      cause: err,
    });
  }

  if (status < 200 || status > 299) {
    const preview = redact(text.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_PREVIEW_CHARS));
    const retryAfterMs = status === 429 ? parseRetryAfter(retryAfter) : undefined;
    throw new SocialHttpError(`${label} returned HTTP ${status}${preview !== "" ? `: ${preview}` : ""}`, {
      platform,
      code: "provider",
      status,
      retryable: isRetryableStatus(status),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      bodyPreview: preview,
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new SocialHttpError(`${label} returned a body that is not valid JSON`, {
      platform,
      code: "provider",
      status,
      retryable: false,
      cause: err,
    });
  }
}

/** Validate a response body against a zod schema; a mismatch is a non-retryable `provider` error. */
export function parseBody<S extends z.ZodType>(platform: SocialPlatform, schema: S, body: unknown, label?: string): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new SocialProviderError(`${label ?? platform} returned an unexpected response shape (${detail})`, {
    platform,
    code: "provider",
    retryable: false,
    cause: parsed.error,
  });
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML (Hacker News bodies, Reddit's `body_html`) to plain text: block tags become line breaks, entities are decoded. */
export function htmlToText(html: string | null | undefined): string {
  if (html === null || html === undefined) return "";
  return html
    .replace(/<\s*(?:p|br|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** ISO 8601 UTC from an epoch (seconds) or a date string; undefined when unknown. */
export function toIso(value: unknown): string | undefined {
  return normalizePublishedAt(value);
}

/** A finite number, or undefined. Strings of digits (YouTube statistics) are accepted. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

/** A non-negative integer count, or undefined. */
export function toCount(value: unknown): number | undefined {
  const n = toNumber(value);
  return n === undefined || n < 0 ? undefined : Math.floor(n);
}

/** Epoch seconds for the start of a recency window ending at `nowMs`. */
export function sinceEpochSeconds(recency: Recency | undefined, nowMs: number): number | undefined {
  if (recency === undefined) return undefined;
  return Math.floor((nowMs - RECENCY_MS[recency]) / 1000);
}

/** ISO 8601 UTC for the start of a recency window ending at `nowMs`. */
export function sinceIso(recency: Recency | undefined, nowMs: number): string | undefined {
  const s = sinceEpochSeconds(recency, nowMs);
  return s === undefined ? undefined : new Date(s * 1000).toISOString();
}

/**
 * Split a platform's `per_platform` budget between posts and comments. `both`
 * gives posts the larger half so that a platform never returns more than
 * `per_platform` items in total.
 */
export function allocate(kind: SocialKind, perPlatform: number): { posts: number; comments: number } {
  const n = Math.max(1, Math.floor(perPlatform));
  if (kind === "posts") return { posts: n, comments: 0 };
  if (kind === "comments") return { posts: 0, comments: n };
  const posts = Math.ceil(n / 2);
  return { posts, comments: n - posts };
}

/** Spread `total` comments over `sources` threads: how many to ask each one for (at least 1). */
export function perThread(total: number, sources: number): number {
  if (sources <= 0) return 0;
  return Math.max(1, Math.ceil(total / sources));
}

/**
 * Take items from several lists in turn (first of each, then second of each,
 * ...) up to `limit`, so that every source thread is represented before any
 * one of them fills the budget.
 */
export function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) {
        out.push(item);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/** A `z` schema for a loosely-typed count field: number or numeric string, nullish allowed. */
export const looseCount = z.union([z.number(), z.string()]).nullish();
