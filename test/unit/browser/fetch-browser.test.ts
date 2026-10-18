import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { BrowserFetcher, detectBotWall } from "../../../src/core/fetch/browser.js";
import { FetchError, type FetchOpts } from "../../../src/core/fetch/types.js";
import { makeConfig, makeTempDir, probeChromium, removeDir, startFixtureServer, type FixtureServer } from "./helpers.js";

const probe = await probeChromium();

const OPTS: FetchOpts = { maxChars: 40_000, timeoutMs: 15_000 };
const noAbort = (): AbortSignal => new AbortController().signal;

async function failure(p: Promise<unknown>): Promise<FetchError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchError);
    return err as FetchError;
  }
  throw new Error("expected the fetch to fail");
}

describe("detectBotWall (no browser needed)", () => {
  const probeOf = (title: string, text: string) => ({ title, text, textLength: text.length });

  it("flags challenge titles and short challenge bodies", () => {
    expect(detectBotWall(probeOf("Just a moment...", "x"))).toBeDefined();
    expect(detectBotWall(probeOf("Attention Required! | Cloudflare", "x"))).toBeDefined();
    expect(detectBotWall(probeOf("Home", "Please enable JavaScript to continue"))).toBeDefined();
    expect(detectBotWall(probeOf("Home", "We detected unusual traffic from your computer network"))).toBeDefined();
  });

  it("does not flag a long article that merely mentions a signature", () => {
    const long = "Please enable JavaScript is a phrase every web developer has seen. ".repeat(100);
    expect(detectBotWall(probeOf("A history of noscript tags", long))).toBeUndefined();
  });

  it("does not flag ordinary pages", () => {
    expect(detectBotWall(probeOf("How Tides Work", "Tides are the rise and fall of the sea."))).toBeUndefined();
  });
});

