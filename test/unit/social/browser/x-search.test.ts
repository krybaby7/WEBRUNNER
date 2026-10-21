import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecipeError, type RecipeContext } from "../../../../src/core/browser/recipes/types.js";
import {
  buildXSearchUrl,
  createXSearchRecipe,
  isXUrl,
  metricCount,
  parseXPostUrl,
  sinceDate,
  xSearchRecipe,
  type XExtraction,
} from "../../../../src/core/browser/recipes/x-search.js";
import { clipText, parseCount, toIso, safeAuthor } from "../../../../src/core/browser/recipes/social-common.js";
import { createBrowserSession } from "../../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import { CostMeter } from "../../../../src/core/llm/cost.js";
import type { LlmClient } from "../../../../src/core/llm/types.js";
import { SOCIAL_TEXT_MAX_CHARS, SocialItemSchema, type SocialItem, type SocialSearchQuery } from "../../../../src/schemas/social.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../../browser/helpers.js";
import {
  forbiddenLlm,
  makeLogger,
  promptOf,
  scriptedLlm,
  SEARCH_QUERY,
  spyPage,
  startSocialServer,
  threadQuery,
  type SocialServer,
} from "./helpers.js";

const probe = await probeChromium();
const NOW = Date.parse("2026-10-18T12:00:00Z");

describe("X URLs", () => {
  it("builds the search URL with f=top for engagement and f=live for recent", () => {
    expect(buildXSearchUrl(SEARCH_QUERY)).toBe("https://x.com/search?q=claude+code&src=typed_query&f=top");
    expect(buildXSearchUrl({ ...SEARCH_QUERY, sort: "recent" })).toContain("&f=live");
    expect(xSearchRecipe.buildUrl?.(SEARCH_QUERY)).toBe(buildXSearchUrl(SEARCH_QUERY));
  });

  it("appends lang: and since: operators to the query", () => {
    expect(buildXSearchUrl({ ...SEARCH_QUERY, lang: "fr", recency: "week" }, undefined, NOW)).toBe(
      "https://x.com/search?q=claude+code+lang%3Afr+since%3A2026-10-11&src=typed_query&f=top",
    );
    expect(sinceDate("day", NOW)).toBe("2026-10-17");
    expect(sinceDate("year", NOW)).toBe("2025-10-18");
  });

  it("can point at another origin", () => {
    expect(buildXSearchUrl(SEARCH_QUERY, "http://127.0.0.1:9/s/x-ok")).toMatch(/^http:\/\/127\.0\.0\.1:9\/s\/x-ok\/search\?q=/);
  });

  it("recognises post URLs on x.com and twitter.com only", () => {
    expect(parseXPostUrl("https://x.com/devmaria/status/1845000000000000001")).toEqual({
      handle: "devmaria",
      id: "1845000000000000001",
      url: "https://x.com/devmaria/status/1845000000000000001",
    });
    expect(parseXPostUrl("https://twitter.com/devmaria/status/1845000000000000001?s=20")?.url).toBe(
      "https://x.com/devmaria/status/1845000000000000001",
    );
    expect(parseXPostUrl("https://mobile.twitter.com/devmaria/statuses/42")?.id).toBe("42");
    expect(isXUrl("https://x.com/devmaria")).toBe(false);
    expect(isXUrl("https://x.com/search?q=claude")).toBe(false);
    expect(isXUrl("https://example.com/devmaria/status/1")).toBe(false);
    expect(isXUrl("not a url")).toBe(false);
    expect(xSearchRecipe.buildUrl?.(threadQuery("https://twitter.com/devmaria/status/1845000000000000001"))).toBe(
      "https://x.com/devmaria/status/1845000000000000001",
    );
    expect(xSearchRecipe.buildUrl?.(threadQuery("https://x.com/devmaria"))).toBeNull();
  });
});

describe("shared field helpers", () => {
  it("parses counts with separators and K/M/B suffixes", () => {
    expect(parseCount("1,234 Likes. Like")).toBe(1234);
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("3M")).toBe(3_000_000);
    expect(parseCount("2.5B")).toBe(2_500_000_000);
    expect(parseCount("12 points")).toBe(12);
    expect(parseCount("Reply")).toBeUndefined();
    expect(parseCount(null)).toBeUndefined();
    expect(metricCount({ label: "42 Replies. Reply", text: "42" })).toBe(42);
    expect(metricCount({ label: "Repost", text: "" })).toBe(0);
    expect(metricCount({ label: "", text: "1.2K" })).toBe(1200);
    expect(metricCount(null)).toBeUndefined();
  });

  it("normalises times, authors and text", () => {
    expect(toIso("2026-10-17T14:05:00.000Z")).toBe("2026-10-17T14:05:00.000Z");
    expect(toIso("2026-10-15T08:12:33+02:00")).toBe("2026-10-15T06:12:33.000Z");
    expect(toIso("")).toBeUndefined();
    expect(toIso("yesterday")).toBeUndefined();
    expect(safeAuthor(" @jack ")).toBe("@jack");
    expect(safeAuthor("someone@example.com")).toBeUndefined();
    expect(safeAuthor("")).toBeUndefined();
    const long = clipText("x".repeat(SOCIAL_TEXT_MAX_CHARS + 10));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(SOCIAL_TEXT_MAX_CHARS);
    expect(clipText("  a \n\n\n\n b  ")).toEqual({ text: "a\n\n b", truncated: false });
  });
});

