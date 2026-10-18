import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { canonicalJson, type Cache } from "../../../src/core/cache/index.js";
import type { FetchService } from "../../../src/core/fetch/index.js";
import {
  ReviewSourceError,
  type ReviewHooks,
  type ReviewSearchResult,
  type ReviewSourceErrorCode,
  type ReviewSourceProvider,
} from "../../../src/core/reviews/types.js";
import type { Logger } from "../../../src/log.js";
import type { FetchPageInput, FetchPageOutput } from "../../../src/schemas/fetch_page.js";
import {
  SearchReviewsInputSchema,
  type NormalizedReviewsQuery,
  type Review,
  type ReviewKind,
  type ReviewSource,
} from "../../../src/schemas/reviews.js";
import type { ParsedSearchReviewsInput } from "../../../src/core/reviews/normalize.js";
import { kindsDefaultingTo } from "../../../src/core/reviews/normalize.js";

export const REVIEW_FIXTURES = fileURLToPath(new URL("../../fixtures/reviews/", import.meta.url));

export function readFixture(name: string): string {
  return readFileSync(join(REVIEW_FIXTURES, name), "utf8");
}

export function loadJsonFixture(name: string): unknown {
  return JSON.parse(readFixture(name)) as unknown;
}

export const NOW = Date.parse("2026-10-18T12:00:00.000Z");

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

/** A fetch stand-in that records requests and answers with `respond`. */
export function fakeFetch(respond: (call: RecordedCall) => Response | Promise<Response>): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: RecordedCall = { url: String(input), headers, signal: init?.signal ?? undefined };
    calls.push(call);
    return Promise.resolve().then(() => respond(call));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/** A promise that never settles. */
export const forever = <T>(): Promise<T> => new Promise<T>(() => undefined);

// ---------------------------------------------------------------------------
// Fake cache and fetch service
// ---------------------------------------------------------------------------

export interface MemoryCache extends Cache {
  store: Map<string, { value: unknown; ttlMs: number }>;
  gets: number;
  sets: number;
}

export function memoryCache(): MemoryCache {
  const store = new Map<string, { value: unknown; ttlMs: number }>();
  const cache: MemoryCache = {
    store,
    gets: 0,
    sets: 0,
    get<T>(key: unknown): Promise<T | undefined> {
      cache.gets++;
      return Promise.resolve(store.get(canonicalJson(key))?.value as T | undefined);
    },
    set<T>(key: unknown, value: T, ttlMs: number): Promise<void> {
      cache.sets++;
      store.set(canonicalJson(key), { value, ttlMs });
      return Promise.resolve();
    },
  };
  return cache;
}

export interface FakeFetchService extends FetchService {
  calls: FetchPageInput[];
}

/** A FetchService whose Markdown comes from `respond`; an Error is thrown. */
export function fakeFetchService(respond: (input: FetchPageInput) => string | Error): FakeFetchService {
  const calls: FetchPageInput[] = [];
  return {
    calls,
    fetchPage(input: FetchPageInput): Promise<FetchPageOutput> {
      calls.push(input);
      const out = respond(input);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve({
        url: input.url,
        final_url: input.url,
        title: "rendered",
        markdown: out,
        truncated: false,
        method: "browser",
        fetched_at: "2026-10-18T09:00:00.000Z",
        cached: false,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fake sources and reviews
// ---------------------------------------------------------------------------

export type SearchImpl = (q: NormalizedReviewsQuery, signal: AbortSignal, hooks?: ReviewHooks) => Promise<ReviewSearchResult>;

export type FakeSource = ReviewSourceProvider & { search: ReturnType<typeof vi.fn<SearchImpl>> };

export function fakeSource(
  name: ReviewSource,
  impl: SearchImpl,
  opts: { configured?: boolean; defaultKinds?: readonly ReviewKind[] } = {},
): FakeSource {
  return {
    name,
    defaultKinds: opts.defaultKinds ?? kindsDefaultingTo(name),
    isConfigured: () => opts.configured ?? true,
    search: vi.fn<SearchImpl>(impl),
  };
}

/** A source that always throws the given `ReviewSourceError`. */
export function failingSource(
  name: ReviewSource,
  code: ReviewSourceErrorCode,
  message = `${name} ${code}`,
  opts: { needsLogin?: boolean; retryable?: boolean } = {},
): FakeSource {
  return fakeSource(name, () =>
    Promise.reject(
      new ReviewSourceError(message, {
        source: name,
        code,
        retryable: opts.retryable ?? false,
        ...(opts.needsLogin !== undefined && { needsLogin: opts.needsLogin }),
      }),
    ),
  );
}

export function review(source: ReviewSource, id: string, extra: Partial<Review> = {}): Review {
  return {
    id: `${source}:${id}`,
    source,
    text: `Review ${id} from ${source}`,
    truncated: false,
    rating: 4,
    created_at: "2026-10-10T00:00:00.000Z",
    ...extra,
  };
}

/** A source answering with the given reviews and a minimal subject. */
export function sourceWith(name: ReviewSource, reviews: Review[], opts: { configured?: boolean } = {}): FakeSource {
  return fakeSource(name, () => Promise.resolve({ subject: { source: name, name: `${name} subject` }, reviews }), opts);
}

export const BASE_QUERY: NormalizedReviewsQuery = {
  subject: "Notion",
  kind: "any",
  sources: ["app_store"],
  max_results: 30,
  per_source: 15,
  sort: "relevance",
  app_store_country: "us",
};

/** The tool input after schema defaults, as the service receives it. */
export function parsedInput(over: Record<string, unknown> = {}): ParsedSearchReviewsInput {
  return SearchReviewsInputSchema.parse({ subject: "Notion", ...over });
}
