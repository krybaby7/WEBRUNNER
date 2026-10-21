import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { visibleTextLength } from "../../src/core/fetch/botwall.js";
import { DirectFetcher } from "../../src/core/fetch/fast/direct.js";
import { FirecrawlFetcher } from "../../src/core/fetch/fast/firecrawl.js";
import { buildFastFetchers, runFastChain } from "../../src/core/fetch/fast/index.js";
import { JinaFetcher } from "../../src/core/fetch/fast/jina.js";
import type { FetchOpts } from "../../src/core/fetch/types.js";

/**
 * Real network fetches. Skipped unless RUN_INTEGRATION=1. Firecrawl tests
 * additionally need FIRECRAWL_API_KEY (set and non-empty: the live workflow
 * passes unset secrets as empty strings); the Jina key is optional.
 */
const enabled = process.env["RUN_INTEGRATION"] === "1";
const OPTS: FetchOpts = { maxChars: 40_000, timeoutMs: 30_000 };
const ARTICLE = "https://en.wikipedia.org/wiki/Markdown";

describe.skipIf(!enabled)("fast fetch integration", () => {
  it("direct: converts a real article to Markdown", async () => {
    const result = await new DirectFetcher().fetch(ARTICLE, OPTS, new AbortController().signal);
    expect(result.method).toBe("direct");
    expect(result.title).toMatch(/Markdown/);
    expect(result.markdown).toMatch(/^#{1,2} /m);
    expect(result.markdown).toMatch(/\]\(https:\/\/en\.wikipedia\.org\//);
    expect(visibleTextLength(result.markdown)).toBeGreaterThan(500);
    expect(result.botWall).toBe(false);
  });

  it("direct: follows a real redirect and reports final_url", async () => {
    const result = await new DirectFetcher().fetch("http://github.com/", OPTS, new AbortController().signal);
    expect(result.url).toBe("http://github.com/");
    expect(result.final_url).toMatch(/^https:\/\/github\.com\//);
  });

  it("direct: flags truncation on a real page", async () => {
    const result = await new DirectFetcher().fetch(ARTICLE, { ...OPTS, maxChars: 2000 }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(2000);
  });

  it("direct: extracts a real PDF to text (PDF support since WP14b)", async () => {
    const result = await new DirectFetcher().fetch("https://arxiv.org/pdf/1706.03762", OPTS, new AbortController().signal);
    expect(result.method).toBe("direct");
    expect(result.markdown).toMatch(/Attention Is All You Need/);
    // Pages are separated by a rule (README, fetch_page).
    expect(result.markdown).toContain("\n---\n");
    expect(visibleTextLength(result.markdown)).toBeGreaterThan(5000);
  });

  it("jina: returns Markdown for a real article", async () => {
    const config = loadConfig();
    const result = await new JinaFetcher({ apiKey: config.jina_api_key }).fetch(ARTICLE, OPTS, new AbortController().signal);
    expect(result.method).toBe("jina");
    expect(visibleTextLength(result.markdown)).toBeGreaterThan(500);
  });

  it.skipIf(!process.env["FIRECRAWL_API_KEY"])("firecrawl: returns Markdown for a real article", async () => {
    const result = await new FirecrawlFetcher({ apiKey: process.env["FIRECRAWL_API_KEY"] }).fetch(
      ARTICLE,
      OPTS,
      new AbortController().signal,
    );
    expect(result.method).toBe("firecrawl");
    expect(visibleTextLength(result.markdown)).toBeGreaterThan(500);
  });

  it("chain: the configured fast fetchers return a good result", async () => {
    const result = await runFastChain(buildFastFetchers(loadConfig()), ARTICLE, OPTS, new AbortController().signal);
    expect(result.botWall).toBe(false);
    expect(visibleTextLength(result.markdown)).toBeGreaterThan(500);
  });
});
