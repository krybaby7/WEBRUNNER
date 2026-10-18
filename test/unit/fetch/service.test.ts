import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache, type Cache } from "../../../src/core/cache/index.js";
import {
  BROWSER_CACHE_TTL_MS,
  FAST_CACHE_TTL_MS,
  FetchServiceError,
  createFetchService,
  type FetchService,
} from "../../../src/core/fetch/index.js";
import {
  FetchError,
  type FetchMethod,
  type FetchOpts,
  type FetchResult,
  type Fetcher,
} from "../../../src/core/fetch/types.js";
import { canonicalizeUrl } from "../../../src/core/search/canonical.js";
import type { Logger } from "../../../src/log.js";

const URL_A = "https://example.com/article";
const BODY = "The quick brown fox jumps over the lazy dog while the service keeps reading. ".repeat(20);
const WALL = "Just a moment... Checking your browser before accessing the site.";

function page(over: Partial<FetchResult> = {}): FetchResult {
  return {
    url: URL_A,
    final_url: URL_A,
    title: "Article",
    markdown: `# Article\n\n${BODY}`,
    truncated: false,
    method: "direct",
    fetched_at: "2026-10-18T00:00:00.000Z",
    botWall: false,
    ...over,
  };
}

type Step = FetchResult | Error | ((url: string, opts: FetchOpts, signal: AbortSignal) => Promise<FetchResult>);

/** A fetcher that answers from a script (the last step repeats) and records every call. */
function fake(name: FetchMethod, ...steps: Step[]): Fetcher & { calls: Array<{ url: string; opts: FetchOpts }> } {
  const calls: Array<{ url: string; opts: FetchOpts }> = [];
  return {
    name,
    calls,
    isConfigured: () => true,
    async fetch(url, opts, signal) {
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push({ url, opts });
      if (step === undefined) throw new Error("no step scripted");
      if (typeof step === "function") return step(url, opts, signal);
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const fastPage = (over: Partial<FetchResult> = {}): FetchResult => page({ method: "jina", ...over });
const browserPage = (over: Partial<FetchResult> = {}): FetchResult => page({ method: "browser", ...over });

let dir: string;
let clock: number;
let cache: Cache;
let log: Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-fetch-"));
  clock = 1_000_000;
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  cache = createCache(dir, { now: () => clock, log });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(fast: Fetcher[], browser?: Fetcher, extra: { timeoutMs?: number; browserTimeoutMs?: number; secrets?: string[] } = {}): FetchService {
  return createFetchService({
    fastFetchers: fast,
    ...(browser !== undefined && { browserFetcher: browser }),
    cache,
    log,
    now: () => clock,
    ...extra,
  });
}

async function failure(p: Promise<unknown>): Promise<FetchServiceError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchServiceError);
    return err as FetchServiceError;
  }
  throw new Error("expected the call to fail");
}

describe("fast mode", () => {
  it("never touches the browser fetcher, even for a bot wall or a thin page", async () => {
    const fast = fake("jina", fastPage({ botWall: true, markdown: WALL }));
    const browser = fake("browser", browserPage());
    const spy = vi.spyOn(browser, "fetch");
    const svc = service([fast], browser);

    const out = await svc.fetchPage({ url: URL_A, mode: "fast" });
    expect(out.method).toBe("jina");
    expect(spy).not.toHaveBeenCalled();
    expect(fast.calls).toHaveLength(1);
    expect(fast.calls[0]?.opts.maxChars).toBe(40_000);
    expect(fast.calls[0]?.opts.timeoutMs).toBe(20_000);
  });

  it("maps a thrown blocked FetchError one-to-one without trying the browser", async () => {
    const fast = fake("jina", new FetchError("jina", "blocked", "Cloudflare challenge", false, 403));
    const browser = fake("browser", browserPage());
    const err = await failure(service([fast], browser).fetchPage({ url: URL_A, mode: "fast" }));
    expect(err).toMatchObject({ code: "blocked", retryable: false, method: "jina", message: "Cloudflare challenge" });
    expect(browser.calls).toHaveLength(0);
  });

  it("reports config when there is no usable fast fetcher", async () => {
    const err = await failure(service([]).fetchPage({ url: URL_A, mode: "fast" }));
    expect(err.code).toBe("config");
  });

  it("rejects non-http URLs as invalid_input", async () => {
    const err = await failure(service([fake("jina", fastPage())]).fetchPage({ url: "ftp://example.com/x" }));
    expect(err.code).toBe("invalid_input");
  });
});

