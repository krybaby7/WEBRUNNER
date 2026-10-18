import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache } from "../../../src/core/cache/index.js";
import { createSearchService, SearchError } from "../../../src/core/search/index.js";
import { RateLimitedProviderError, requestJson } from "../../../src/core/search/providers/shared.js";
import {
  ProviderError,
  type RawResult,
  type SearchProvider,
  type SearchProviderName,
  type SearchQuery,
} from "../../../src/core/search/types.js";
import type { Logger } from "../../../src/log.js";

let dir: string;
let log: Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-search-resilience-"));
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RESULTS: RawResult[] = [{ url: "https://a.com/1", title: "A", snippet: "a", rank: 1 }];

type SearchFn = (q: SearchQuery, signal: AbortSignal) => Promise<RawResult[]>;

function provider(name: SearchProviderName, search: SearchFn): SearchProvider & { search: ReturnType<typeof vi.fn<SearchFn>> } {
  return { name, isConfigured: () => true, search: vi.fn<SearchFn>(search) };
}

const rejectWith = (init: Partial<ConstructorParameters<typeof ProviderError>[0]> & { retryAfterMs?: number }) => () => {
  const base = { provider: "brave" as const, message: "failed", retryable: true, ...init };
  return Promise.reject(
    init.retryAfterMs !== undefined ? new RateLimitedProviderError(base, init.retryAfterMs) : new ProviderError(base),
  );
};

/** Retry timing that never really waits, recording the requested waits. */
function instantRetry(random = () => 0): { retry: { sleep: (ms: number) => Promise<void>; random: () => number }; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    retry: {
      random,
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  };
}

describe("requestJson attaches Retry-After on 429", () => {
  const call = (status: number, headers: Record<string, string>): Promise<unknown> =>
    requestJson({
      provider: "brave",
      url: "https://api.example.test/search",
      init: {},
      fetchImpl: (() => Promise.resolve(new Response("slow down", { status, headers }))) as typeof fetch,
      signal: new AbortController().signal,
    });

  const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  };

  it("reads delta-seconds into retryAfterMs", async () => {
    const err = await failure(call(429, { "retry-after": "2" }));
    expect(err).toBeInstanceOf(RateLimitedProviderError);
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
  });

  it("reads an HTTP date", async () => {
    const at = new Date(Date.now() + 3000).toUTCString();
    const err = await failure(call(429, { "retry-after": at }));
    const ms = (err as RateLimitedProviderError).retryAfterMs;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it("leaves a 429 without the header as a plain ProviderError", async () => {
    const err = await failure(call(429, {}));
    expect(err).not.toBeInstanceOf(RateLimitedProviderError);
    expect("retryAfterMs" in err).toBe(false);
    expect(err.retryable).toBe(true);
  });

  it("ignores an unparseable header", async () => {
    const err = await failure(call(429, { "retry-after": "whenever" }));
    expect("retryAfterMs" in err).toBe(false);
  });

  it("ignores the header on other statuses", async () => {
    const err = await failure(call(503, { "retry-after": "2" }));
    expect("retryAfterMs" in err).toBe(false);
    expect(err).toMatchObject({ status: 503, retryable: true });
  });
});

describe("SearchService retries", () => {
  it("retries a retryable provider failure and uses the recovered result", async () => {
    const { retry, waits } = instantRetry();
    const brave = provider("brave", (() => {
      let calls = 0;
      return () => (++calls < 3 ? rejectWith({ status: 503 })() : Promise.resolve(RESULTS));
    })());
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry });
    const out = await svc.search({ query: "q" });
    expect(brave.search).toHaveBeenCalledTimes(3);
    expect(out.providers_used).toEqual(["brave"]);
    expect(out.providers_failed).toEqual([]);
    expect(waits).toHaveLength(2);
  });

  it("gives up after two retries and reports the provider as failed", async () => {
    const { retry } = instantRetry();
    const brave = provider("brave", rejectWith({ status: 500, message: "brave returned HTTP 500" }));
    const exa = provider("exa", () => Promise.resolve(RESULTS));
    const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log, retry });
    const out = await svc.search({ query: "q" });
    expect(brave.search).toHaveBeenCalledTimes(3);
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(out.providers_failed).toEqual([{ provider: "brave", error: "brave returned HTTP 500" }]);
  });

  it("never retries more than twice even when configured for more", async () => {
    const { retry } = instantRetry();
    const brave = provider("brave", rejectWith({}));
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry: { ...retry, retries: 9 } });
    await expect(svc.search({ query: "q" })).rejects.toBeInstanceOf(SearchError);
    expect(brave.search).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable failure", async () => {
    const { retry, waits } = instantRetry();
    const brave = provider("brave", rejectWith({ status: 401, retryable: false }));
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry });
    await expect(svc.search({ query: "q" })).rejects.toBeInstanceOf(SearchError);
    expect(brave.search).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a failure that is an abort", async () => {
    const { retry } = instantRetry();
    const brave = provider("brave", rejectWith({ aborted: true, message: "brave request aborted" }));
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry });
    await expect(svc.search({ query: "q" })).rejects.toMatchObject({ code: "timeout" });
    expect(brave.search).toHaveBeenCalledTimes(1);
  });

  it("does not retry a provider that outlives the per-provider timeout", async () => {
    const { retry } = instantRetry();
    const brave = provider("brave", () => new Promise<RawResult[]>(() => undefined));
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry, timeoutMs: 30 });
    await expect(svc.search({ query: "q" })).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(brave.search).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After on a 429 when it fits the wait ceiling", async () => {
    const { retry, waits } = instantRetry(() => 0);
    const exa = provider("exa", (() => {
      let calls = 0;
      return () => (++calls === 1 ? rejectWith({ provider: "exa", status: 429, retryAfterMs: 1500 })() : Promise.resolve(RESULTS));
    })());
    const svc = createSearchService({ providers: [exa], cache: createCache(dir), log, retry });
    const out = await svc.search({ query: "q" });
    expect(out.providers_used).toEqual(["exa"]);
    expect(waits).toEqual([1500]);
  });

  it("does not wait out a Retry-After longer than the ceiling", async () => {
    const { retry, waits } = instantRetry();
    const exa = provider("exa", rejectWith({ provider: "exa", status: 429, retryAfterMs: 30_000 }));
    const svc = createSearchService({ providers: [exa], cache: createCache(dir), log, retry });
    await expect(svc.search({ query: "q" })).rejects.toMatchObject({ code: "provider", retryable: true });
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("a recovered search is cached; a failed one is not", async () => {
    const { retry } = instantRetry();
    const brave = provider("brave", (() => {
      let calls = 0;
      return () => (++calls === 1 ? rejectWith({ status: 502 })() : Promise.resolve(RESULTS));
    })());
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry });
    await svc.search({ query: "q" });
    const again = await svc.search({ query: "q" });
    expect(again.cached).toBe(true);
    expect(brave.search).toHaveBeenCalledTimes(2);
  });
});

