import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { RecipeError } from "../../../../src/core/browser/recipes/types.js";
import type { SocialRecipe } from "../../../../src/core/browser/recipes/social-common.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import { CostMeter } from "../../../../src/core/llm/cost.js";
import { LlmError } from "../../../../src/core/llm/types.js";
import { buildBrowserSocialPlatforms } from "../../../../src/core/social/platforms/browser.js";
import { FacebookProvider } from "../../../../src/core/social/platforms/facebook.js";
import { RedditBrowserProvider } from "../../../../src/core/social/platforms/reddit-browser.js";
import { BROWSER_SOCIAL_DEFAULT_TIMEOUT_MS } from "../../../../src/core/social/platforms/shared-browser.js";
import { XProvider } from "../../../../src/core/social/platforms/x.js";
import { SocialProviderError } from "../../../../src/core/social/types.js";
import { SocialSearchQuerySchema, type SocialItem, type SocialSearchQuery } from "../../../../src/schemas/social.js";
import { makeLogger, scriptedLlm, SEARCH_QUERY } from "./helpers.js";

const never = (): AbortSignal => new AbortController().signal;

type FakeBrowser = BrowserSession & { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; page: Page & { close: ReturnType<typeof vi.fn> } };

function fakeBrowser(): FakeBrowser {
  const page = { close: vi.fn().mockResolvedValue(undefined) } as unknown as FakeBrowser["page"];
  return {
    page,
    acquire: vi.fn().mockResolvedValue(page),
    release: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isOpen: () => true,
    stats: () => ({}) as never,
    cookies: () => Promise.resolve([]),
    clearCookies: () => Promise.resolve(0),
    openUnpooledPage: () => Promise.reject(new Error("fakeBrowser: openUnpooledPage is not available")),
  } as never;
}

function fakeRecipe(run: SocialRecipe["run"]): SocialRecipe {
  return { site: "fake", paramsSchema: SocialSearchQuerySchema, resultSchema: SocialSearchQuerySchema.array() as never, run };
}

function item(kind: SocialItem["kind"], n: number, platform: SocialItem["platform"] = "x"): SocialItem {
  return { id: `${platform}:${n}`, platform, kind, url: `https://example.com/${n}`, text: `item ${n}`, truncated: false, score: n };
}

