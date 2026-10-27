import { describe, expect, it } from "vitest";
import { LlmError } from "../../../src/core/llm/types.js";
import {
  createSocialService,
  normalizeSocialInput,
  SocialSearchError,
  type ParsedSocialSearchInput,
} from "../../../src/core/social/index.js";
import { SocialProviderError } from "../../../src/core/social/types.js";
import { SocialSearchInputSchema, SocialSearchOutputSchema } from "../../../src/schemas/social.js";
import { scriptedLlm } from "../research/helpers.js";
import { fakePlatform, forever, item, makeLogger, memoryCache, type FakePlatform } from "./helpers.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");

function input(over: Record<string, unknown> = {}): ParsedSocialSearchInput {
  return SocialSearchInputSchema.parse({ query: "rust async", ...over });
}

function service(platforms: FakePlatform[], over: Partial<Parameters<typeof createSocialService>[0]> = {}) {
  const cache = memoryCache();
  const log = makeLogger();
  const svc = createSocialService({ platforms, cache, log, now: () => NOW, timeoutsMs: { api: 200, browser: 300 }, ...over });
  return { svc, cache, log };
}

describe("normalizeSocialInput", () => {
  const reddit = fakePlatform("reddit", { owns: (u) => u.includes("reddit.com") });
  const hn = fakePlatform("hackernews", { owns: (u) => u.includes("ycombinator") });
  const youtube = fakePlatform("youtube", { configured: false, owns: (u) => u.includes("youtube.com") });
  const x = fakePlatform("x", { access: "browser", configured: false, owns: () => false });

  it("search mode: platforms unset means every configured platform", () => {
    const n = normalizeSocialInput(input(), [reddit, hn, youtube, x]);
    expect(n.query).toEqual({
      mode: "search",
      query: "rust async",
      platforms: ["reddit", "hackernews"],
      kind: "both",
      sort: "engagement",
      max_results: 30,
      per_platform: 15,
    });
    expect(n.toRun.map((p) => p.name)).toEqual(["reddit", "hackernews"]);
    expect(n.failed).toEqual([]);
    expect(n.caveats).toEqual([]);
  });

  it("search mode: an explicitly named unconfigured platform goes to platforms_failed with a hint", () => {
    const n = normalizeSocialInput(input({ platforms: ["hackernews", "youtube", "x", "x"] }), [reddit, hn, youtube, x]);
    expect(n.query.platforms).toEqual(["hackernews", "youtube", "x"]);
    expect(n.toRun.map((p) => p.name)).toEqual(["hackernews"]);
    expect(n.failed.map((f) => [f.platform, f.error, f.needs_login])).toEqual([
      ["youtube", "not configured: set YOUTUBE_API_KEY", false],
      ["x", "not configured: X is read through the browser with a connected account (accounts connect x)", false],
    ]);
  });

  it("search mode: nothing configured is a config error", () => {
    expect(() => normalizeSocialInput(input(), [youtube, x])).toThrow(SocialSearchError);
    try {
      normalizeSocialInput(input({ platforms: ["youtube"] }), [reddit, youtube]);
    } catch (err) {
      expect(err).toMatchObject({ code: "config", retryable: false });
      expect((err as SocialSearchError).platformsFailed).toEqual([{ platform: "youtube", error: "not configured: set YOUTUBE_API_KEY", needs_login: false }]);
    }
  });

  it("thread mode: infers the platform from the URL, forces kind to comments and ignores other platforms with a caveat", () => {
    const url = "https://www.reddit.com/r/rust/comments/1abcd01/x/";
    const n = normalizeSocialInput(input({ query: undefined, url, platforms: ["hackernews", "reddit"], kind: "posts", recency: "week" }), [
      reddit,
      hn,
      youtube,
    ]);
    expect(n.query).toEqual({
      mode: "thread",
      url,
      platforms: ["reddit"],
      kind: "comments",
      recency: "week",
      sort: "engagement",
      max_results: 30,
      per_platform: 15,
    });
    expect(n.toRun).toEqual([reddit]);
    expect(n.caveats).toEqual([
      "platforms (hackernews, reddit) was ignored: the URL belongs to reddit, so only that platform was read.",
      "In url mode kind is always comments: the first item is the post itself, the rest are its comments.",
    ]);
  });

  it("thread mode: no caveats when the input already matches", () => {
    const n = normalizeSocialInput(input({ query: undefined, url: "https://news.ycombinator.com/item?id=1", platforms: ["hackernews"], kind: "comments" }), [reddit, hn]);
    expect(n.caveats).toEqual([]);
    expect(n.query.platforms).toEqual(["hackernews"]);
  });

  it("thread mode: an unknown host is invalid_input, an unconfigured owner is config", () => {
    expect(() => normalizeSocialInput(input({ url: "https://example.org/post/1" }), [reddit, hn])).toThrow(/No supported platform recognises/);
    try {
      normalizeSocialInput(input({ url: "https://www.youtube.com/watch?v=abc" }), [reddit, youtube]);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: "config" });
      expect((err as Error).message).toContain("YOUTUBE_API_KEY");
    }
  });
});

