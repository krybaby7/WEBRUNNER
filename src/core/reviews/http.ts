import { BROWSER_ACCEPT, BROWSER_USER_AGENT } from "../fetch/fast/shared.js";
import { ReviewSourceError, type ReviewSource } from "./types.js";

/**
 * The one HTTP helper the API and fetch-based review sources share: an
 * injected `fetchImpl`, the caller's signal as the deadline (the service sets
 * the per-source timeout), status mapping onto `ReviewSourceError`, and
 * redaction of anything credential-shaped in error text.
 */

export type FetchImpl = typeof fetch;

const ERROR_BODY_PREVIEW_CHARS = 200;
/** Largest body a review source reads; a feed page or a review page is well under this. */
export const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

/** Headers that make a raw HTML fetch look like a desktop browser. */
export const BROWSER_LIKE_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: BROWSER_ACCEPT,
  "Accept-Language": "en-US,en;q=0.9",
};

/** Replace anything that looks like a credential. The sources here are keyless, so this is a safety net. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|key|secret|authorization|password)["']?\s*[=:]\s*["']?)(?!Bearer\b|\[redacted\])[^\s"'&,;}]+/gi, "$1[redacted]");
}

export function abortError(source: ReviewSource, signal: AbortSignal): ReviewSourceError {
  const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  return new ReviewSourceError(timedOut ? `${source} request timed out` : `${source} request was cancelled`, {
    source,
    code: "timeout",
    retryable: true,
    cause: signal.reason,
  });
}

/** Race a promise against the signal so a fetch implementation that ignores it still fails promptly. */
function abortable<T>(source: ReviewSource, p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(source, signal));
      return;
    }
    const onAbort = (): void => reject(abortError(source, signal));
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

export interface ReviewHttpRequest {
  source: ReviewSource;
  url: string;
  fetchImpl: FetchImpl;
  signal: AbortSignal;
  headers?: Record<string, string>;
}

export interface TextResponse {
  status: number;
  headers: Headers;
  text: string;
  /** The URL after redirects, when the fetch implementation reports one. */
  finalUrl: string;
}

/**
 * One GET returning the body as text, whatever the status: the caller decides
 * what a 403 means (a WAF challenge is not the same as an API error). Network
 * errors and aborts are `ReviewSourceError`s (`provider` retryable, `timeout`).
 */
export async function requestText(req: ReviewHttpRequest): Promise<TextResponse> {
  const { source, url, fetchImpl, signal } = req;
  if (signal.aborted) throw abortError(source, signal);
  try {
    const res = await abortable(
      source,
      Promise.resolve().then(() => fetchImpl(url, { method: "GET", headers: req.headers ?? {}, redirect: "follow", signal })),
      signal,
    );
    const text = await abortable(source, res.text(), signal);
    return {
      status: res.status,
      headers: res.headers,
      text: text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text,
      finalUrl: typeof res.url === "string" && res.url !== "" ? res.url : url,
    };
  } catch (err) {
    if (err instanceof ReviewSourceError) throw err;
    if (signal.aborted) throw abortError(source, signal);
    throw new ReviewSourceError(`${source} network error: ${redactSecrets(err instanceof Error ? err.message : String(err))}`, {
      source,
      code: "provider",
      retryable: true,
      cause: err,
    });
  }
}

export interface StatusErrorOptions {
  /** Message for a 404, which means the subject does not exist on this site. */
  notFoundMessage?: string;
}

/**
 * The error for a non-2xx API status: 404 is `not_found`, 401 and 403 are
 * `blocked`, 429 and 5xx are retryable `provider` errors, anything else a
 * `provider` error that is not worth retrying.
 */
export function statusError(source: ReviewSource, status: number, bodyText: string, opts: StatusErrorOptions = {}): ReviewSourceError {
  const preview = redactSecrets(bodyText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_PREVIEW_CHARS));
  const suffix = preview !== "" ? `: ${preview}` : "";
  if (status === 404) {
    return new ReviewSourceError(opts.notFoundMessage ?? `${source} returned HTTP 404 (nothing found)`, {
      source,
      code: "not_found",
      retryable: false,
      status,
    });
  }
  if (status === 401 || status === 403) {
    return new ReviewSourceError(`${source} refused the request (HTTP ${status})${suffix}`, { source, code: "blocked", retryable: false, status });
  }
  const retryable = status === 429 || status >= 500;
  return new ReviewSourceError(`${source} returned HTTP ${status}${suffix}`, { source, code: "provider", retryable, status });
}

/** One GET whose 2xx body must be JSON. Non-2xx statuses go through `statusError`. */
export async function requestJson(req: ReviewHttpRequest, opts: StatusErrorOptions = {}): Promise<unknown> {
  const res = await requestText({ ...req, headers: { Accept: "application/json", ...req.headers } });
  if (res.status < 200 || res.status > 299) throw statusError(req.source, res.status, res.text, opts);
  try {
    return JSON.parse(res.text) as unknown;
  } catch (err) {
    throw new ReviewSourceError(`${req.source} returned a body that is not valid JSON`, {
      source: req.source,
      code: "provider",
      retryable: false,
      status: res.status,
      cause: err,
    });
  }
}

/** Summarise zod issues for an error message. */
export function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