describe.skipIf(!probe.available)(`x-search recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: SocialServer;
  let session: BrowserSession;
  let profileDir: string;
  const allForbidden: string[] = [];

  beforeAll(async () => {
    server = await startSocialServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  async function runRecipe(
    scenario: string,
    query: SocialSearchQuery,
    llm: LlmClient = forbiddenLlm(),
    over: Partial<RecipeContext> & { maxResultsWaitMs?: number } = {},
  ) {
    const recipe = createXSearchRecipe({
      baseUrl: server.scenario(scenario),
      pollMs: 50,
      settleMs: 100,
      ...(over.maxResultsWaitMs !== undefined && { maxResultsWaitMs: over.maxResultsWaitMs }),
    });
    const log = makeLogger();
    const caveats: string[] = [];
    const real = await session.acquire();
    const spy = spyPage(real);
    try {
      const { maxResultsWaitMs: _omit, ...ctxOver } = over;
      const ctx: RecipeContext = { llm, log, deadline: Date.now() + 20_000, caveats, ...ctxOver };
      const settled: { items?: SocialItem[]; error?: unknown } = await recipe.run(spy.page, query, ctx).then(
        (items) => ({ items }),
        (error: unknown) => ({ error }),
      );
      allForbidden.push(...spy.forbidden);
      return { ...settled, log, caveats, spy, finalUrl: real.url() };
    } finally {
      await session.release(real);
    }
  }

  it("extracts posts with handle, text, time and metrics from article[data-testid=tweet] markup, without the LLM", async () => {
    const r = await runRecipe("x-ok", SEARCH_QUERY);
    expect(r.error).toBeUndefined();
    const items = r.items!;
    expect(items).toHaveLength(5);
    for (const i of items) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(items[0]).toEqual({
      id: "x:1845000000000000001",
      platform: "x",
      kind: "post",
      url: "https://x.com/devmaria/status/1845000000000000001",
      author: "@devmaria",
      text: "Claude Code refactored our whole test suite in an afternoon. Still checking the diff but this is wild.",
      truncated: false,
      created_at: "2026-10-17T14:05:00.000Z",
      score: 1234,
      replies: 42,
      reposts: 118,
      lang: "en",
    });
    // A button with no number in its label is a zero, "unlike" counts as the like button, big suffixes parse.
    expect(items[1]).toMatchObject({ author: "@tom_builds", reposts: 0, replies: 7, score: 89 });
    expect(items[2]).toMatchObject({ lang: "fr", author: "@lea_writes" });
    expect(items[3]).toMatchObject({ score: 302, replies: 21, reposts: 4 });
    expect(items[4]).toMatchObject({ score: 3_100_000, reposts: 2040, replies: 56 });
    expect(items.every((i) => i.parent_url === undefined)).toBe(true);
    expect(r.caveats).toEqual([]);
  });

  it("cuts at per_platform", async () => {
    const r = await runRecipe("x-ok", { ...SEARCH_QUERY, per_platform: 2 });
    expect(r.items?.map((i) => i.id)).toEqual(["x:1845000000000000001", "x:1845000000000000002"]);
  });

  it("falls back to schema-driven LLM extraction when fewer than 3 posts validate", async () => {
    const meter = new CostMeter();
    const llm = scriptedLlm((req): XExtraction => {
      const prompt = promptOf(req);
      expect(prompt).toContain("[0]\nstatus: /devmaria/status/1845000000000000001");
      expect(prompt).toContain("[2]\n");
      expect(prompt).toContain("Promoted Tools");
      return {
        posts: [
          { item: 0, handle: "devmaria", text: "Claude Code refactored our whole test suite in an afternoon.", created_at: null, replies: 42, reposts: 118, likes: 999 },
          { item: 1, handle: "tom_builds", text: "Hot take: claude code is better at reading a codebase than most onboarding docs.", created_at: null, replies: 7, reposts: null, likes: 89 },
          { item: 2, handle: "promoted_tools", text: "Try the new claude code plugin for your IDE today.", created_at: null, replies: 2, reposts: null, likes: 10 },
        ],
      };
    });
    const r = await runRecipe("x-sparse", SEARCH_QUERY, llm, { meter });
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    expect(req.role).toBe("extractor");
    expect(req.maxTokens).toBe(16_000);
    expect(req.meter).toBe(meter);
    expect(req.signal).toBeDefined();
    expect(req.schema).toBeDefined();
    const items = r.items!;
    expect(items).toHaveLength(3);
    // The deterministic record wins where both exist (exact like count from the DOM, not the model's 999).
    expect(items.find((i) => i.id === "x:1845000000000000001")).toMatchObject({ score: 1234, author: "@devmaria" });
    const promoted = items.find((i) => i.author === "@promoted_tools")!;
    expect(promoted.id).toMatch(/^x:[0-9a-f]{12}$/);
    expect(promoted.url).toBe(`${server.scenario("x-sparse")}/search?q=claude+code&src=typed_query&f=top`);
    expect(promoted.score).toBe(10);
    expect(r.caveats.some((c) => /read by the model/.test(c))).toBe(true);
  });

  it("reports a redirect to the login flow as blocked with needsLogin, naming accounts connect x", async () => {
    const r = await runRecipe("x-login", SEARCH_QUERY);
    expect(r.error).toBeInstanceOf(RecipeError);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.message).toMatch(/accounts connect x/);
    expect(r.finalUrl).toContain("/i/flow/login");
  });

  it("recognises the onboarding redirect (mode=login) seen live as a login wall", async () => {
    const r = await runRecipe("x-onboarding", SEARCH_QUERY);
    expect((r.error as RecipeError).needsLogin).toBe(true);
    expect((r.error as RecipeError).message).toMatch(/accounts connect x/);
  });

  it("maps the empty HTTP 403 seen live to blocked (not a login) with a hint", async () => {
    const r = await runRecipe("x-403", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(false);
    expect(err.message).toMatch(/403/);
    expect(err.message).toMatch(/accounts connect x/);
  });

  it("returns an empty list with a caveat when X says there are no results", async () => {
    const r = await runRecipe("x-empty", SEARCH_QUERY);
    expect(r.items).toEqual([]);
    expect(r.caveats).toEqual(['X showed no posts for "claude code".']);
  });

  it("thread mode returns the post first, then the replies with parent_url, dropping ancestors and Discover more", async () => {
    const url = "https://x.com/devmaria/status/1845000000000000001";
    const r = await runRecipe("x-ok", threadQuery(url));
    expect(r.error).toBeUndefined();
    const items = r.items!;
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["post", "x:1845000000000000001"],
      ["comment", "x:1845000000000000011"],
      ["comment", "x:1845000000000000012"],
      ["comment", "x:1845000000000000013"],
    ]);
    expect(items[0]).toMatchObject({ url, author: "@devmaria", score: 1234, created_at: "2026-10-17T14:05:00.000Z" });
    expect(items[0]!.parent_url).toBeUndefined();
    for (const c of items.slice(1)) {
      expect(c.parent_url).toBe(url);
      expect(c.url).toMatch(/^https:\/\/x\.com\/[a-z_]+\/status\/\d+$/);
    }
    expect(items[2]).toMatchObject({ author: "@lea_writes", replies: 0, reposts: 2, score: 40 });
    expect(items.some((i) => i.author === "@ops_jules" || i.author === "@cloudnina")).toBe(false);
    expect(r.caveats.some((c) => /Discover more/.test(c))).toBe(true);
  });

  it("caps thread comments at per_platform", async () => {
    const r = await runRecipe("x-ok", threadQuery("https://x.com/devmaria/status/1845000000000000001", { per_platform: 1 }));
    expect(r.items?.map((i) => i.kind)).toEqual(["post", "comment"]);
  });

  it("a page that never shows posts is a timeout", async () => {
    const r = await runRecipe("stalled", SEARCH_QUERY, forbiddenLlm(), { maxResultsWaitMs: 1500 });
    const err = r.error as RecipeError;
    expect(err).toBeInstanceOf(RecipeError);
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("a bot wall is blocked without needsLogin", async () => {
    const r = await runRecipe("botwall", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(false);
  });

  it("an aborted signal becomes a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runRecipe("x-ok", SEARCH_QUERY, forbiddenLlm(), { signal: controller.signal });
    expect((r.error as RecipeError).code).toBe("timeout");
  });

  it("the page spy does catch typing, so the assertion below is meaningful", async () => {
    const real = await session.acquire();
    const spy = spyPage(real);
    try {
      await spy.page.goto(`${server.scenario("x-ok")}/i/flow/login`);
      await spy.page.locator('input[name="text"]').fill("someone");
      await spy.page.keyboard.press("Enter");
      await spy.page.getByRole("button", { name: "Next" }).first().press("Tab");
      expect(spy.forbidden).toEqual(["locator.fill", "page.keyboard.press", "first.press"]);
      expect(spy.calls).toContain("page.goto");
    } finally {
      await session.release(real);
    }
  });

  it("never typed into or submitted a page", () => {
    expect(allForbidden).toEqual([]);
  });
});
