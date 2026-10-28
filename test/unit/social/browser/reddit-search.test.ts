import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildNewRedditSearchUrl,
  buildOldRedditSearchUrl,
  buildOldRedditThreadUrl,
  createRedditSearchRecipe,
  isRedditUrl,
  parseRedditThreadUrl,
  redditSearchRecipe,
  scoreOf,
  subredditName,
} from "../../../../src/core/browser/recipes/reddit-search.js";
import { RecipeError, type RecipeContext } from "../../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import type { LlmClient } from "../../../../src/core/llm/types.js";
import { SocialItemSchema, type SocialItem, type SocialSearchQuery } from "../../../../src/schemas/social.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../../browser/helpers.js";
import { forbiddenLlm, makeLogger, SEARCH_QUERY, spyPage, startSocialServer, threadQuery, type SocialServer } from "./helpers.js";

const probe = await probeChromium();
const THREAD_PATH = "/r/ClaudeAI/comments/1g7abcd/claude_code_rewrote_my_entire_test_suite_in_an";
const THREAD_URL = `https://www.reddit.com${THREAD_PATH}/`;
const CANONICAL = `https://www.reddit.com${THREAD_PATH}`;

describe("old.reddit URLs", () => {
  it("builds the search URL with sort=relevance whatever the sort (the merge orders), time and restrict_sr", () => {
    expect(buildOldRedditSearchUrl(SEARCH_QUERY)).toBe("https://old.reddit.com/search?q=claude+code&sort=relevance&t=all&restrict_sr=on");
    expect(buildOldRedditSearchUrl({ ...SEARCH_QUERY, sort: "recent", recency: "week" })).toBe(
      "https://old.reddit.com/search?q=claude+code&sort=relevance&t=week&restrict_sr=on",
    );
    expect(buildOldRedditSearchUrl({ ...SEARCH_QUERY, subreddits: ["ClaudeAI", "r/programming"] })).toBe(
      "https://old.reddit.com/r/ClaudeAI+programming/search?q=claude+code&sort=relevance&t=all&restrict_sr=on",
    );
    // The first page the recipe opens: www.reddit.com's search, or old.reddit's for several subreddits.
    expect(redditSearchRecipe.buildUrl?.(SEARCH_QUERY)).toBe(buildNewRedditSearchUrl(SEARCH_QUERY));
    const several = { ...SEARCH_QUERY, subreddits: ["ClaudeAI", "programming"] };
    expect(redditSearchRecipe.buildUrl?.(several)).toBe(buildOldRedditSearchUrl(several));
    expect(buildOldRedditSearchUrl(SEARCH_QUERY, "http://127.0.0.1:9/s/rd-ok")).toMatch(/^http:\/\/127\.0\.0\.1:9\/s\/rd-ok\/search\?q=/);
  });

  it("builds www.reddit.com's search URL for posts, for all of Reddit or one subreddit, and none for several (WP43)", () => {
    expect(buildNewRedditSearchUrl({ ...SEARCH_QUERY, recency: "year" })).toBe("https://www.reddit.com/search/?q=claude+code&type=posts&sort=relevance&t=year");
    expect(buildNewRedditSearchUrl({ ...SEARCH_QUERY, sort: "recent" })).toBe("https://www.reddit.com/search/?q=claude+code&type=posts&sort=relevance&t=all");
    expect(buildNewRedditSearchUrl({ ...SEARCH_QUERY, subreddits: ["r/ClaudeAI"] })).toBe(
      "https://www.reddit.com/r/ClaudeAI/search/?q=claude+code&type=posts&sort=relevance&t=all&restrict_sr=1",
    );
    expect(buildNewRedditSearchUrl({ ...SEARCH_QUERY, subreddits: ["ClaudeAI", "programming"] })).toBeUndefined();
    expect(buildNewRedditSearchUrl(SEARCH_QUERY, "http://127.0.0.1:9/s/rd-new")).toMatch(/^http:\/\/127\.0\.0\.1:9\/s\/rd-new\/search\/\?q=/);
  });

  it("parses thread URLs on every reddit host and redd.it, rewriting to old.reddit for loading", () => {
    expect(parseRedditThreadUrl(THREAD_URL)).toEqual({ id: "1g7abcd", path: THREAD_PATH, canonicalUrl: CANONICAL });
    expect(parseRedditThreadUrl(`https://old.reddit.com${THREAD_PATH}/lx1aaaa/?context=3`)?.canonicalUrl).toBe(CANONICAL);
    expect(parseRedditThreadUrl("https://np.reddit.com/r/programming/comments/1g6zzzz")?.id).toBe("1g6zzzz");
    expect(parseRedditThreadUrl("https://redd.it/1g7abcd")).toEqual({
      id: "1g7abcd",
      path: "/comments/1g7abcd",
      canonicalUrl: "https://www.reddit.com/comments/1g7abcd",
    });
    expect(isRedditUrl("https://www.reddit.com/r/ClaudeAI/")).toBe(false);
    expect(isRedditUrl("https://www.reddit.com/search?q=x")).toBe(false);
    expect(isRedditUrl("https://example.com/r/a/comments/1")).toBe(false);
    expect(isRedditUrl("nope")).toBe(false);
    expect(redditSearchRecipe.buildUrl?.(threadQuery(THREAD_URL, { per_platform: 7 }))).toBe(
      `https://old.reddit.com${THREAD_PATH}/?limit=7&depth=1&sort=top`,
    );
    expect(buildOldRedditThreadUrl(parseRedditThreadUrl("https://redd.it/abc")!, 5, "http://127.0.0.1:9/s/rd-ok")).toBe(
      "http://127.0.0.1:9/s/rd-ok/comments/abc/?limit=5&depth=1&sort=top",
    );
  });

  it("reads scores and subreddit names", () => {
    expect(scoreOf("1842", "1.8k")).toBe(1842);
    expect(scoreOf("", "203 points")).toBe(203);
    expect(scoreOf("", "[score hidden]")).toBeUndefined();
    expect(subredditName("r/ClaudeAI")).toBe("ClaudeAI");
    expect(subredditName("")).toBeUndefined();
  });
});