describe("createSocialService: running platforms", () => {
  it("runs the platforms in parallel, merges, dedupes and reports platforms_used in query order", async () => {
    const hn = fakePlatform("hackernews", {
      search: () =>
        Promise.resolve([
          item({ id: "hackernews:1", score: 10, url: "https://a/1" }),
          item({ id: "hackernews:2", score: 90, url: "https://a/2" }),
        ]),
    });
    const reddit = fakePlatform("reddit", {
      search: () => Promise.resolve([item({ id: "reddit:1", platform: "reddit", score: 50, url: "https://a/1" })]),
    });
    const { svc } = service([hn, reddit]);
    const out = await svc.search(input({ max_results: 10 }));
    expect(SocialSearchOutputSchema.safeParse(out).success).toBe(true);
    expect(out.items.map((i) => i.id)).toEqual(["hackernews:2", "hackernews:1"]);
    expect(out.platforms_used).toEqual(["hackernews", "reddit"]);
    expect(out.platforms_failed).toEqual([]);
    expect(out.fetched_at).toBe("2026-10-18T12:00:00.000Z");
    expect(out.caveats).toEqual([]);
    expect(hn.searches[0]?.hooks?.meter).toBeDefined();
    expect(hn.searches[0]?.hooks?.caveats).toBeDefined();
  });

  it("cuts at max_results and collects platform caveats once", async () => {
    const hn = fakePlatform("hackernews", {
      search: (_q, _s, hooks) => {
        hooks?.caveats?.push("same caveat");
        return Promise.resolve([1, 2, 3].map((n) => item({ id: `hackernews:${n}`, score: n, url: `https://a/${n}` })));
      },
    });
    const bs = fakePlatform("bluesky", {
      search: (_q, _s, hooks) => {
        hooks?.caveats?.push("same caveat");
        return Promise.resolve([item({ id: "bluesky:1", platform: "bluesky", score: 100, url: "https://b/1" })]);
      },
    });
    const out = await service([hn, bs]).svc.search(input({ max_results: 2 }));
    expect(out.items.map((i) => i.id)).toEqual(["bluesky:1", "hackernews:3"]);
    expect(out.caveats).toEqual(["same caveat"]);
  });

  it("platforms_failed carries needs_login through from a SocialProviderError and adds the accounts caveat", async () => {
    const x = fakePlatform("x", {
      access: "browser",
      search: () => Promise.reject(new SocialProviderError("X wants a login", { platform: "x", code: "blocked", retryable: false, needsLogin: true })),
    });
    const hn = fakePlatform("hackernews");
    const { svc, log } = service([hn, x]);
    const out = await svc.search(input());
    expect(out.platforms_used).toEqual(["hackernews"]);
    expect(out.platforms_failed).toEqual([{ platform: "x", error: "X wants a login", needs_login: true }]);
    expect(out.caveats).toContain("x needs a logged-in session: connect it with the accounts tool (accounts connect x).");
    expect(log.warn).toHaveBeenCalledWith("social platform failed", expect.objectContaining({ platform: "x", needs_login: true, code: "blocked" }));
  });

  it("a platform that ignores the signal is cut off at its timeout and reported as timed out", async () => {
    const slow = fakePlatform("bluesky", { search: () => forever() });
    const hn = fakePlatform("hackernews");
    const out = await service([hn, slow], { timeoutsMs: { api: 50 } }).svc.search(input());
    expect(out.platforms_used).toEqual(["hackernews"]);
    expect(out.platforms_failed[0]).toMatchObject({ platform: "bluesky", needs_login: false });
    expect(out.platforms_failed[0]?.error).toMatch(/did not answer within 0s|timed out/);
  });

  it("thread mode calls thread() on the owner with the URL and returns the post first", async () => {
    const reddit = fakePlatform("reddit", { owns: (u) => u.includes("reddit.com") });
    const hn = fakePlatform("hackernews", { owns: () => false });
    const url = "https://www.reddit.com/r/rust/comments/1abcd01/x/";
    const out = await service([hn, reddit]).svc.search(input({ query: undefined, url }));
    expect(reddit.threads).toHaveLength(1);
    expect(reddit.threads[0]?.url).toBe(url);
    expect(hn.searches).toHaveLength(0);
    expect(out.query.mode).toBe("thread");
    expect(out.query.kind).toBe("comments");
    expect(out.items[0]?.kind).toBe("post");
  });

  it("drops items a platform returns that fail the item schema, with a caveat, rather than failing the call", async () => {
    const bad = fakePlatform("hackernews", {
      search: () => Promise.resolve([item({ id: "hackernews:ok" }), { ...item({ id: "hackernews:bad" }), url: "not a url" }]),
    });
    const out = await service([bad]).svc.search(input());
    expect(out.items.map((i) => i.id)).toEqual(["hackernews:ok"]);
    expect(out.caveats).toContain("hackernews: 1 item(s) were dropped because they failed validation.");
  });

  it("adds a caveat when nothing was found", async () => {
    const empty = fakePlatform("hackernews", { search: () => Promise.resolve([]) });
    const out = await service([empty]).svc.search(input());
    expect(out.items).toEqual([]);
    expect(out.caveats).toEqual(["No items were found."]);
  });
});

