import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache } from "../../../src/core/cache/index.js";
import { createSearchService, SearchError } from "../../../src/core/search/index.js";
import {
  ProviderError,
  type RawResult,
  type SearchProvider,
  type SearchProviderName,
  type SearchQuery,
} from "../../../src/core/search/types.js";
import type { Logger } from "../../../src/log.js";

let dir: string;
let log: Logger & { warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-search-"));
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type SearchFn = (q: SearchQuery, signal: AbortSignal) => Promise<RawResult[]>;

function fake(name: SearchProviderName, search: SearchFn, configured = true): SearchProvider & {
  search: ReturnType<typeof vi.fn<SearchFn>>;
} {
  return { name, isConfigured: () => configured, search: vi.fn<SearchFn>(search) };
}

function raw(url: string, rank: number, title = `title ${rank}`): RawResult {
  return { url, title, snippet: `snippet ${rank}`, rank };
}

const braveResults = [raw("https://a.com/1", 1), raw("https://b.com/2", 2), raw("https://c.com/3", 3)];
const exaResults = [raw("https://b.com/2", 1, "B, longer title"), raw("https://d.com/4", 2)];

function healthy(): [ReturnType<typeof fake>, ReturnType<typeof fake>] {
  return [fake("brave", () => Promise.resolve(braveResults)), fake("exa", () => Promise.resolve(exaResults))];
}

describe("createSearchService", () => {
  it("fans out to every configured provider and returns fused results", async () => {
    const [brave, exa] = healthy();
    const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
    const out = await svc.search({ query: "q", max_results: 10 });

    expect(out.query).toBe("q");
    expect(out.cached).toBe(false);
    expect(out.providers_used).toEqual(["brave", "exa"]);
    expect(out.providers_failed).toEqual([]);
    expect(out.latency_ms).toBeGreaterThanOrEqual(0);
    expect(out.results.map((r) => r.url)).toEqual(["https://b.com/2", "https://a.com/1", "https://d.com/4", "https://c.com/3"]);
    expect(out.results[0]).toMatchObject({ providers: ["brave", "exa"], title: "B, longer title" });
    expect(brave.search).toHaveBeenCalledTimes(1);
    expect(brave.search.mock.calls[0]?.[0]).toEqual({ query: "q", maxResults: 10 });
    expect(brave.search.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("passes recency and domain filters to providers and applies the default max_results", async () => {
    const [brave] = healthy();
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log });
    await svc.search({ query: "q", recency: "week", include_domains: ["a.com"], exclude_domains: ["b.com"] });
    expect(brave.search.mock.calls[0]?.[0]).toEqual({
      query: "q",
      maxResults: 10,
      recency: "week",
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
    });
  });

  it("truncates fused output to max_results", async () => {
    const [brave, exa] = healthy();
    const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
    const out = await svc.search({ query: "q", max_results: 2 });
    expect(out.results).toHaveLength(2);
  });

  it("only runs the requested providers", async () => {
    const [brave, exa] = healthy();
    const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
    const out = await svc.search({ query: "q", providers: ["exa"] });
    expect(out.providers_used).toEqual(["exa"]);
    expect(brave.search).not.toHaveBeenCalled();
  });

  it("reports a provider that throws and still returns results from the others", async () => {
    const brave = fake("brave", () =>
      Promise.reject(new ProviderError({ provider: "brave", message: "brave returned HTTP 500", status: 500, retryable: true })),
    );
    const [, exa] = healthy();
    const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
    const out = await svc.search({ query: "q" });
    expect(out.providers_used).toEqual(["exa"]);
    expect(out.providers_failed).toEqual([{ provider: "brave", error: "brave returned HTTP 500" }]);
    expect(out.results.map((r) => r.url)).toEqual(["https://b.com/2", "https://d.com/4"]);
    expect(log.warn).toHaveBeenCalled();
  });

  it("also survives a provider that throws something other than ProviderError, or synchronously", async () => {
    const weird = fake("brave", () => Promise.reject(new TypeError("boom")));
    const sync = fake("tavily", () => {
      throw new Error("sync boom");
    });
    const [, exa] = healthy();
    const svc = createSearchService({ providers: [weird, sync, exa], cache: createCache(dir), log });
    const out = await svc.search({ query: "q" });
    expect(out.providers_used).toEqual(["exa"]);
    expect(out.providers_failed).toEqual([
      { provider: "brave", error: "boom" },
      { provider: "tavily", error: "sync boom" },
    ]);
  });

  it("does not cache a result that was degraded by a provider failure", async () => {
    let fail = true;
    const brave = fake("brave", () =>
      fail ? Promise.reject(new ProviderError({ provider: "brave", message: "down", retryable: true })) : Promise.resolve(braveResults),
    );
    const [, exa] = healthy();
    const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
    const first = await svc.search({ query: "q" });
    expect(first.providers_failed).toHaveLength(1);
    fail = false;
    const second = await svc.search({ query: "q" });
    expect(second.cached).toBe(false);
    expect(second.providers_used).toEqual(["brave", "exa"]);
  });

  it("lists a requested but unconfigured provider as 'not configured' and continues", async () => {
    const [brave] = healthy();
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log });
    const out = await svc.search({ query: "q", providers: ["brave", "exa"] });
    expect(out.providers_used).toEqual(["brave"]);
    expect(out.providers_failed).toEqual([{ provider: "exa", error: "not configured" }]);
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("throws a config SearchError when none of the requested providers is configured", async () => {
    const [brave] = healthy();
    const svc = createSearchService({ providers: [brave], cache: createCache(dir), log });
    const err = await svc.search({ query: "q", providers: ["exa"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect(err).toMatchObject({
      code: "config",
      retryable: false,
      providersFailed: [{ provider: "exa", error: "not configured" }],
    });
    expect(brave.search).not.toHaveBeenCalled();
  });

  it("throws a config SearchError when no provider is configured at all", async () => {
    const svc = createSearchService({ providers: [], cache: createCache(dir), log });
    const err = await svc.search({ query: "q" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect(err).toMatchObject({ code: "config", retryable: false });
    expect((err as SearchError).message).toContain("BRAVE_API_KEY");

    const unconfigured = fake("brave", () => Promise.resolve([]), false);
    const svc2 = createSearchService({ providers: [unconfigured], cache: createCache(dir), log });
    await expect(svc2.search({ query: "q" })).rejects.toMatchObject({ code: "config" });
    expect(unconfigured.search).not.toHaveBeenCalled();
  });

  it("throws a provider SearchError when every requested provider fails", async () => {
    const a = fake("brave", () =>
      Promise.reject(new ProviderError({ provider: "brave", message: "brave returned HTTP 401", status: 401, retryable: false })),
    );
    const b = fake("exa", () =>
      Promise.reject(new ProviderError({ provider: "exa", message: "exa returned HTTP 429", status: 429, retryable: true })),
    );
    const svc = createSearchService({ providers: [a, b], cache: createCache(dir), log });
    const err = await svc.search({ query: "q" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect(err).toMatchObject({
      code: "provider",
      retryable: true,
      providersFailed: [
        { provider: "brave", error: "brave returned HTTP 401" },
        { provider: "exa", error: "exa returned HTTP 429" },
      ],
    });
  });

  it("marks an all-failed call as non-retryable when no failure is retryable", async () => {
    const a = fake("brave", () =>
      Promise.reject(new ProviderError({ provider: "brave", message: "bad key", status: 401, retryable: false })),
    );
    const svc = createSearchService({ providers: [a], cache: createCache(dir), log });
    await expect(svc.search({ query: "q" })).rejects.toMatchObject({ code: "provider", retryable: false });
  });

  describe("timeouts", () => {
    it("cuts off a provider that never resolves and reports it as timed out", async () => {
      const hang = fake("brave", () => new Promise<RawResult[]>(() => undefined));
      const [, exa] = healthy();
      const svc = createSearchService({ providers: [hang, exa], cache: createCache(dir), log, timeoutMs: 100 });
      const t0 = Date.now();
      const out = await svc.search({ query: "q" });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(1000);
      expect(out.providers_used).toEqual(["exa"]);
      expect(out.providers_failed).toHaveLength(1);
      expect(out.providers_failed[0]?.provider).toBe("brave");
      expect(out.providers_failed[0]?.error).toContain("timed out");
      expect(out.results.length).toBeGreaterThan(0);
    });

    it("hands each provider a signal that aborts at the timeout", async () => {
      let seen: AbortSignal | undefined;
      const p = fake("brave", (_q, signal) => {
        seen = signal;
        return new Promise<RawResult[]>((_res, rej) =>
          signal.addEventListener("abort", () =>
            rej(new ProviderError({ provider: "brave", message: "brave request aborted", retryable: true, aborted: true })),
          ),
        );
      });
      const svc = createSearchService({ providers: [p], cache: createCache(dir), log, timeoutMs: 50 });
      await expect(svc.search({ query: "q" })).rejects.toBeInstanceOf(SearchError);
      expect(seen?.aborted).toBe(true);
    });

    it("throws a retryable timeout SearchError when every provider timed out", async () => {
      const a = fake("brave", () => new Promise<RawResult[]>(() => undefined));
      const b = fake("exa", () => new Promise<RawResult[]>(() => undefined));
      const svc = createSearchService({ providers: [a, b], cache: createCache(dir), log, timeoutMs: 50 });
      const t0 = Date.now();
      const err = await svc.search({ query: "q" }).catch((e: unknown) => e);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(err).toBeInstanceOf(SearchError);
      expect(err).toMatchObject({ code: "timeout", retryable: true });
      expect((err as SearchError).providersFailed.map((f) => f.error)).toEqual([
        expect.stringContaining("timed out"),
        expect.stringContaining("timed out"),
      ]);
    });

    it("reports a provider that gives up on its own abort as timed out", async () => {
      const p = fake("brave", () =>
        Promise.reject(new ProviderError({ provider: "brave", message: "brave request aborted", retryable: true, aborted: true })),
      );
      const [, exa] = healthy();
      const svc = createSearchService({ providers: [p, exa], cache: createCache(dir), log });
      const out = await svc.search({ query: "q" });
      expect(out.providers_failed[0]?.error).toContain("timed out");
    });
  });

  describe("cache", () => {
    it("serves the second identical call from the cache without calling providers", async () => {
      const [brave, exa] = healthy();
      const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
      const first = await svc.search({ query: "q", max_results: 10 });
      expect(first.cached).toBe(false);
      expect(brave.search).toHaveBeenCalledTimes(1);

      const second = await svc.search({ query: "q", max_results: 10 });
      expect(second.cached).toBe(true);
      expect(brave.search).toHaveBeenCalledTimes(1);
      expect(exa.search).toHaveBeenCalledTimes(1);
      expect(second.results).toEqual(first.results);
      expect(second.providers_used).toEqual(first.providers_used);
    });

    it("treats the default max_results as 10 and domain order as irrelevant", async () => {
      const [brave] = healthy();
      const svc = createSearchService({ providers: [brave], cache: createCache(dir), log });
      await svc.search({ query: "q", include_domains: ["b.com", "a.com"] });
      const again = await svc.search({ query: "q", max_results: 10, include_domains: ["a.com", "b.com"] });
      expect(again.cached).toBe(true);
      expect(brave.search).toHaveBeenCalledTimes(1);
    });

    it("misses when max_results differs", async () => {
      const [brave] = healthy();
      const svc = createSearchService({ providers: [brave], cache: createCache(dir), log });
      await svc.search({ query: "q", max_results: 10 });
      const other = await svc.search({ query: "q", max_results: 5 });
      expect(other.cached).toBe(false);
      expect(brave.search).toHaveBeenCalledTimes(2);
    });

    it("misses when query, recency, domains or providers differ", async () => {
      const [brave, exa] = healthy();
      const svc = createSearchService({ providers: [brave, exa], cache: createCache(dir), log });
      await svc.search({ query: "q" });
      for (const variant of [
        { query: "other" },
        { query: "q", recency: "day" as const },
        { query: "q", include_domains: ["a.com"] },
        { query: "q", exclude_domains: ["a.com"] },
        { query: "q", providers: ["brave" as const] },
      ]) {
        expect((await svc.search(variant)).cached).toBe(false);
      }
    });

    it("expires after one hour (injected clock)", async () => {
      let t = 1_700_000_000_000;
      const [brave] = healthy();
      const cache = createCache(dir, { now: () => t });
      const svc = createSearchService({ providers: [brave], cache, log, now: () => t });
      await svc.search({ query: "q" });
      t += 60 * 60 * 1000 - 1;
      expect((await svc.search({ query: "q" })).cached).toBe(true);
      t += 1;
      expect((await svc.search({ query: "q" })).cached).toBe(false);
      expect(brave.search).toHaveBeenCalledTimes(2);
    });

    it("survives a corrupt cache file: a miss, a warn log, and a fresh result", async () => {
      const [brave] = healthy();
      const cache = createCache(dir, { log });
      const svc = createSearchService({ providers: [brave], cache, log });
      await svc.search({ query: "q" });
      const file = readdirSync(dir, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(".json"));
      expect(file).toBeDefined();
      writeFileSync(join(dir, file ?? ""), "\u0000garbage{{{");
      log.warn.mockClear();

      const out = await svc.search({ query: "q" });
      expect(out.cached).toBe(false);
      expect(brave.search).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalled();
    });

    it("ignores a cache entry that does not match the output schema", async () => {
      const [brave] = healthy();
      const cache = createCache(dir);
      await cache.set(
        { query: "q", include_domains: [], exclude_domains: [], providers: ["brave"], max_results: 10 },
        { not: "an output" },
        60_000,
      );
      const svc = createSearchService({ providers: [brave], cache, log });
      const out = await svc.search({ query: "q" });
      expect(out.cached).toBe(false);
      expect(brave.search).toHaveBeenCalledTimes(1);
    });
  });

  describe("secrets", () => {
    it("never lets an API key through in providers_failed or logs", async () => {
      const key = "sk-live-0123456789abcdef";
      const leaky = fake("brave", () =>
        Promise.reject(
          new ProviderError({
            provider: "brave",
            message: `brave network error: request to https://x.test/search?api_key=${key}&q=1 failed; Authorization: Bearer ${key}`,
            retryable: true,
          }),
        ),
      );
      const leaky2 = fake("tavily", () => Promise.reject(new Error(`bad credentials ${key} rejected`)));
      const [, exa] = healthy();
      const svc = createSearchService({ providers: [leaky, leaky2, exa], cache: createCache(dir), log, secrets: [key] });
      const out = await svc.search({ query: "q" });
      const dump = JSON.stringify([out, log.warn.mock.calls]);
      expect(dump).not.toContain(key);
      expect(out.providers_failed).toHaveLength(2);
    });

    it("scrubs key-looking patterns even without an explicit secret list", async () => {
      const leaky = fake("brave", () =>
        Promise.reject(new ProviderError({ provider: "brave", message: "failed: Bearer abc.def-123 and key=zzz999", retryable: false })),
      );
      const [, exa] = healthy();
      const svc = createSearchService({ providers: [leaky, exa], cache: createCache(dir), log });
      const out = await svc.search({ query: "q" });
      const msg = out.providers_failed[0]?.error ?? "";
      expect(msg).not.toContain("abc.def-123");
      expect(msg).not.toContain("zzz999");
    });
  });
});
