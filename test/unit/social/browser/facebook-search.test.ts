import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFacebookSearchUrl,
  canonicalFacebookPostUrl,
  createFacebookSearchRecipe,
  facebookIdFromUrl,
  facebookSearchRecipe,
  isFacebookUrl,
  recentPostsFilter,
  type FacebookSearchExtraction,
  type FacebookThreadExtraction,
} from "../../../../src/core/browser/recipes/facebook-search.js";
import { RecipeError, type RecipeContext } from "../../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import { CostMeter } from "../../../../src/core/llm/cost.js";
import { LlmError, type LlmClient } from "../../../../src/core/llm/types.js";
import { unavailableLlm } from "../../../../src/core/social/platforms/shared-browser.js";
import { SocialItemSchema, type SocialItem, type SocialSearchQuery } from "../../../../src/schemas/social.js";
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
const POST_URL = "https://www.facebook.com/devtoolsdaily/posts/pfbid02ZkAbCdEfGhIjKlMnOpQrStUvWxYz1234567890";

describe("Facebook URLs", () => {
  it("builds the posts search URL and adds the Recent posts filter for sort recent", () => {
    expect(buildFacebookSearchUrl(SEARCH_QUERY)).toBe("https://www.facebook.com/search/posts/?q=claude+code");
    expect(facebookSearchRecipe.buildUrl?.(SEARCH_QUERY)).toBe(buildFacebookSearchUrl(SEARCH_QUERY));
    const recent = new URL(buildFacebookSearchUrl({ ...SEARCH_QUERY, sort: "recent" }));
    expect(recent.searchParams.get("filters")).toBe(recentPostsFilter());
    expect(JSON.parse(Buffer.from(recentPostsFilter(), "base64").toString("utf8"))).toEqual({
      "recent_posts:0": '{"name":"recent_posts","args":""}',
    });
    expect(buildFacebookSearchUrl(SEARCH_QUERY, "http://127.0.0.1:9/s/fb-ok")).toBe("http://127.0.0.1:9/s/fb-ok/search/posts/?q=claude+code");
  });

  it("canonicalises post URLs on facebook.com hosts and drops tracking parameters", () => {
    expect(canonicalFacebookPostUrl("https://m.facebook.com/groups/pythondevs/posts/1122334455667788/?__cft__[0]=abc&__tn__=%2CO")).toBe(
      "https://www.facebook.com/groups/pythondevs/posts/1122334455667788",
    );
    expect(canonicalFacebookPostUrl("https://www.facebook.com/permalink.php?story_fbid=998&id=100&comment_id=5")).toBe(
      "https://www.facebook.com/permalink.php?story_fbid=998&id=100",
    );
    expect(canonicalFacebookPostUrl("https://fb.watch/abc123/")).toBe("https://www.facebook.com/watch/?v=abc123");
    expect(canonicalFacebookPostUrl("https://www.facebook.com/somepage/videos/123456/")).toBe("https://www.facebook.com/somepage/videos/123456");
    expect(isFacebookUrl("https://www.facebook.com/devtoolsdaily")).toBe(false);
    expect(isFacebookUrl("https://www.facebook.com/search/posts/?q=x")).toBe(false);
    expect(isFacebookUrl("https://x.com/a/status/1")).toBe(false);
    expect(isFacebookUrl("nope")).toBe(false);
    expect(facebookSearchRecipe.buildUrl?.(threadQuery("https://www.facebook.com/devtoolsdaily"))).toBeNull();
  });

  it("derives a native id from a permalink", () => {
    expect(facebookIdFromUrl("https://www.facebook.com/groups/pythondevs/posts/1122334455667788")).toBe("1122334455667788");
    expect(facebookIdFromUrl("https://www.facebook.com/permalink.php?story_fbid=9988776655443322&id=100000000000001")).toBe("9988776655443322");
    expect(facebookIdFromUrl(POST_URL)).toBe("02ZkAbCdEfGhIjKlMnOpQrStUvWxYz1234567890");
    expect(facebookIdFromUrl("https://www.facebook.com/watch/?v=777")).toBe("777");
    expect(facebookIdFromUrl("https://www.facebook.com/odd/path")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe.skipIf(!probe.available)(`facebook-search recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
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
    const recipe = createFacebookSearchRecipe({
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

  it("reaches the LLM path with the visible text and canonical permalinks, and validates the result", async () => {
    const meter = new CostMeter();
    const llm = scriptedLlm((req): FacebookSearchExtraction => {
      const prompt = promptOf(req);
      expect(prompt).toContain("[0] https://www.facebook.com/groups/pythondevs/posts/1122334455667788");
      expect(prompt).toContain(`[1] ${POST_URL}`);
      expect(prompt).toContain("[2] https://www.facebook.com/permalink.php?story_fbid=9988776655443322&id=100000000000001");
      expect(prompt).not.toContain("__cft__");
      expect(prompt).toContain("We let Claude Code loose on our billing module");
      expect(prompt).not.toContain("People also search for");
      const post = (author: string, text: string, permalink: number | null, likes: number, comments: number, shares: number | null, community: string | null = null) => ({
        author, community, text, created_at: null, likes, comments, shares, permalink,
      });
      return {
        posts: [
          post("Ana Ribeiro", "We let Claude Code loose on our billing module for a day. It found two real bugs and introduced one new one.", 0, 143, 37, 12, "Python Developers"),
          post("Dev Tools Daily", "Claude Code vs. Cursor vs. Copilot: we ran the same 20 tickets through each.", 1, 2100, 310, 88),
          post("Marcus L.", "Finally got claude code working with our monorepo. The trick was a CLAUDE.md per package.", 2, 18, 4, null),
          post("Startup Stories", "Is claude code worth $200 a month for a two-person team?", null, 56, 71, 3),
        ],
      };
    });
    const r = await runRecipe("fb-ok", SEARCH_QUERY, llm, { meter });
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    expect(req.role).toBe("extractor");
    expect(req.maxTokens).toBe(16_000);
    expect(req.meter).toBe(meter);
    expect(req.schema).toBeDefined();
    expect(req.system).toMatch(/never use outside knowledge/i);

    const items = r.items!;
    expect(items).toHaveLength(4);
    for (const i of items) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(items[0]).toEqual({
      id: "facebook:1122334455667788",
      platform: "facebook",
      kind: "post",
      url: "https://www.facebook.com/groups/pythondevs/posts/1122334455667788",
      author: "Ana Ribeiro",
      community: "Python Developers",
      text: "We let Claude Code loose on our billing module for a day. It found two real bugs and introduced one new one.",
      truncated: false,
      score: 143,
      replies: 37,
      reposts: 12,
    });
    expect(items[1]).toMatchObject({ id: "facebook:02ZkAbCdEfGhIjKlMnOpQrStUvWxYz1234567890", url: POST_URL, score: 2100 });
    expect(items[2]).toMatchObject({ id: "facebook:9988776655443322", author: "Marcus L." });
    expect(items[2]!.reposts).toBeUndefined();
    // No permalink: the search URL stands in and a caveat says so.
    expect(items[3]!.url).toBe(`${server.scenario("fb-ok")}/search/posts/?q=claude+code`);
    expect(items[3]!.id).toMatch(/^facebook:[0-9a-f]{12}$/);
    expect(r.caveats).toContain("Some Facebook posts had no permalink on the results page; their url is the search page.");
  });

  it("caveats the recency filter and cuts at per_platform", async () => {
    const llm = scriptedLlm((): FacebookSearchExtraction => ({
      posts: [0, 1, 2].map((n) => ({ author: `A${n}`, community: null, text: `post ${n}`, created_at: null, likes: null, comments: null, shares: null, permalink: n })),
    }));
    const r = await runRecipe("fb-ok", { ...SEARCH_QUERY, per_platform: 2, recency: "week" }, llm);
    expect(r.items).toHaveLength(2);
    expect(r.caveats.some((c) => /recency filter was not applied/.test(c))).toBe(true);
  });

  it("the login page (live capture) is blocked with needsLogin, naming accounts connect facebook", async () => {
    const r = await runRecipe("fb-login", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err).toBeInstanceOf(RecipeError);
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.message).toMatch(/accounts connect facebook/);
    expect(r.finalUrl).toContain("/login/");
  });

  it("the HTTP 404 Facebook gives anonymous search (seen live) is needsLogin", async () => {
    const r = await runRecipe("fb-404", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(true);
    expect(err.message).toMatch(/404/);
    expect(err.message).toMatch(/accounts connect facebook/);
  });

  it("a checkpoint is blocked without needsLogin", async () => {
    const r = await runRecipe("fb-checkpoint", SEARCH_QUERY);
    const err = r.error as RecipeError;
    expect(err.code).toBe("blocked");
    expect(err.needsLogin).toBe(false);
    expect(err.message).toMatch(/checkpoint/);
  });

  it("thread mode expands more comments (a click only) and returns the post then comments with parent_url", async () => {
    const llm = scriptedLlm((req): FacebookThreadExtraction => {
      const prompt = promptOf(req);
      expect(prompt).toContain(`Post page: ${POST_URL}`);
      // Revealed only by the "View more comments" click.
      expect(prompt).toContain("Omar S.");
      expect(prompt).toContain("Author here: 11 of the 14 were merged");
      const c = (author: string, text: string, likes: number, replies: number | null) => ({ author, text, created_at: null, likes, replies });
      return {
        post: { author: "Dev Tools Daily", community: null, text: "Claude Code vs. Cursor vs. Copilot: we ran the same 20 tickets through each. Claude Code closed 14, Cursor 11, Copilot 9.", created_at: null, likes: 2100, comments: 310, shares: 88 },
        comments: [
          c("Priya N.", "Which model did Cursor use? That matters a lot for a fair comparison.", 45, 3),
          c("Jonas K.", "Closed is not the same as merged. How many of the 14 passed review?", 120, 8),
          c("Dev Tools Daily", "Author here: 11 of the 14 were merged after review, the other three needed rework.", 230, 2),
          c("Omar S.", "Would love to see the ticket list, otherwise this is marketing.", 17, null),
        ],
      };
    });
    const r = await runRecipe("fb-ok", threadQuery(POST_URL), llm);
    expect(r.error).toBeUndefined();
    const items = r.items!;
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ kind: "post", id: "facebook:02ZkAbCdEfGhIjKlMnOpQrStUvWxYz1234567890", url: POST_URL, author: "Dev Tools Daily", score: 2100, replies: 310, reposts: 88 });
    expect(items[0]!.parent_url).toBeUndefined();
    for (const c of items.slice(1)) expect(c).toMatchObject({ kind: "comment", parent_url: POST_URL, url: POST_URL });
    expect(items[3]).toMatchObject({ author: "Dev Tools Daily", score: 230, replies: 2 });
    expect(new Set(items.map((i) => i.id)).size).toBe(5);
    expect(r.spy.calls.some((c) => /\.click$/.test(c))).toBe(true);
  });

  it("without an LLM the extraction path fails with code config naming ANTHROPIC_API_KEY", async () => {
    const r = await runRecipe("fb-ok", SEARCH_QUERY, unavailableLlm("Facebook"));
    expect(r.error).toBeInstanceOf(LlmError);
    expect((r.error as LlmError).code).toBe("config");
    expect((r.error as LlmError).message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("a page that never shows content is a timeout; a bot wall is blocked", async () => {
    const stalled = await runRecipe("stalled", SEARCH_QUERY, forbiddenLlm(), { maxResultsWaitMs: 1500 });
    expect((stalled.error as RecipeError).code).toBe("timeout");
    const wall = await runRecipe("botwall", SEARCH_QUERY);
    expect((wall.error as RecipeError).code).toBe("blocked");
    expect((wall.error as RecipeError).needsLogin).toBe(false);
  });

  it("never typed into or submitted a page", () => {
    expect(allForbidden).toEqual([]);
  });
});