describe("SearchService per-provider concurrency", () => {
  /** A provider that records how many calls are in flight at once. */
  function gauge(name: SearchProviderName, holdMs = 60): { provider: SearchProvider; peak: () => number; calls: () => number } {
    let running = 0;
    let peak = 0;
    let calls = 0;
    return {
      peak: () => peak,
      calls: () => calls,
      provider: {
        name,
        isConfigured: () => true,
        async search() {
          calls++;
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, holdMs));
          running--;
          return RESULTS;
        },
      },
    };
  }

  it("allows at most 4 concurrent requests per provider by default", async () => {
    const brave = gauge("brave");
    const svc = createSearchService({ providers: [brave.provider], cache: createCache(dir), log });
    await Promise.all(Array.from({ length: 12 }, (_, i) => svc.search({ query: `query ${i}` })));
    expect(brave.calls()).toBe(12);
    expect(brave.peak()).toBe(4);
  });

  it("honors a configured limit", async () => {
    const brave = gauge("brave");
    const svc = createSearchService({ providers: [brave.provider], cache: createCache(dir), log, concurrencyPerProvider: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => svc.search({ query: `query ${i}` })));
    expect(brave.peak()).toBe(2);
  });

  it("limits each provider separately", async () => {
    const brave = gauge("brave");
    const exa = gauge("exa");
    const svc = createSearchService({ providers: [brave.provider, exa.provider], cache: createCache(dir), log, concurrencyPerProvider: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => svc.search({ query: `query ${i}` })));
    expect(brave.peak()).toBe(2);
    expect(exa.peak()).toBe(2);
  });

  it("holds a slot per attempt, not through the backoff wait", async () => {
    const waiting: Array<() => void> = [];
    const retry = { random: () => 0.5, sleep: () => new Promise<void>((r) => waiting.push(r)) };
    let calls = 0;
    const order: string[] = [];
    const brave = provider("brave", (q) => {
      calls++;
      order.push(q.query);
      return q.query === "slow" && calls === 1 ? rejectWith({ status: 503 })() : Promise.resolve(RESULTS);
    });
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log, retry, concurrencyPerProvider: 1 });
    const slow = svc.search({ query: "slow" });
    // Let "slow" reach the provider (and fail into its backoff wait) before "other" starts.
    while (waiting.length === 0) await new Promise((r) => setTimeout(r, 1));
    const other = svc.search({ query: "other" });
    // "other" finishes while "slow" is sleeping in its backoff: the single slot was released.
    await other;
    expect(order).toEqual(["slow", "other"]);
    waiting.forEach((r) => r());
    await slow;
    expect(order).toEqual(["slow", "other", "slow"]);
  });
});
