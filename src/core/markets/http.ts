import { z } from "zod";
import { parseRetryAfter } from "../retry.js";
import { MarketProviderError, type MarketSource } from "./types.js";

/**
 * JSON-over-HTTP helper shared by the API market providers (Yahoo, Finnhub,
 * CoinGecko), PLAN.md 14.2. Mirrors `core/search/providers/shared.ts` but
 * throws `MarketProviderError` so the market service can route on `code`.
 *
 * Failure mapping: the caller's signal firing is `timeout` (retryable); a
 * network error, a 429 or a 5xx is `provider` and retryable; a 429 also
 * carries `retryAfterMs` (see `RateLimitedMarketError`) so the service can
 * skip to the next source instead of waiting; 401 and 403 are `config`
 * (a bad or missing key); every other status and an unparseable body are
 * `provider` and not retryable. Statuses in `acceptStatuses` are returned
 * with their body instead of thrown (Yahoo answers an unknown symbol with a
 * JSON error body and HTTP 404).
 */

const ERROR_BODY_PREVIEW_CHARS = 200;

/** A `provider` error for HTTP 429 that carries the server's `Retry-After` wish in milliseconds (0 when it sent none). */
export class RateLimitedMarketError extends MarketProviderError {
  readonly retryAfterMs: number;

  constructor(message: string, provider: MarketSource, retryAfterMs: number, cause?: unknown) {
    super(message, { provider, code: "provider", retryable: true, status: 429, ...(cause !== undefined && { cause }) });
    this.name = "RateLimitedMarketError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface MarketJsonRequest {
  provider: MarketSource;
  url: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  headers?: Record<string, string>;
  /** Non-2xx statuses whose JSON body the caller wants to inspect instead of an error. */
  acceptStatuses?: readonly number[];
}

export interface MarketJsonResponse {
  status: number;
  body: unknown;
}

export function hasKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim() !== "";
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Hide credentials in text that may reach a log line or an error envelope:
 * `token=`/`apikey=`/`key=` query values and the exact `secrets` given.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|key|secret|authorization)["']?\s*[=:]\s*["']?)(?!Bearer\b)[^\s"'&,;}]+/gi, "$1[redacted]");
}

function abortError(provider: MarketSource, signal: AbortSignal): MarketProviderError {
  return new MarketProviderError(`${provider} request aborted (timed out or cancelled)`, {
    provider,
    code: "timeout",
    retryable: true,
    cause: signal.reason,
  });
}

/** Race a promise against the signal, so a fetch that ignores the signal still rejects promptly. */
function abortable<T>(provider: MarketSource, p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(provider, signal));
      return;
    }
    const onAbort = (): void => reject(abortError(provider, signal));
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

/** One GET request whose answer is parsed as JSON. No retries: the market service moves on to the next source instead. */
export async function requestMarketJson(req: MarketJsonRequest): Promise<MarketJsonResponse> {
  const { provider, url, fetchImpl, signal } = req;
  if (signal.aborted) throw abortError(provider, signal);

  let text: string;
  let status: number;
  let retryAfter: string | null;
  try {
    const res = await abortable(
      provider,
      Promise.resolve().then(() =>
        fetchImpl(url, { method: "GET", headers: { Accept: "application/json", ...req.headers }, signal }),
      ),
      signal,
    );
    status = res.status;
    retryAfter = res.headers?.get("retry-after") ?? null;
    text = await abortable(provider, res.text(), signal);
  } catch (err) {
    if (err instanceof MarketProviderError) throw err;
    if (signal.aborted) throw abortError(provider, signal);
    throw new MarketProviderError(
      `${provider} network error: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      { provider, code: "provider", retryable: true, cause: err },
    );
  }

  const ok = (status >= 200 && status <= 299) || (req.acceptStatuses?.includes(status) ?? false);
  if (!ok) {
    const preview = redactSecrets(text.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_PREVIEW_CHARS));
    const message = `${provider} returned HTTP ${status}${preview !== "" ? `: ${preview}` : ""}`;
    if (status === 429) throw new RateLimitedMarketError(message, provider, parseRetryAfter(retryAfter) ?? 0);
    if (status === 401 || status === 403) {
      throw new MarketProviderError(`${message} (check the API key)`, { provider, code: "config", retryable: false, status });
    }
    throw new MarketProviderError(message, { provider, code: "provider", retryable: status >= 500 && status <= 599, status });
  }

  try {
    return { status, body: JSON.parse(text) as unknown };
  } catch (err) {
    throw new MarketProviderError(`${provider} returned a body that is not valid JSON`, {
      provider,
      code: "provider",
      retryable: false,
      status,
      cause: err,
    });
  }
}

/** Validate a response body against a zod schema; a mismatch is a non-retryable `provider` error. */
export function parseMarketBody<S extends z.ZodType>(provider: MarketSource, schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new MarketProviderError(`${provider} returned an unexpected response shape (${detail})`, {
    provider,
    code: "provider",
    retryable: false,
    cause: parsed.error,
  });
}

/** Epoch seconds to ISO 8601 UTC. */
export function isoFromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Round to at most `digits` decimals, avoiding float noise such as 1.4600000000000364. */
export function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