describe("browser social providers (fake browser and recipe)", () => {
  it("are named, browser-access, and configured exactly when a browser exists", () => {
    const b = fakeBrowser();
    const x = new XProvider({ browser: b });
    expect([x.name, x.access, x.isConfigured()]).toEqual(["x", "browser", true]);
    expect(new XProvider({}).isConfigured()).toBe(false);
    const fb = new FacebookProvider({ browser: b });
    expect([fb.name, fb.access]).toEqual(["facebook", "browser"]);
    const rd = new RedditBrowserProvider({ browser: b });
    expect([rd.name, rd.access]).toEqual(["reddit", "browser"]);
  });

  it("own their platforms' post URLs only", () => {
    const x = new XProvider({});
    const fb = new FacebookProvider({});
    const rd = new RedditBrowserProvider({});
    expect(x.ownsUrl("https://x.com/jack/status/20")).toBe(true);
    expect(x.ownsUrl("https://twitter.com/jack/status/20")).toBe(true);
    expect(x.ownsUrl("https://x.com/jack")).toBe(false);
    expect(fb.ownsUrl("https://www.facebook.com/page/posts/123")).toBe(true);
    expect(fb.ownsUrl("https://m.facebook.com/story.php?story_fbid=1&id=2")).toBe(true);
    expect(fb.ownsUrl("https://fb.com/groups/g/posts/9")).toBe(true);
    expect(fb.ownsUrl("https://www.facebook.com/page")).toBe(false);
    expect(rd.ownsUrl("https://www.reddit.com/r/a/comments/abc/slug/")).toBe(true);
    expect(rd.ownsUrl("https://old.reddit.com/r/a/comments/abc")).toBe(true);
    expect(rd.ownsUrl("https://redd.it/abc")).toBe(true);
    expect(rd.ownsUrl("https://www.reddit.com/r/a/")).toBe(false);
    for (const p of [x, fb, rd]) expect(p.ownsUrl("https://example.com/")).toBe(false);
  });

  it("acquires a page, runs the recipe in search mode under the timeout, surfaces caveats and the meter, cuts at per_platform and releases", async () => {
    const browser = fakeBrowser();
    const seen: { params?: SocialSearchQuery; deadline?: number; meter?: unknown } = {};
    const meter = new CostMeter();
    const provider = new XProvider({
      browser,
      llm: scriptedLlm(() => ({})),
      timeoutMs: 12_345,
      log: makeLogger(),
      recipe: fakeRecipe(async (page, params, ctx) => {
        expect(page).toBe(browser.page);
        seen.params = params;
        seen.deadline = ctx.deadline;
        seen.meter = ctx.meter;
        ctx.caveats?.push("a note");
        return [item("post", 1), item("post", 2), item("post", 3)];
      }),
    });
    const before = Date.now();
    const hooks = { caveats: ["existing"], meter };
    const items = await provider.search({ ...SEARCH_QUERY, per_platform: 2 }, never(), hooks);
    expect(items.map((i) => i.id)).toEqual(["x:1", "x:2"]);
    expect(seen.params).toMatchObject({ mode: "search", query: "claude code", per_platform: 2 });
    expect(seen.deadline! - before).toBeGreaterThanOrEqual(12_345);
    expect(seen.deadline! - before).toBeLessThan(13_500);
    expect(seen.meter).toBe(meter);
    expect(hooks.caveats).toEqual(["existing", "a note"]);
    expect(browser.release).toHaveBeenCalledWith(browser.page);
  });

  it("defaults the budget to 60 seconds", async () => {
    let deadline = 0;
    const provider = new RedditBrowserProvider({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async (_p, _q, ctx) => {
        deadline = ctx.deadline;
        return [];
      }),
    });
    const before = Date.now();
    await provider.search(SEARCH_QUERY, never());
    expect(BROWSER_SOCIAL_DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(deadline - before).toBeGreaterThanOrEqual(60_000);
  });

  it("thread mode passes the URL with kind comments and returns the post first then at most per_platform comments", async () => {
    let params: SocialSearchQuery | undefined;
    const provider = new XProvider({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async (_p, q) => {
        params = q;
        return [item("comment", 1), item("post", 0), item("comment", 2), item("comment", 3)];
      }),
    });
    const items = await provider.thread("https://x.com/jack/status/20", { ...SEARCH_QUERY, per_platform: 2 }, never());
    expect(params).toMatchObject({ mode: "thread", url: "https://x.com/jack/status/20", kind: "comments" });
    expect(items.map((i) => i.id)).toEqual(["x:0", "x:1", "x:2"]);
  });

  it("rejects a URL it does not own and a search without a query with invalid_input, without touching the browser", async () => {
    const browser = fakeBrowser();
    const provider = new XProvider({ browser, recipe: fakeRecipe(async () => []) });
    await expect(provider.thread("https://www.reddit.com/r/a/comments/b", SEARCH_QUERY, never())).rejects.toMatchObject({
      name: "SocialProviderError",
      code: "invalid_input",
      platform: "x",
    });
    await expect(provider.search({ ...SEARCH_QUERY, query: undefined }, never())).rejects.toMatchObject({ code: "invalid_input" });
    expect(browser.acquire).not.toHaveBeenCalled();
  });

  it("without a browser the call is a config error", async () => {
    await expect(new XProvider({}).search(SEARCH_QUERY, never())).rejects.toMatchObject({ code: "config", retryable: false });
  });

  it("Facebook without an LLM fails with config naming ANTHROPIC_API_KEY before any page is opened", async () => {
    const browser = fakeBrowser();
    const provider = new FacebookProvider({ browser, recipe: fakeRecipe(async () => []) });
    const err = await provider.search(SEARCH_QUERY, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect((err as SocialProviderError).code).toBe("config");
    expect((err as SocialProviderError).message).toMatch(/ANTHROPIC_API_KEY/);
    expect(browser.acquire).not.toHaveBeenCalled();
  });

  it("X and Reddit run without an LLM; a recipe that reaches the model then gets a config LlmError, mapped to config", async () => {
    const provider = new XProvider({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async (_p, _q, ctx) => {
        await ctx.llm.complete({ role: "extractor", system: "s", messages: [] });
        return [];
      }),
    });
    await expect(provider.search(SEARCH_QUERY, never())).rejects.toMatchObject({
      name: "SocialProviderError",
      code: "config",
      message: expect.stringMatching(/ANTHROPIC_API_KEY/),
    });
  });

  it("maps RecipeError onto SocialProviderError, carrying code, retryable and needsLogin", async () => {
    const browser = fakeBrowser();
    const run = (err: unknown) =>
      new FacebookProvider({
        browser,
        llm: scriptedLlm(() => ({})),
        recipe: fakeRecipe(async (_p, _q, ctx) => {
          ctx.caveats?.push("before failing");
          throw err;
        }),
      });
    const hooks = { caveats: [] as string[] };
    const login = await run(new RecipeError("blocked", "Facebook requires a logged-in session; run accounts connect facebook", { needsLogin: true }))
      .search(SEARCH_QUERY, never(), hooks)
      .catch((e: unknown) => e as SocialProviderError);
    expect(login).toBeInstanceOf(SocialProviderError);
    expect(login).toMatchObject({ platform: "facebook", code: "blocked", retryable: false, needsLogin: true });
    expect((login as SocialProviderError).message).toMatch(/accounts connect facebook/);
    expect(hooks.caveats).toEqual(["before failing"]);

    const wall = await run(new RecipeError("blocked", "checkpoint")).search(SEARCH_QUERY, never()).catch((e: unknown) => e as SocialProviderError);
    expect(wall).toMatchObject({ code: "blocked", needsLogin: false });
    const slow = await run(new RecipeError("timeout", "slow")).search(SEARCH_QUERY, never()).catch((e: unknown) => e as SocialProviderError);
    expect(slow).toMatchObject({ code: "timeout", retryable: true, needsLogin: false });
    const cfg = await run(new LlmError("config", "not_configured", "no key", { retryable: false }))
      .search(SEARCH_QUERY, never())
      .catch((e: unknown) => e as SocialProviderError);
    expect(cfg).toMatchObject({ code: "config", retryable: false });
    const budget = await run(new LlmError("budget_exceeded", "api", "over budget", { retryable: false }))
      .search(SEARCH_QUERY, never())
      .catch((e: unknown) => e as SocialProviderError);
    expect(budget).toMatchObject({ code: "provider", retryable: false, message: "over budget" });
    const other = await run(new Error("boom")).search(SEARCH_QUERY, never()).catch((e: unknown) => e as SocialProviderError);
    expect(other).toMatchObject({ code: "provider", retryable: false });
    expect((other as SocialProviderError).message).toMatch(/boom/);
    expect(browser.release).toHaveBeenCalledTimes(6);
  });

  it("aborting closes the page and the failure is a timeout; an already-aborted signal never acquires", async () => {
    const browser = fakeBrowser();
    const controller = new AbortController();
    const provider = new RedditBrowserProvider({
      browser,
      recipe: fakeRecipe(
        (_p, _q, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => reject(new Error("Target page, context or browser has been closed")));
          }),
      ),
    });
    const pending = provider.search(SEARCH_QUERY, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(browser.page.close).toHaveBeenCalledTimes(1);
    expect(browser.release).toHaveBeenCalledWith(browser.page);

    const done = new AbortController();
    done.abort();
    await expect(provider.search(SEARCH_QUERY, done.signal)).rejects.toMatchObject({ code: "timeout" });
    expect(browser.acquire).toHaveBeenCalledTimes(1);
  });

  it("a failing acquire is a retryable provider error", async () => {
    const browser = fakeBrowser();
    browser.acquire.mockRejectedValueOnce(new Error("no chromium"));
    await expect(new XProvider({ browser, recipe: fakeRecipe(async () => []) }).search(SEARCH_QUERY, never())).rejects.toMatchObject({
      code: "provider",
      retryable: true,
    });
    expect(browser.release).not.toHaveBeenCalled();
  });

  it("buildBrowserSocialPlatforms wires the three providers with per-platform timeouts", async () => {
    const browser = fakeBrowser();
    const built = buildBrowserSocialPlatforms({ browser, timeoutsMs: { x: 5000 } });
    expect([built.x.name, built.facebook.name, built.redditBrowser.name]).toEqual(["x", "facebook", "reddit"]);
    expect([built.x.access, built.facebook.access, built.redditBrowser.access]).toEqual(["browser", "browser", "browser"]);
    expect([built.x.isConfigured(), built.facebook.isConfigured(), built.redditBrowser.isConfigured()]).toEqual([true, true, true]);
    expect(built.x.ownsUrl("https://x.com/a/status/1")).toBe(true);
    expect(built.redditBrowser.ownsUrl("https://redd.it/abc")).toBe(true);
    // The x provider runs the live recipe: with a page that cannot navigate it fails fast through the mapping, within its own 5 s budget.
    const err = await built.x.search(SEARCH_QUERY, never()).catch((e: unknown) => e as SocialProviderError);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect((err as SocialProviderError).platform).toBe("x");
    expect(browser.release).toHaveBeenCalled();
  });
});