describe("createSocialService: when every platform fails", () => {
  const fail = (platform: "reddit" | "hackernews" | "bluesky", code: SocialProviderError["code"], retryable: boolean, needsLogin = false) =>
    fakePlatform(platform, { search: () => Promise.reject(new SocialProviderError(`${platform} broke`, { platform, code, retryable, needsLogin })) });

  it.each([
    { name: "all timed out", platforms: [fail("reddit", "timeout", true), fail("hackernews", "timeout", true)], code: "timeout", retryable: true },
    { name: "blocked wins", platforms: [fail("reddit", "blocked", false, true), fail("hackernews", "provider", true)], code: "blocked", retryable: false },
    { name: "mixed codes are provider", platforms: [fail("reddit", "timeout", true), fail("hackernews", "provider", false)], code: "provider", retryable: true },
    { name: "a single config failure", platforms: [fail("bluesky", "config", false)], code: "config", retryable: false },
  ])("$name", async ({ platforms, code, retryable }) => {
    const err = await service(platforms)
      .svc.search(input())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialSearchError);
    expect(err).toMatchObject({ code, retryable });
    expect((err as SocialSearchError).platformsFailed).toHaveLength(platforms.length);
  });

  it("an unconfigured platform does not decide the code when a real failure exists", async () => {
    const err = await service([fail("reddit", "timeout", true), fakePlatform("youtube", { configured: false })])
      .svc.search(input({ platforms: ["reddit", "youtube"] }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect((err as SocialSearchError).platformsFailed.map((f) => f.platform)).toEqual(["youtube", "reddit"]);
    expect((err as Error).message).toContain("No social platform answered");
  });

  it("a plain Error from a platform is a non-retryable provider failure without a stack", async () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at secretFunction (/home/owner/x.ts:1:1)";
    const p = fakePlatform("hackernews", { search: () => Promise.reject(err) });
    const got = (await service([p])
      .svc.search(input())
      .catch((e: unknown) => e)) as SocialSearchError;
    expect(got.code).toBe("provider");
    expect(got.message).toBe("hackernews: boom");
    expect(JSON.stringify(got.platformsFailed)).not.toContain("secretFunction");
  });
});