describe.skipIf(!probe.available)(`BrowserFetcher${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: FixtureServer;
  let session: BrowserSession;
  let fetcher: BrowserFetcher;
  let profileDir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
    fetcher = new BrowserFetcher(session, { challengeGraceMs: 0 });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  it("is named browser and always configured", () => {
    expect(fetcher.name).toBe("browser");
    expect(fetcher.isConfigured()).toBe(true);
  });

  it("converts an article to Markdown with headings and absolute links", async () => {
    const r = await fetcher.fetch(`${server.url}/article.html`, OPTS, noAbort());
    expect(r.method).toBe("browser");
    expect(r.botWall).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.url).toBe(`${server.url}/article.html`);
    expect(r.final_url).toBe(`${server.url}/article.html`);
    expect(r.title).toContain("Tides");
    expect(r.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r.markdown).toMatch(/^## The role of the moon$/m);
    expect(r.markdown).toMatch(/^## Spring and neap tides$/m);
    expect(r.markdown).toContain(`[guide to lunar gravity](${server.url}/guides/lunar-gravity)`);
    expect(r.markdown).toContain("[reference tables](https://example.org/tides)");
    expect(r.markdown).toMatch(/^-\s+Spring tides occur/m);
    expect(r.markdown).not.toContain("Copyright Ocean Notes");
    expect(r.markdown).not.toContain("<");
  });

  it("flags truncation when maxChars is exceeded, never silently", async () => {
    const full = await fetcher.fetch(`${server.url}/long`, OPTS, noAbort());
    expect(full.truncated).toBe(false);
    expect(full.markdown.length).toBeGreaterThan(2000);

    const cut = await fetcher.fetch(`${server.url}/long`, { ...OPTS, maxChars: 500 }, noAbort());
    expect(cut.truncated).toBe(true);
    expect(cut.markdown.length).toBeLessThanOrEqual(500);
    expect(full.markdown.startsWith(cut.markdown)).toBe(true);
  });

  it("waits for a selector that JavaScript renders late", async () => {
    const r = await fetcher.fetch(`${server.url}/js-rendered.html`, { ...OPTS, waitFor: "#late" }, noAbort());
    expect(r.markdown).toContain("Rendered By Script");
    expect(r.markdown).toContain("only exists after JavaScript ran");
  });

  it("reports timeout when the waitFor selector never appears", async () => {
    const err = await failure(
      fetcher.fetch(`${server.url}/article.html`, { ...OPTS, waitFor: "#never-there", timeoutMs: 1500 }, noAbort()),
    );
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("reports blocked for a Cloudflare-style challenge page (HTTP 200)", async () => {
    const err = await failure(fetcher.fetch(`${server.url}/cloudflare.html`, OPTS, noAbort()));
    expect(err.code).toBe("blocked");
    expect(err.fetcher).toBe("browser");
    expect(err.retryable).toBe(false);
  });

  it("reports blocked for a challenge served with HTTP 403 and for a bare 403", async () => {
    expect((await failure(fetcher.fetch(`${server.url}/cloudflare-403`, OPTS, noAbort()))).code).toBe("blocked");
    const bare = await failure(fetcher.fetch(`${server.url}/forbidden`, OPTS, noAbort()));
    expect(bare.code).toBe("blocked");
    expect(bare.status).toBe(403);
  });

  it("maps other HTTP errors and network failures to provider", async () => {
    const missing = await failure(fetcher.fetch(`${server.url}/missing`, OPTS, noAbort()));
    expect(missing).toMatchObject({ code: "provider", status: 404, retryable: false });

    const dead = await failure(fetcher.fetch("http://127.0.0.1:1/", OPTS, noAbort()));
    expect(dead.code).toBe("provider");
  });

  it("rejects non-http(s) URLs as invalid_input without touching the browser", async () => {
    const before = session.stats().totalAcquired;
    expect((await failure(fetcher.fetch("file:///etc/passwd", OPTS, noAbort()))).code).toBe("invalid_input");
    expect((await failure(fetcher.fetch("not a url", OPTS, noAbort()))).code).toBe("invalid_input");
    expect(session.stats().totalAcquired).toBe(before);
  });

  it("reports timeout on navigation timeout", async () => {
    const err = await failure(fetcher.fetch(`${server.url}/hang`, { ...OPTS, timeoutMs: 1000 }, noAbort()));
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("reports timeout when the caller aborts mid-fetch", async () => {
    const ctrl = new AbortController();
    const pending = fetcher.fetch(`${server.url}/hang`, { ...OPTS, timeoutMs: 30_000 }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    const started = Date.now();
    const err = await failure(pending);
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);

    const already = new AbortController();
    already.abort();
    expect((await failure(fetcher.fetch(`${server.url}/article.html`, OPTS, already.signal))).code).toBe("timeout");
  });

  it("always releases the page: success, blocked, timeout and abort all leave the pool empty", async () => {
    await fetcher.fetch(`${server.url}/article.html`, OPTS, noAbort());
    await failure(fetcher.fetch(`${server.url}/cloudflare.html`, OPTS, noAbort()));
    await failure(fetcher.fetch(`${server.url}/hang`, { ...OPTS, timeoutMs: 800 }, noAbort()));
    expect(session.stats()).toMatchObject({ activePages: 0, waiting: 0 });
  });

  it("runs several fetches at once through the 3-page pool", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `${server.url}/article.html?n=${i}`);
    const results = await Promise.all(urls.map((u) => fetcher.fetch(u, OPTS, noAbort())));
    expect(results.every((r) => r.markdown.includes("The role of the moon"))).toBe(true);
    expect(session.stats().activePages).toBe(0);
  });

  it("gives a clear provider error once the session is closed", async () => {
    const dir = await makeTempDir();
    try {
      const s = createBrowserSession(makeConfig(dir));
      await s.close();
      const err = await failure(new BrowserFetcher(s).fetch(`${server.url}/article.html`, OPTS, noAbort()));
      expect(err.code).toBe("provider");
      expect(err.message).toContain("closed");
    } finally {
      await removeDir(dir);
    }
  });
});
