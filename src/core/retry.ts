import type { Logger } from "../log.js";

/**
 * Retry with full jitter, shared by search providers, fast fetchers and Duffel
 * (PLAN.md section 6, WP14). Deliberately small and capped: at most
 * `MAX_RETRIES` retries, never after the caller's signal aborts, and never a
 * wait longer than `maxMs`.
 *
 * Not used by the browser fetcher, the Google Flights recipe or the LLM client:
 * Google rate-limits, and the Anthropic SDK already retries twice itself.
 */

/** Hard ceiling on retries, whatever the caller asks for (so at most 3 attempts). */
export const MAX_RETRIES = 2;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_BASE_MS = 300;
export const DEFAULT_MAX_MS = 2000;

export interface RetryOptions {
  /** Retries after the first attempt. Clamped to 0..MAX_RETRIES. Default 2. */
  retries?: number;
  /** Whether a thrown error is worth another attempt. */
  isRetryable: (err: unknown) => boolean;
  /** Base of the exponential backoff window. Default 300. */
  baseMs?: number;
  /** Ceiling of any single wait, including a `Retry-After` wait. Default 2000. */
  maxMs?: number;
  /** When it aborts, no further attempt starts and a pending wait ends at once. */
  signal?: AbortSignal;
  log?: Logger;
  /** Names the operation in log lines, for example "search:brave". */
  label?: string;
  /** Source of randomness in [0, 1). For tests. */
  random?: () => number;
  /** Wait implementation. For tests. Must resolve (never reject), and early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * A `Retry-After` value carried by an error: `status` 429 and `retryAfterMs`.
 * Read by duck typing so that any error class can carry it.
 */
export function retryAfterMsOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, retryAfterMs } = err as { status?: unknown; retryAfterMs?: unknown };
  if (status !== 429) return undefined;
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return undefined;
  return retryAfterMs;
}

/**
 * Parse an HTTP `Retry-After` header: delta-seconds or an HTTP date. Returns
 * milliseconds from `nowMs`, or undefined when the value is missing or invalid.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  // Anything numeric that is not plain delta-seconds ("-3", "1.2.3") is invalid, not a date Date.parse might accept.
  if (/^[+-]?[\d.]+$/.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Full jitter: a uniform draw from [0, min(maxMs, baseMs * 2^retryIndex)). */
export function jitterDelayMs(retryIndex: number, baseMs: number, maxMs: number, random: () => number): number {
  const window = Math.min(maxMs, baseMs * 2 ** retryIndex);
  return Math.floor(random() * window);
}

/**
 * Worst-case wall time of a retried call whose every attempt runs for
 * `attemptMs`: (retries + 1) attempts plus `retries` waits of at most `maxMs`.
 */
export function worstCaseMs(attemptMs: number, retries: number = MAX_RETRIES, maxMs: number = DEFAULT_MAX_MS): number {
  const r = Math.min(MAX_RETRIES, Math.max(0, Math.floor(retries)));
  return (r + 1) * attemptMs + r * maxMs;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn`, retrying when it throws a retryable error. The last error is
 * rethrown unchanged once retries run out, the error is not retryable, the
 * signal has aborted, or a `Retry-After` asks for a wait longer than `maxMs`.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const retries = Math.min(MAX_RETRIES, Math.max(0, Math.floor(opts.retries ?? DEFAULT_RETRIES)));
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  // A function, so the check is not narrowed away across the awaits below.
  const isAborted = (): boolean => opts.signal?.aborted === true;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries) throw err;
      if (isAborted()) throw err;
      if (!opts.isRetryable(err)) throw err;

      let delay = jitterDelayMs(attempt, baseMs, maxMs, random);
      const retryAfter = retryAfterMsOf(err);
      if (retryAfter !== undefined) {
        if (retryAfter > maxMs) {
          // Waiting that long would blow the call's budget; let the caller see the 429.
          opts.log?.debug("retry skipped: Retry-After is longer than the wait ceiling", {
            label: opts.label,
            retry_after_ms: retryAfter,
            max_ms: maxMs,
          });
          throw err;
        }
        delay = Math.max(delay, retryAfter);
      }

      opts.log?.debug("retrying after a transient failure", {
        label: opts.label,
        attempt: attempt + 1,
        retries,
        delay_ms: delay,
        error_name: err instanceof Error ? err.name : typeof err,
        status: (err as { status?: unknown } | null)?.status,
      });
      await sleep(delay, opts.signal);
      if (isAborted()) throw err;
    }
  }
}