describe("createSocialService: cache", () => {
  it("serves a second identical call from the cache, per platform", async () => {
    const hn = fakePlatform("hackernews");
    const reddit = fakePlatform("reddit");
    const { svc, cache } = service([hn, reddit]);
    const first = await svc.search(input());
    const second = await svc.search(input());
    expect(second.items).toEqual(first.items);
    expect(hn.searches).toHaveLength(1);
    expect(reddit.searches).toHaveLength(1);
    expect(cache.sets).toBe(2);
    // A different per_platform is a different key; max_results is not part of it.
    await svc.search(input({ max_results: 5 }));
    expect(hn.searches).toHaveLength(1);
    await svc.search(input({ per_platform: 3 }));
    expect(hn.searches).toHaveLength(2);
  });

  it("caches only the platforms that succeeded", async () => {
    let calls = 0;
    const flaky = fakePlatform("bluesky", {
      search: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new SocialProviderError("down", { platform: "bluesky", code: "provider", retryable: true }))
          : Promise.resolve([item({ id: "bluesky:1", platform: "bluesky" })]);
      },
    });
    const hn = fakePlatform("hackernews");
    const { svc } = service([hn, flaky]);
    const first = await svc.search(input());
    expect(first.platforms_failed.map((f) => f.platform)).toEqual(["bluesky"]);
    const second = await svc.search(input());
    expect(second.platforms_failed).toEqual([]);
    expect(second.platforms_used).toEqual(["hackernews", "bluesky"]);
    expect(hn.searches).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("does not cache a platform that returned no items, so the next call asks again", async () => {
    const empty = fakePlatform("bluesky", { search: () => Promise.resolve([]) });
    const { svc, cache } = service([empty]);
    await svc.search(input());
    await svc.search(input());
    expect(empty.searches).toHaveLength(2);
    expect(cache.sets).toBe(0);
  });

  it("ignores a cache entry that does not match the item schema", async () => {
    const hn = fakePlatform("hackernews");
    const { svc, cache, log } = service([hn]);
    await svc.search(input());
    for (const key of cache.store.keys()) cache.store.set(key, [{ junk: true }]);
    await svc.search(input());
    expect(hn.searches).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith("social cache entry does not match the item schema, ignoring it", { platform: "hackernews" });
  });
});

