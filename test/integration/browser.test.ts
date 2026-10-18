import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../src/core/browser/session.js";
import type { BrowserSession } from "../../src/core/browser/types.js";
import { takeSnapshot } from "../../src/core/browser/snapshot.js";
import { BrowserFetcher } from "../../src/core/fetch/browser.js";
import { makeConfig, makeTempDir, removeDir } from "../unit/browser/helpers.js";

/**
 * Real external JS-rendered page. Gated: run with
 *   RUN_INTEGRATION=1 npx vitest run test/integration/browser.test.ts
 * quotes.toscrape.com/js/ is a public scraping sandbox whose quotes exist only
 * after JavaScript runs, so a plain HTTP fetch of it has no quote text.
 */
const RUN = process.env["RUN_INTEGRATION"] === "1";
const URL_UNDER_TEST = "https://quotes.toscrape.com/js/";

describe.skipIf(!RUN)(`browser fetch of a real JS-rendered page${RUN ? "" : " (set RUN_INTEGRATION=1 to run)"}`, () => {
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  it("returns more than 500 chars of rendered body text as Markdown", async () => {
    const fetcher = new BrowserFetcher(session);
    const r = await fetcher.fetch(
      URL_UNDER_TEST,
      { maxChars: 40_000, timeoutMs: 30_000, waitFor: ".quote" },
      new AbortController().signal,
    );
    expect(r.method).toBe("browser");
    expect(r.final_url).toContain("quotes.toscrape.com");
    expect(r.markdown.length).toBeGreaterThan(500);
    expect(r.markdown).toContain("Albert Einstein");
  }, 60_000);

  it("snapshots the same page with refs for its links", async () => {
    const page = await session.acquire();
    try {
      await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".quote");
      const snap = await takeSnapshot(page);
      expect(snap.axTree).toContain("link");
      expect(snap.refs.size).toBeGreaterThan(5);
    } finally {
      await session.release(page);
    }
  }, 60_000);
});
