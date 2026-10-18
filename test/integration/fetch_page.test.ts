import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { createCache } from "../../src/core/cache/index.js";
import { BrowserFetcher } from "../../src/core/fetch/browser.js";
import { DirectFetcher } from "../../src/core/fetch/fast/direct.js";
import { createFetchService, type FetchService } from "../../src/core/fetch/index.js";
import { buildDeps, closeDeps, type Deps } from "../../src/deps.js";
import { log } from "../../src/log.js";
import { makeConfig, makeTempDir, removeDir } from "../unit/browser/helpers.js";

/**
 * Real network and real Chromium. Gated: run with
 *   RUN_INTEGRATION=1 npx vitest run test/integration/fetch_page.test.ts
 * Each suite uses a throwaway cache and browser profile.
 *
 * quotes.toscrape.com/js/ renders its quotes with JavaScript. Jina Reader
 * executes JavaScript itself, so it returns the quotes and auto mode would never
 * need the browser; the JS-page test therefore uses the direct HTTP fetcher as
 * its only fast path, which sees a near-empty shell.
 */
const RUN = process.env["RUN_INTEGRATION"] === "1";
const QUOTES = "https://quotes.toscrape.com/js/";

describe.skipIf(!RUN)(`fetch_page auto mode, JS-rendered page${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  let dir: string;
  let session: BrowserSession;
  let service: FetchService;

  beforeAll(async () => {
    dir = await makeTempDir("webrunner-fetchpage-js-");
    const config = makeConfig(dir);
    session = createBrowserSession(config);
    service = createFetchService({
      fastFetchers: [new DirectFetcher()],
      browserFetcher: new BrowserFetcher(session),
      cache: createCache(config.cache_dir),
      log,
    });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (dir) await removeDir(dir);
  }, 30_000);

  it("falls back to the browser when the fast path is thin, then serves the repeat from the cache", async () => {
    const out = await service.fetchPage({ url: QUOTES });
    expect(out.method).toBe("browser");
    expect(out.markdown).toMatch(/Albert Einstein/);
    expect(out.markdown).toMatch(/world as we have created it/i);
    expect(out.cached).toBe(false);

    const again = await service.fetchPage({ url: QUOTES });
    expect(again.cached).toBe(true);
    expect(again.method).toBe("browser");
  }, 120_000);

  it("mode fast on the same page never opens the browser and returns the thin shell", async () => {
    const out = await service.fetchPage({ url: QUOTES, mode: "fast" });
    expect(out.method).toBe("direct");
    expect(out.markdown).not.toMatch(/Albert Einstein/);
    expect(session.isOpen()).toBe(true); // opened by the previous test, not by this call
  }, 60_000);
});

describe.skipIf(!RUN)(`fetch_page through buildDeps${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  let dir: string;
  let deps: Deps;

  beforeAll(async () => {
    dir = await makeTempDir("webrunner-fetchpage-deps-");
    const env = process.env;
    deps = buildDeps({
      ...makeConfig(dir),
      ...(env["FIRECRAWL_API_KEY"] !== undefined && { firecrawl_api_key: env["FIRECRAWL_API_KEY"] }),
      ...(env["JINA_API_KEY"] !== undefined && { jina_api_key: env["JINA_API_KEY"] }),
    });
  }, 30_000);

  afterAll(async () => {
    if (deps) await closeDeps(deps);
    if (dir) await removeDir(dir);
  }, 30_000);

  it("a static article is served by a fast method and the browser stays closed", async () => {
    const out = await deps.fetch!.fetchPage({ url: "https://en.wikipedia.org/wiki/Markdown" });
    expect(["firecrawl", "jina", "direct"]).toContain(out.method);
    expect(out.markdown).toMatch(/Markdown/);
    expect(deps.browser!.isOpen()).toBe(false);
  }, 120_000);

  it("example.com: mode fast returns a fast method", async () => {
    const out = await deps.fetch!.fetchPage({ url: "https://example.com", mode: "fast" });
    expect(["firecrawl", "jina", "direct"]).toContain(out.method);
    expect(out.markdown).toMatch(/documentation examples/);
    expect(out.final_url).toMatch(/^https:\/\/example\.com\/?$/);
  }, 120_000);

  it("example.com: auto reads it (its fast text is under the thin threshold, so the browser may serve it)", async () => {
    const out = await deps.fetch!.fetchPage({ url: "https://example.com" });
    expect(out.markdown).toMatch(/documentation examples/);
  }, 120_000);

  it("a JS-rendered page is read through the shared wiring", async () => {
    const out = await deps.fetch!.fetchPage({ url: QUOTES });
    expect(["jina", "firecrawl", "browser"]).toContain(out.method);
    expect(out.markdown).toMatch(/Albert Einstein/);
  }, 120_000);
});