describe.skipIf(!probe.available)(`reddit-search recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
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
    over: Partial<RecipeContext> & { maxResultsWaitMs?: number; emptyRetryDelaysMs?: number[]; newRedditFirst?: boolean } = {},
  ) {
    const recipe = createRedditSearchRecipe({
      baseUrl: server.scenario(scenario),
      pollMs: 50,
      settleMs: 100,
      emptyRetryDelaysMs: over.emptyRetryDelaysMs ?? [20],
      // Most scenarios stand in for old.reddit alone; the WP43 tests turn www.reddit.com's search on.
      newRedditFirst: over.newRedditFirst ?? false,
      ...(over.maxResultsWaitMs !== undefined && { maxResultsWaitMs: over.maxResultsWaitMs }),
    });
    const log = makeLogger();
    const caveats: string[] = [];
    const real = await session.acquire();
    const spy = spyPage(real);
    const before = server.requests.length;
    try {
      const { maxResultsWaitMs: _omit, emptyRetryDelaysMs: _omitToo, newRedditFirst: _omitThree, ...ctxOver } = over;
      const ctx: RecipeContext = { llm, log, deadline: Date.now() + 20_000, caveats, ...ctxOver };
      const settled: { items?: SocialItem[]; error?: unknown } = await recipe.run(spy.page, query, ctx).then(
        (items) => ({ items }),
        (error: unknown) => ({ error }),
      );
      allForbidden.push(...spy.forbidden);
      return { ...settled, log, caveats, spy, finalUrl: real.url(), requests: server.requests.slice(before) };
    } finally {
      await session.release(real);
    }
  }

  it("parses search results deterministically (no LLM): title, score, comments, subreddit, time, author", async () => {
    const r = await runRecipe("rd-ok", { ...SEARCH_QUERY, kind: "posts" });
    expect(r.error).toBeUndefined();
    const items = r.items!;
    expect(items).toHaveLength(5);
    for (const i of items) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(items[0]).toEqual({
      id: "reddit:1g7abcd",
      platform: "reddit",
      kind: "post",
      url: CANONICAL,
      author: "throwaway_dev_42",
      title: "Claude Code rewrote my entire test suite in an afternoon",
      text: "Posted the diff in the comments. It kept every fixture but renamed half the helper functions, which I did not love.",
      truncated: false,
      created_at: "2026-10-15T08:12:33.000Z",
      score: 1842,
      replies: 312,
      community: "ClaudeAI",
    });
    expect(items[1]).toMatchObject({ id: "reddit:1g6zzzz", community: "programming", score: 957, replies: 488, text: "" });
    expect(items[4]).toMatchObject({ author: "first_year_cs", score: 12, replies: 9 });
    expect(r.requests).toEqual(["GET /s/rd-ok/search?q=claude+code&sort=relevance&t=all&restrict_sr=on"]);
    expect(r.caveats).toEqual([]);
  });

  it("searches within subreddits and cuts at per_platform", async () => {
    const r = await runRecipe("rd-ok", { ...SEARCH_QUERY, kind: "posts", per_platform: 2, subreddits: ["ClaudeAI", "programming"] });
    expect(r.items?.map((i) => i.id)).toEqual(["reddit:1g7abcd", "reddit:1g6zzzz"]);
    expect(r.requests[0]).toBe("GET /s/rd-ok/r/ClaudeAI+programming/search?q=claude+code&sort=relevance&t=all&restrict_sr=on");
  });

  it("kind both opens the top posts for their top-level comments and splits the per_platform budget", async () => {
    const r = await runRecipe("rd-ok", { ...SEARCH_QUERY, kind: "both", per_platform: 6 });
    expect(r.error).toBeUndefined();
    const items = r.items!;
    expect(items.filter((i) => i.kind === "post")).toHaveLength(3);
    const comments = items.filter((i) => i.kind === "comment");
    expect(comments).toHaveLength(3);
    for (const c of comments) {
      expect(c.parent_url).toMatch(/^https:\/\/www\.reddit\.com\/r\/ClaudeAI\/comments\/1g7abcd\//);
      expect(c.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/ClaudeAI\/comments\/1g7abcd\/.*\/lx1[a-z]+$/);
    }
    // Thread pages are loaded on old.reddit with limit, depth 1 and sort top; the top post (by score) first.
    const threadLoads = r.requests.filter((x) => /\/comments\//.test(x));
    expect(threadLoads[0]).toBe(`GET /s/rd-ok${THREAD_PATH}/?limit=3&depth=1&sort=top`);
    expect(threadLoads.length).toBeLessThanOrEqual(5);
  });

  it("kind comments returns only comments", async () => {
    const r = await runRecipe("rd-ok", { ...SEARCH_QUERY, kind: "comments", per_platform: 4 });
    expect(r.items!.length).toBeGreaterThan(0);
    expect(r.items!.every((i) => i.kind === "comment")).toBe(true);
    expect(r.items!.length).toBeLessThanOrEqual(4);
  });

  it("thread mode rewrites to old.reddit and returns the post then top-level comments (deleted and nested skipped)", async () => {
    const r = await runRecipe("rd-ok", threadQuery(THREAD_URL, { per_platform: 10 }));
    expect(r.error).toBeUndefined();
    const items = r.items!;
    expect(r.requests).toEqual([`GET /s/rd-ok${THREAD_PATH}/?limit=10&depth=1&sort=top`]);
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["post", "reddit:1g7abcd"],
      ["comment", "reddit:lx1aaaa"],
      ["comment", "reddit:lx1cccc"],
      ["comment", "reddit:lx1eeee"],
    ]);
    expect(items[0]).toMatchObject({
      url: CANONICAL,
      title: "Claude Code rewrote my entire test suite in an afternoon",
      author: "throwaway_dev_42",
      score: 1842,
      replies: 312,
      community: "ClaudeAI",
      created_at: "2026-10-15T08:12:33.000Z",
    });
    expect(items[0]!.text).toContain("Net result: 40 fewer flaky tests.");
    expect(items[1]).toEqual({
      id: "reddit:lx1aaaa",
      platform: "reddit",
      kind: "comment",
      url: `${CANONICAL}/lx1aaaa`,
      author: "pytest_enjoyer",
      text: "Renaming helpers is the tell. It optimises for its own readability, not yours. Did you ask it to keep names?",
      truncated: false,
      created_at: "2026-10-15T09:01:10.000Z",
      score: 420,
      replies: 14,
      community: "ClaudeAI",
      parent_url: CANONICAL,
    });
    expect(items[2]).toMatchObject({ score: 203, replies: 3 });
    // Hidden score stays absent; "(0 children)" is zero replies.
    expect(items[3]!.score).toBeUndefined();
    expect(items[3]).toMatchObject({ replies: 0, author: "skeptical_sre" });
  });

  it("passes the over-18 interstitial by clicking yes (the only control it touches) and says so", async () => {
    const r = await runRecipe("rd-over18", { ...SEARCH_QUERY, kind: "posts" });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(5);
    expect(r.caveats).toEqual(["Reddit showed an over-18 interstitial, which was accepted to read the page."]);
    expect(r.requests.some((x) => x.startsWith("POST /s/rd-over18/over18?dest="))).toBe(true);
    expect(r.finalUrl).toContain("/s/rd-ok/search");
  });

  it("a /login redirect that renders a login form is needsLogin, naming accounts connect reddit", async () => {
    const r = await runRecipe("rd-login", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err).toBeInstanceOf(RecipeError);
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.message).toMatch(/accounts connect reddit/);
  });

  it("the network-security block seen live is blocked without needsLogin", async () => {
    const r = await runRecipe("rd-netsec", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(false);
  });

  it("reads the live 2026-10-28 page for the query that came back empty (WP39)", async () => {
    const r = await runRecipe("rd-live", { ...SEARCH_QUERY, query: "best budget robot vacuum 2026", recency: "year", kind: "posts" });
    expect(r.error).toBeUndefined();
    expect(r.requests).toEqual(["GET /s/rd-live/search?q=best+budget+robot+vacuum+2026&sort=relevance&t=year&restrict_sr=on"]);
    const items = r.items!;
    expect(items).toHaveLength(15);
    for (const i of items) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(items[0]).toEqual({
      id: "reddit:1v1qxda",
      platform: "reddit",
      kind: "post",
      url: "https://www.reddit.com/r/BuyItForLife/comments/1v1qxda/best_budget_robot_vacuum_in_2026_that_people",
      author: "redditor_01",
      title: "Best budget robot vacuum in 2026 that people actually recommend?",
      text: "A budget robot vacuum doesn't have to clean perfectly to be worth buying. If it can keep up with daily dust, pet hair, and crumbs while saving you from dragging out the vacuum every few days, it'll ...",
      truncated: false,
      created_at: "2026-07-20T16:49:07.000Z",
      score: 56,
      replies: 50,
      community: "BuyItForLife",
    });
    // Relevance, unlike sort=top, lists posts about the query: all but one title names a vacuum or robot.
    expect(items.filter((i) => /vacuum|robot/i.test(i.title ?? "")).length).toBe(14);
    expect(items[5]).toMatchObject({ id: "reddit:1u4u434", score: 0, replies: 20 });
    expect(items[6]).toMatchObject({ replies: 1, community: "BestOfPrimeDay" });
    expect(r.caveats).toEqual([]);
  });

  it("loads an empty search page again, as live, and reads the posts the reload shows", async () => {
    const r = await runRecipe("rd-flaky", { ...SEARCH_QUERY, query: "best budget robot vacuum 2026", recency: "year", kind: "posts" });
    expect(r.error).toBeUndefined();
    const url = "GET /s/rd-flaky/search?q=best+budget+robot+vacuum+2026&sort=relevance&t=year&restrict_sr=on";
    expect(r.requests).toEqual([url, url]);
    expect(r.items).toHaveLength(15);
    expect(r.items![0]!.id).toBe("reddit:1v1qxda");
    expect(r.caveats).toEqual([]);
  });

  it("reads www.reddit.com's search first, scrolling for more, and never opens old.reddit when it has posts (live layout, WP43)", async () => {
    const q = { ...SEARCH_QUERY, query: "claude code vs cursor", recency: "year" as const, kind: "posts" as const, per_platform: 10 };
    const r = await runRecipe("rd-new", q, forbiddenLlm(), { newRedditFirst: true });
    expect(r.error).toBeUndefined();
    expect(r.requests).toEqual(["GET /s/rd-new/search/?q=claude+code+vs+cursor&type=posts&sort=relevance&t=year"]);
    expect(r.caveats).toEqual([]);
    const items = r.items!;
    // Four on the page, two more after one scroll.
    expect(items).toHaveLength(6);
    for (const i of items) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(items[0]).toEqual({
      id: "reddit:1sgvqx8",
      platform: "reddit",
      kind: "post",
      url: "https://www.reddit.com/r/vibecoding/comments/1sgvqx8/confused_about_claude_and_cursor",
      title: "Confused about Claude and Cursor",
      text: "Cursor is an editor that can use Claude's models; Claude Code is an agent that runs in your terminal.",
      truncated: false,
      created_at: "2026-04-09T17:10:47.965Z",
      score: 4,
      replies: 5,
      community: "vibecoding",
    });
    // The exact count from faceplate-number, not the "1.2K" shown.
    expect(items[2]).toMatchObject({ id: "reddit:1qwe7rt", score: 1234, replies: 310 });
    expect(items[3]).toMatchObject({ id: "reddit:1rty5uv", community: "claude" });
    expect(items.map((i) => i.id).slice(4)).toEqual(["reddit:1abc1de", "reddit:1fgh2ij"]);
  });

  it("searches one subreddit on www.reddit.com, and several on old.reddit, which www.reddit.com cannot do", async () => {
    const one = await runRecipe("rd-new", { ...SEARCH_QUERY, subreddits: ["vibecoding"], kind: "posts", per_platform: 4 }, forbiddenLlm(), { newRedditFirst: true });
    expect(one.error).toBeUndefined();
    expect(one.requests).toEqual(["GET /s/rd-new/r/vibecoding/search/?q=claude+code&type=posts&sort=relevance&t=all&restrict_sr=1"]);
    expect(one.items).toHaveLength(4);

    const several = await runRecipe("rd-ok", { ...SEARCH_QUERY, subreddits: ["ClaudeAI", "programming"], kind: "posts" }, forbiddenLlm(), { newRedditFirst: true });
    expect(several.error).toBeUndefined();
    expect(several.requests).toEqual(["GET /s/rd-ok/r/ClaudeAI+programming/search?q=claude+code&sort=relevance&t=all&restrict_sr=on"]);
    expect(several.items!.length).toBeGreaterThan(0);
    expect(several.caveats).toEqual([]);
  });

  it("kind both reads www.reddit.com's posts and their comments on old.reddit", async () => {
    const r = await runRecipe("rd-new", { ...SEARCH_QUERY, query: "claude code vs cursor", per_platform: 6 }, forbiddenLlm(), { newRedditFirst: true });
    expect(r.error).toBeUndefined();
    expect(r.items!.filter((i) => i.kind === "post")).toHaveLength(3);
    expect(r.items!.some((i) => i.kind === "comment")).toBe(true);
    expect(r.requests.some((x) => /^GET \/s\/rd-new\/r\/vibecoding\/comments\/1qwe7rt\/.*\?limit=/.test(x))).toBe(true);
  });

  it("falls back to old.reddit when www.reddit.com finds nothing, and says why", async () => {
    const r = await runRecipe("rd-old-only", { ...SEARCH_QUERY, query: "best budget robot vacuum 2026", recency: "year", kind: "posts" }, forbiddenLlm(), {
      newRedditFirst: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.requests).toEqual([
      "GET /s/rd-old-only/search/?q=best+budget+robot+vacuum+2026&type=posts&sort=relevance&t=year",
      "GET /s/rd-old-only/search?q=best+budget+robot+vacuum+2026&sort=relevance&t=year&restrict_sr=on",
    ]);
    expect(r.items).toHaveLength(15);
    expect(r.items![0]!.id).toBe("reddit:1v1qxda");
    expect(r.caveats).toEqual(["These Reddit posts come from old.reddit.com's search: www.reddit.com's search found nothing."]);
  });

  it("falls back to old.reddit when www.reddit.com blocks the browser", async () => {
    const r = await runRecipe("rd-new-blocked", { ...SEARCH_QUERY, query: "best budget robot vacuum 2026", recency: "year", kind: "posts" }, forbiddenLlm(), {
      newRedditFirst: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(15);
    expect(r.caveats).toHaveLength(1);
    expect(r.caveats[0]).toBe(
      "These Reddit posts come from old.reddit.com's search: www.reddit.com's search could not be read (Reddit (www.reddit.com) answered HTTP 403; it is blocking this browser or network).",
    );
  });

  it("returns an empty list when www.reddit.com finds nothing and old.reddit stays empty after a reload", async () => {
    const r = await runRecipe("rd-empty", SEARCH_QUERY, forbiddenLlm(), { newRedditFirst: true });
    expect(r.items).toEqual([]);
    expect(r.requests).toEqual([
      "GET /s/rd-empty/search/?q=claude+code&type=posts&sort=relevance&t=all",
      "GET /s/rd-empty/search?q=claude+code&sort=relevance&t=all&restrict_sr=on",
      "GET /s/rd-empty/search?q=claude+code&sort=relevance&t=all&restrict_sr=on",
    ]);
    expect(r.caveats).toEqual([`Reddit showed no posts for "claude code" (www.reddit.com's search found nothing; old.reddit.com's search was loaded 2 times).`]);
  });

  it("goes straight to old.reddit, without a reload, when too little time is left", async () => {
    const r = await runRecipe("rd-empty", SEARCH_QUERY, forbiddenLlm(), { deadline: Date.now() + 4000, emptyRetryDelaysMs: [2000], newRedditFirst: true });
    expect(r.items).toEqual([]);
    expect(r.requests).toEqual(["GET /s/rd-empty/search?q=claude+code&sort=relevance&t=all&restrict_sr=on"]);
    expect(r.caveats).toEqual([`Reddit showed no posts for "claude code" (old.reddit.com's search was loaded 1 time).`]);
  });

  it("a stalled page is a timeout, a bot wall is blocked, a 500 is a retryable provider error", async () => {
    expect(((await runRecipe("stalled", SEARCH_QUERY, forbiddenLlm(), { maxResultsWaitMs: 1500 })).error as RecipeError).code).toBe("timeout");
    const wall = (await runRecipe("botwall", SEARCH_QUERY)).error as RecipeError;
    expect(wall.code).toBe("blocked");
    expect(wall.needsLogin).toBe(false);
    const five = (await runRecipe("status-500", SEARCH_QUERY)).error as RecipeError;
    expect(five.code).toBe("provider");
    expect(five.retryable).toBe(true);
  });

  it("never typed into or submitted a page", () => {
    expect(allForbidden).toEqual([]);
  });
});