describe("browser mode", () => {
  it("uses only the browser fetcher and passes wait_for, max_chars and the 45 s timeout", async () => {
    const fast = fake("jina", fastPage());
    const browser = fake("browser", browserPage());
    const out = await service([fast], browser).fetchPage({
      url: URL_A,
      mode: "browser",
      wait_for: "#app",
      max_chars: 5000,
    });
    expect(out.method).toBe("browser");
    expect(fast.calls).toHaveLength(0);
    expect(browser.calls[0]?.opts).toEqual({ maxChars: 5000, waitFor: "#app", timeoutMs: 45_000 });
  });

  it("reports config when the browser fetcher is missing", async () => {
    const err = await failure(service([fake("jina", fastPage())]).fetchPage({ url: URL_A, mode: "browser" }));
    expect(err).toMatchObject({ code: "config", method: "browser" });
  });
});

describe("auto mode", () => {
  it("returns a good fast result without calling the browser", async () => {
    const fast = fake("jina", fastPage());
    const browser = fake("browser", browserPage());
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("jina");
    expect(browser.calls).toHaveLength(0);
  });

  it("falls back to the browser when the fast result is a bot wall", async () => {
    const fast = fake("jina", fastPage({ botWall: true, markdown: WALL }));
    const browser = fake("browser", browserPage());
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("browser");
    expect(out.markdown).toContain("quick brown fox");
    expect(browser.calls).toHaveLength(1);
  });

  it("falls back to the browser when the fast result is thin", async () => {
    const fast = fake("jina", fastPage({ markdown: "# Loading...\n\nPlease wait." }));
    const browser = fake("browser", browserPage());
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("browser");
    expect(browser.calls).toHaveLength(1);
  });

  it("falls back to the browser when the fast chain throws blocked", async () => {
    const fast = fake("jina", new FetchError("jina", "blocked", "HTTP 403 challenge", false, 403));
    const browser = fake("browser", browserPage());
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("browser");
    expect(browser.calls).toHaveLength(1);
  });

  it("does not fall back on other fast errors", async () => {
    const fast = fake("jina", new FetchError("jina", "provider", "Jina Reader returned HTTP 500", true, 500));
    const browser = fake("browser", browserPage());
    const err = await failure(service([fast], browser).fetchPage({ url: URL_A }));
    expect(err).toMatchObject({ code: "provider", retryable: true, method: "jina" });
    expect(browser.calls).toHaveLength(0);
  });

  it("surfaces blocked when the browser itself is blocked after a bot wall", async () => {
    const fast = fake("jina", fastPage({ botWall: true, markdown: WALL }));
    const browser = fake("browser", new FetchError("browser", "blocked", "Page is behind a bot wall", false));
    const err = await failure(service([fast], browser).fetchPage({ url: URL_A }));
    expect(err).toMatchObject({ code: "blocked", method: "browser", retryable: false });
  });

  it("surfaces blocked when the fast chain threw blocked and no browser is available", async () => {
    const fast = fake("jina", new FetchError("jina", "blocked", "HTTP 403 challenge", false, 403));
    const err = await failure(service([fast]).fetchPage({ url: URL_A }));
    expect(err).toMatchObject({ code: "blocked", method: "jina" });
  });

  it("surfaces blocked when the fast result is a bot wall and no browser is available", async () => {
    const fast = fake("jina", fastPage({ botWall: true, markdown: WALL }));
    const err = await failure(service([fast]).fetchPage({ url: URL_A }));
    expect(err.code).toBe("blocked");
  });

  it("returns the fast result when the browser fails with a non-blocked error", async () => {
    const fast = fake("jina", fastPage({ markdown: "# Short\n\nA short page." }));
    const browser = fake("browser", new FetchError("browser", "timeout", "Navigation timed out", true));
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("jina");
    expect(out.markdown).toContain("A short page.");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("browser fallback failed"),
      expect.objectContaining({ code: "timeout" }),
    );
  });

  it("rethrows the browser error when there was no fast result", async () => {
    const fast = fake("jina", new FetchError("jina", "blocked", "HTTP 403", false, 403));
    const browser = fake("browser", new FetchError("browser", "provider", "Chromium crashed", true));
    const err = await failure(service([fast], browser).fetchPage({ url: URL_A }));
    expect(err).toMatchObject({ code: "provider", method: "browser", retryable: true });
  });

  it("keeps a legitimately thin page: the browser adds nothing, so the fast result wins", async () => {
    const thin = "# Example Domain\n\nThis domain is for use in illustrative examples.";
    const fast = fake("jina", fastPage({ markdown: thin }));
    const browser = fake("browser", browserPage({ markdown: thin }));
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("jina");
    expect(browser.calls).toHaveLength(1);
  });

  it("prefers a browser result that is still thin but has far more text than the fast result", async () => {
    const fast = fake("jina", fastPage({ markdown: "# App\n\nLoading." }));
    const browser = fake("browser", browserPage({ markdown: `# App\n\n${"Real rendered content. ".repeat(12)}` }));
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("browser");
  });

  it("returns the thin fast result when the browser is blocked on a page with no wall evidence", async () => {
    const fast = fake("jina", fastPage({ markdown: "# Short\n\nA short page." }));
    const browser = fake("browser", new FetchError("browser", "blocked", "wall", false));
    const out = await service([fast], browser).fetchPage({ url: URL_A });
    expect(out.method).toBe("jina");
  });
});

