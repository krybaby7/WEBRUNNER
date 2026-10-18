import { z } from "zod";
import { normalizePublishedAt } from "../normalize.js";
import {
  isRetryableStatus,
  ProviderError,
  type RawResult,
  type Recency,
  type SearchProviderName,
} from "../types.js";

/** Helpers shared by the four providers. Not part of the public search API. */

const ERROR_BODY_PREVIEW_CHARS = 200;

export function hasKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim() !== "";
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function abortError(provider: SearchProviderName, signal: AbortSignal): ProviderError {
  return new ProviderError({
    provider,
    message: `${provider} request aborted`,
    retryable: true,
    aborted: true,
    cause: signal.reason,
  });
}

/**
 * Race a promise against the signal so that a fetch implementation that
 * ignores the signal still rejects promptly.
 */
function abortable<T>(provider: SearchProviderName, p: Promise<T>, signal: AbortSignal): Promise<T> {
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

export interface JsonRequest {
  provider: SearchProviderName;
  url: string;
  init: RequestInit;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}

/**
 * Perform one HTTP request and return the parsed JSON body. Every failure is a
 * ProviderError: abort and network errors and 429/5xx are retryable, other
 * non-2xx statuses and unparseable bodies are not. No automatic retries.
 */
export async function requestJson(req: JsonRequest): Promise<unknown> {
  const { provider, url, init, fetchImpl, signal } = req;
  if (signal.aborted) throw abortError(provider, signal);

  let text: string;
  let status: number;
  try {
    const res = await abortable(provider, Promise.resolve().then(() => fetchImpl(url, { ...init, signal })), signal);
    status = res.status;
    text = await abortable(provider, res.text(), signal);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal.aborted) throw abortError(provider, signal);
    throw new ProviderError({
      provider,
      message: `${provider} network error: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
      cause: err,
    });
  }

  if (status < 200 || status > 299) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_PREVIEW_CHARS);
    throw new ProviderError({
      provider,
      status,
      message: `${provider} returned HTTP ${status}${preview !== "" ? `: ${preview}` : ""}`,
      retryable: isRetryableStatus(status),
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ProviderError({
      provider,
      status,
      message: `${provider} returned a body that is not valid JSON`,
      retryable: false,
      cause: err,
    });
  }
}

/** Validate a response body against a zod schema; a mismatch is a ProviderError. */
export function parseBody<S extends z.ZodType>(provider: SearchProviderName, schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new ProviderError({
    provider,
    message: `${provider} returned an unexpected response shape (${detail})`,
    retryable: false,
    cause: parsed.error,
  });
}

/** An absolute URL string. A result without one is unusable, so it fails the whole response. */
export const absoluteUrl = z.string().refine((s) => URL.canParse(s), { message: "must be an absolute URL" });

/** Approximate window length for each recency bucket, in milliseconds. */
export const RECENCY_MS: Record<Recency, number> = {
  day: 24 * 3600_000,
  week: 7 * 24 * 3600_000,
  month: 31 * 24 * 3600_000,
  year: 365 * 24 * 3600_000,
};

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Lowercased hostname without a leading "www.", or undefined for an unparseable URL. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Reduce a user-supplied domain ("https://www.Example.com/path", "*.example.com") to a bare host. */
export function bareDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

export function matchesDomain(url: string, domain: string): boolean {
  const host = hostOf(url);
  const want = bareDomain(domain);
  if (host === undefined || want === "") return false;
  return host === want || host.endsWith(`.${want}`);
}

export interface DomainFilter {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export function passesDomainFilter(url: string, f: DomainFilter): boolean {
  if (f.include !== undefined && f.include.length > 0 && !f.include.some((d) => matchesDomain(url, d))) return false;
  if (f.exclude !== undefined && f.exclude.some((d) => matchesDomain(url, d))) return false;
  return true;
}

/** A mapped result before ranking. `date` is whatever the provider sent. */
export interface Mapped {
  url: string;
  title: string | null | undefined;
  snippet: string | null | undefined;
  date?: unknown;
}

/**
 * Turn mapped provider items into RawResult[]: optional client-side domain
 * filter, truncate to maxResults, then assign contiguous 1-based ranks.
 * Dates go through normalizePublishedAt, so an unparseable date is omitted.
 */
export function finalize(items: Mapped[], maxResults: number, clientFilter?: DomainFilter): RawResult[] {
  const kept = clientFilter === undefined ? items : items.filter((i) => passesDomainFilter(i.url, clientFilter));
  return kept.slice(0, Math.max(0, Math.floor(maxResults))).map((item, idx) => {
    const publishedAt = normalizePublishedAt(item.date);
    return {
      url: item.url,
      title: item.title ?? "",
      snippet: item.snippet ?? "",
      ...(publishedAt !== undefined && { publishedAt }),
      rank: idx + 1,
    };
  });
}

export function notConfigured(provider: SearchProviderName): ProviderError {
  return new ProviderError({
    provider,
    message: `${provider} is not configured (no API key)`,
    retryable: false,
  });
}