describe("createSocialService: summarize", () => {
  const items = [
    item({ id: "hackernews:1", score: 10, url: "https://a/1", text: "Tokio is fine" }),
    item({ id: "hackernews:2", score: 5, url: "https://a/2", text: "smol is simpler", author: "someone" }),
  ];
  const hn = () => fakePlatform("hackernews", { search: () => Promise.resolve(items) });

  it("makes one extractor call with structured output and drops unknown item ids", async () => {
    const llm = scriptedLlm({
      extractor: [
        {
          text: "People like Tokio [hackernews:1] but find smol simpler [hackernews:2].",
          themes: [
            { theme: "runtime choice", sentiment: "mixed", item_ids: ["hackernews:1", "hackernews:2", "hackernews:1", "reddit:invented"] },
            { theme: "nothing real", sentiment: "neutral", item_ids: ["made:up"] },
          ],
        },
      ],
      costPerCall: 0.0123,
    });
    const out = await service([hn()], { llm }).svc.search(input({ summarize: true, max_cost_usd: 0.4 }));
    expect(out.summary).toEqual({
      text: "People like Tokio [hackernews:1] but find smol simpler [hackernews:2].",
      themes: [
        { theme: "runtime choice", sentiment: "mixed", item_ids: ["hackernews:1", "hackernews:2"] },
        { theme: "nothing real", sentiment: "neutral", item_ids: [] },
      ],
      cost_usd: 0.0123,
    });
    const known = new Set(out.items.map((i) => i.id));
    for (const t of out.summary?.themes ?? []) for (const id of t.item_ids) expect(known.has(id)).toBe(true);
    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req?.role).toBe("extractor");
    expect(req?.schema).toBeDefined();
    expect(req?.meter?.maxCostUsd).toBe(0.4);
    const prompt = typeof req?.messages[0]?.content === "string" ? req.messages[0].content : "";
    expect(prompt).toContain("[hackernews:1]");
    expect(prompt).toContain("smol is simpler");
    expect(prompt).toContain('"rust async"');
    expect(out.caveats).toEqual([]);
  });

  it("an LLM failure still returns the items plus a caveat", async () => {
    const llm = scriptedLlm({
      extractor: [],
      failures: () => new LlmError("provider", "api", "Anthropic returned 529 (overloaded) with key sk-ant-secret", { retryable: true }),
    });
    const { svc, log } = service([hn()], { llm, secrets: ["sk-ant-secret"] });
    const out = await svc.search(input({ summarize: true }));
    expect(out.items).toHaveLength(2);
    expect(out.summary).toBeUndefined();
    expect(out.caveats).toEqual(["Summary unavailable (provider): Anthropic returned 529 (overloaded) with key [redacted]"]);
    expect(log.warn).toHaveBeenCalledWith("social summary failed", expect.objectContaining({ code: "provider" }));
  });

  it("an exhausted budget is a caveat too, and the meter is shared with the platforms", async () => {
    const llm = scriptedLlm({ extractor: [{ text: "x", themes: [] }], costPerCall: 0.01 });
    const spender = fakePlatform("hackernews", {
      search: (_q, _s, hooks) => {
        hooks?.meter?.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.5);
        return Promise.resolve(items);
      },
    });
    const out = await service([spender], { llm }).svc.search(input({ summarize: true, max_cost_usd: 0.5 }));
    expect(out.summary).toBeUndefined();
    expect(out.caveats[0]).toMatch(/^Summary unavailable \(budget_exceeded\)/);
    expect(llm.requests).toHaveLength(1);
  });

  it("without an LLM client or without items the summary is skipped with a caveat", async () => {
    const out = await service([hn()]).svc.search(input({ summarize: true }));
    expect(out.summary).toBeUndefined();
    expect(out.caveats).toEqual(["Summary skipped: no LLM client is available (set ANTHROPIC_API_KEY)."]);
    const empty = fakePlatform("hackernews", { search: () => Promise.resolve([]) });
    const llm = scriptedLlm({ extractor: [] });
    const out2 = await service([empty], { llm }).svc.search(input({ summarize: true }));
    expect(out2.caveats).toEqual(["No items were found.", "Summary skipped: there are no items to summarise."]);
    expect(llm.requests).toHaveLength(0);
  });

  it("a model answer that fails the schema is reported as a caveat", async () => {
    const llm = scriptedLlm({
      extractor: [() => ({ text: "", themes: [] })],
      failures: () => new LlmError("provider", "schema", "The extractor model returned output that does not match the expected schema", { retryable: false }),
    });
    const out = await service([hn()], { llm }).svc.search(input({ summarize: true }));
    expect(out.summary).toBeUndefined();
    expect(out.caveats[0]).toContain("does not match the expected schema");
  });
});