describe("timeouts", () => {
  const hang: Step = (_url, _opts, signal) =>
    new Promise<FetchResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  it("times a fast attempt out with a timeout error", async () => {
    const err = await failure(service([fake("jina", hang)], undefined, { timeoutMs: 30 }).fetchPage({ url: URL_A, mode: "fast" }));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
  });

  it("times a browser attempt out even when the fetcher ignores the signal", async () => {
    const never: Step = () => new Promise<FetchResult>(() => undefined);
    const err = await failure(
      service([], fake("browser", never), { browserTimeoutMs: 30 }).fetchPage({ url: URL_A, mode: "browser" }),
    );
    expect(err).toMatchObject({ code: "timeout", method: "browser" });
  });
});

describe("cache", () => {
  it("serves the second identical call from the cache with cached: true and no fetcher calls", async () => {
    const fast = fake("jina", fastPage());
    const browser = fake("browser", browserPage());
    const svc = service([fast], browser);
    const first = await svc.fetchPage({ url: URL_A });
    expect(first.cached).toBe(false);
    const second = await svc.fetchPage({ url: URL_A });
    expect(second).toEqual({ ...first, cached: true });
    expect(fast.calls).toHaveLength(1);
    expect(browser.calls).toHaveLength(0);
  });

  it("keys on mode, max_chars and wait_for", async () => {
    const fast = fake("jina", fastPage());
    const browser = fake("browser", browserPage());
    const svc = service([fast], browser);
    await svc.fetchPage({ url: URL_A, mode: "fast" });
    await svc.fetchPage({ url: URL_A, mode: "fast", max_chars: 5000 });
    await svc.fetchPage({ url: URL_A, mode: "browser" });
    await svc.fetchPage({ url: URL_A, mode: "browser", wait_for: "#x" });
    expect(fast.calls).toHaveLength(2);
    expect(browser.calls).toHaveLength(2);
    await svc.fetchPage({ url: URL_A, mode: "fast", max_chars: 5000 });
    expect(fast.calls).toHaveLength(2);
  });

  it("treats tracking-parameter variants of a URL as the same page", async () => {
    const fast = fake("jina", fastPage());
    const svc = service([fast]);
    await svc.fetchPage({ url: URL_A });
    const hit = await svc.fetchPage({ url: `${URL_A}?utm_source=x#top` });
    expect(hit.cached).toBe(true);
    expect(hit.url).toBe(`${URL_A}?utm_source=x#top`);
    expect(fast.calls).toHaveLength(1);
  });

  it("caches fast results for 24 h and browser results for 1 h", async () => {
    const fast = fake("jina", fastPage());
    const browser = fake("browser", browserPage());
    const svc = service([fast], browser);
    await svc.fetchPage({ url: URL_A, mode: "fast" });
    await svc.fetchPage({ url: URL_A, mode: "browser" });

    clock += BROWSER_CACHE_TTL_MS - 1;
    expect((await svc.fetchPage({ url: URL_A, mode: "browser" })).cached).toBe(true);
    expect((await svc.fetchPage({ url: URL_A, mode: "fast" })).cached).toBe(true);

    clock += 2; // just past one hour
    expect((await svc.fetchPage({ url: URL_A, mode: "browser" })).cached).toBe(false);
    expect(browser.calls).toHaveLength(2);
    expect((await svc.fetchPage({ url: URL_A, mode: "fast" })).cached).toBe(true);

    clock += FAST_CACHE_TTL_MS;
    expect((await svc.fetchPage({ url: URL_A, mode: "fast" })).cached).toBe(false);
    expect(fast.calls).toHaveLength(2);
    expect(BROWSER_CACHE_TTL_MS).toBeLessThan(FAST_CACHE_TTL_MS);
  });

  it("uses the browser TTL for an auto result that came from the browser", async () => {
    const fast = fake("jina", fastPage({ botWall: true, markdown: WALL }));
    const browser = fake("browser", browserPage());
    const svc = service([fast], browser);
    expect((await svc.fetchPage({ url: URL_A })).method).toBe("browser");
    clock += BROWSER_CACHE_TTL_MS + 1;
    expect((await svc.fetchPage({ url: URL_A })).cached).toBe(false);
  });

  it("does not cache bot-walled results", async () => {
    const fast = fake("jina", fastPage({ botWall: true, markdown: WALL }));
    const svc = service([fast]);
    await svc.fetchPage({ url: URL_A, mode: "fast" });
    const again = await svc.fetchPage({ url: URL_A, mode: "fast" });
    expect(again.cached).toBe(false);
    expect(fast.calls).toHaveLength(2);
  });

  it("does not cache thin results", async () => {
    const fast = fake("jina", fastPage({ markdown: "# Tiny\n\nNot much here." }));
    const svc = service([fast]);
    await svc.fetchPage({ url: URL_A, mode: "fast" });
    expect((await svc.fetchPage({ url: URL_A, mode: "fast" })).cached).toBe(false);
    expect(fast.calls).toHaveLength(2);
  });

  it("stores a second entry under final_url so a request for the redirect target hits", async () => {
    const target = "https://www.example.com/landing/";
    const fast = fake("jina", fastPage({ url: "https://example.com/go", final_url: target }));
    const svc = service([fast]);
    await svc.fetchPage({ url: "https://example.com/go" });
    const hit = await svc.fetchPage({ url: target });
    expect(hit.cached).toBe(true);
    expect(hit.url).toBe(target);
    expect(hit.final_url).toBe(target);
    expect(fast.calls).toHaveLength(1);
  });

  it("treats an entry that does not match the output schema as a miss", async () => {
    await cache.set(
      { kind: "fetch_page", url: canonicalizeUrl(URL_A), mode: "auto", max_chars: 40_000, wait_for: undefined },
      { url: URL_A, markdown: 42 },
      FAST_CACHE_TTL_MS,
    );
    const fast = fake("jina", fastPage());
    const out = await service([fast]).fetchPage({ url: URL_A });
    expect(out.cached).toBe(false);
    expect(out.markdown).toContain("quick brown fox");
    expect(fast.calls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("does not cache failures", async () => {
    const fast = fake("jina", new FetchError("jina", "provider", "boom", true, 500), fastPage());
    const svc = service([fast]);
    await failure(svc.fetchPage({ url: URL_A, mode: "fast" }));
    const out = await svc.fetchPage({ url: URL_A, mode: "fast" });
    expect(out.cached).toBe(false);
  });
});

describe("redaction", () => {
  it("scrubs configured keys and Bearer tokens from error messages", async () => {
    const key = "fc-supersecretkey-12345";
    const fast = fake(
      "firecrawl",
      new FetchError("firecrawl", "provider", `request failed with ${key}; Authorization: Bearer abc.DEF-123_xyz`, false, 500),
    );
    const err = await failure(service([fast], undefined, { secrets: [key] }).fetchPage({ url: URL_A, mode: "fast" }));
    expect(err.message).not.toContain(key);
    expect(err.message).not.toContain("abc.DEF-123_xyz");
    expect(err.message).toContain("[redacted]");
    expect(err.code).toBe("provider");
  });

  it("scrubs keys from errors of unexpected types and from the logs", async () => {
    const key = "jina_topsecret_value";
    const fast = fake("jina", new TypeError(`bad header ${key}`));
    const err = await failure(service([fast], undefined, { secrets: [key] }).fetchPage({ url: URL_A, mode: "fast" }));
    expect(err.code).toBe("provider"); // runFastChain wraps unexpected throws
    expect(err.message).not.toContain(key);
    const logged = JSON.stringify((log.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain(key);
  });
});
