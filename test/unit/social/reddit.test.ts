import { describe, expect, it } from "vitest";
import { SocialHttpError } from "../../../src/core/social/http.js";
import { RedditProvider, redditPostId } from "../../../src/core/social/platforms/reddit.js";
import { SocialProviderError, type SocialPlatformProvider } from "../../../src/core/social/types.js";
import { SocialItemSchema } from "../../../src/schemas/social.js";
import { fakeFetch, fakePlatform, item, jsonResponse, loadFixture, query, redditThreadFixture, signal, type RecordedCall } from "./helpers.js";

/** Fixtures built from the documented shapes (see the `_note` in each file). */
const search = loadFixture("reddit-search");
const thread = redditThreadFixture();
const token = loadFixture("reddit-token");

const CLIENT_ID = "client-id-abcdef";
const CLIENT_SECRET = "client-secret-0123456789";
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
const POST_URL = "https://www.reddit.com/r/rust/comments/1abcd01/which_async_runtime_should_a_new_rust_service_use/";

let nowMs = Date.parse("2026-10-18T12:00:00Z");

function routed(override?: (call: RecordedCall, url: URL) => Response | undefined): ReturnType<typeof fakeFetch> {
  return fakeFetch((call, url) => {
    const o = override?.(call, url);
    if (o !== undefined) return o;
    if (url.pathname === "/api/v1/access_token") return jsonResponse(token);
    if (/^\/comments\//.test(url.pathname)) return jsonResponse(thread);
    if (/\/search(\.json)?$/.test(url.pathname)) return jsonResponse(search);
    return jsonResponse({ error: "unknown" }, 404);
  });
}

interface MakeOptions {
  keys?: boolean;
  fallback?: SocialPlatformProvider;
  userAgent?: string;
}

function make(f: ReturnType<typeof fakeFetch>, opts: MakeOptions = {}): RedditProvider {
  return new RedditProvider({
    ...(opts.keys === true && { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    ...(opts.userAgent !== undefined && { userAgent: opts.userAgent }),
    ...(opts.fallback !== undefined && { fallback: opts.fallback }),
    version: "0.1.0",
    fetchImpl: f.fetchImpl,
    now: () => nowMs,
  });
}

describe("reddit: step 1, the API with credentials", () => {
  it("fetches an app-only token with Basic auth, then searches oauth.reddit.com with it", async () => {
    const f = routed();
    const p = make(f, { keys: true });
    expect(p.usesApi).toBe(true);
    const out = await p.search(query({ kind: "posts", per_platform: 4 }), signal());
    expect(out).toHaveLength(4);

    const [tokenCall, searchCall] = f.calls;
    expect(tokenCall).toMatchObject({
      url: "https://www.reddit.com/api/v1/access_token",
      method: "POST",
      body: "grant_type=client_credentials",
    });
    expect(tokenCall?.headers["authorization"]).toBe(`Basic ${BASIC}`);
    expect(tokenCall?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCall?.headers["user-agent"]).toBe("webrunner/0.1.0 personal MCP server");

    const url = new URL(searchCall?.url ?? "");
    expect(url.origin).toBe("https://oauth.reddit.com");
    expect(url.pathname).toBe("/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "rust async", sort: "top", t: "all", limit: "4", type: "link", raw_json: "1" });
    expect(searchCall?.headers["authorization"]).toBe("Bearer test-access-token-placeholder");
    expect(searchCall?.headers["user-agent"]).toBe("webrunner/0.1.0 personal MCP server");
  });

  it("caches the token until 60 s before it expires", async () => {
    const f = routed();
    const p = make(f, { keys: true });
    await p.search(query(), signal());
    await p.search(query(), signal());
    expect(f.to("access_token")).toHaveLength(1);
    // expires_in is 86400 s; one second past the safety margin a new token is fetched.
    nowMs += (86_400 - 60) * 1000 + 1000;
    await p.search(query(), signal());
    expect(f.to("access_token")).toHaveLength(2);
  });

  it("does not hand a 403 from the API over to the fallback and keeps secrets out of the message", async () => {
    const fallback = fakePlatform("reddit", { access: "browser" });
    const f = routed((_c, url) => (url.origin === "https://oauth.reddit.com" ? new Response(`forbidden ${CLIENT_SECRET}`, { status: 403 }) : undefined));
    const err = await make(f, { keys: true, fallback })
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialHttpError);
    expect(err).toMatchObject({ platform: "reddit", code: "provider", status: 403, retryable: false });
    expect((err as Error).message).not.toContain(CLIENT_SECRET);
    expect(fallback.searches).toHaveLength(0);
  });
});

describe("reddit: step 2, the public .json endpoints", () => {
  it("searches www.reddit.com/search.json with a descriptive User-Agent and no token call", async () => {
    const f = routed();
    const p = make(f);
    expect(p.usesApi).toBe(false);
    expect(p.isConfigured()).toBe(true);
    const out = await p.search(query({ kind: "posts", per_platform: 4, recency: "week", sort: "recent" }), signal());
    expect(out).toHaveLength(4);
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://www.reddit.com/search.json");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "rust async", sort: "new", t: "week", limit: "4", type: "link", raw_json: "1" });
    expect(f.calls[0]?.headers["user-agent"]).toBe("webrunner/0.1.0 personal MCP server");
    expect(f.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("honours a configured User-Agent", async () => {
    const f = routed();
    await make(f, { userAgent: "my-agent/1" }).search(query(), signal());
    expect(f.calls[0]?.headers["user-agent"]).toBe("my-agent/1");
  });

  it("restricts to subreddits with /r/a+b/search and restrict_sr=1", async () => {
    const f = routed();
    await make(f).search(query({ subreddits: ["rust", "r/programming"] }), signal());
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/r/rust+programming/search.json");
    expect(url.searchParams.get("restrict_sr")).toBe("1");
  });

  it("maps posts: selftext as text, the linked URL for link posts, permalink to a full URL", async () => {
    const out = await make(routed()).search(query({ kind: "posts", per_platform: 4 }), signal());
    for (const i of out) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(out[0]).toEqual({
      id: "reddit:1abcd01",
      platform: "reddit",
      kind: "post",
      url: POST_URL,
      author: "ferris_fan",
      title: "Which async runtime should a new Rust service use in 2026?",
      text: "Starting a new backend service. Tokio is the default answer but smol looks simpler. What are people actually running in production?",
      truncated: false,
      created_at: new Date(1760428800 * 1000).toISOString(),
      score: 812,
      replies: 143,
      community: "rust",
    });
    expect(out[1]).toMatchObject({ id: "reddit:1abcd02", text: "https://tokio.rs/blog/2026-10-tokio-2", community: "programming", score: 2401 });
  });

  it("comments are the top-level comments of the top posts by score, spread over the budget", async () => {
    const f = routed();
    const out = await make(f).search(query({ kind: "comments", per_platform: 6 }), signal());
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("limit")).toBe("5");
    const threads = f.to("/comments/");
    // Four posts in the fixture, sorted by score: 1abcd02 first. ceil(6 / 4) = 2 comments each.
    expect(threads.map((c) => new URL(c.url).pathname)).toEqual([
      "/comments/1abcd02.json",
      "/comments/1abcd01.json",
      "/comments/1abcd03.json",
      "/comments/1abcd04.json",
    ]);
    expect(Object.fromEntries(new URL(threads[0]?.url ?? "").searchParams)).toEqual({ limit: "2", depth: "1", sort: "top", raw_json: "1" });
    expect(out).toHaveLength(6);
    for (const i of out) {
      expect(SocialItemSchema.safeParse(i).success).toBe(true);
      expect(i.kind).toBe("comment");
      expect(i.parent_url).toBe(POST_URL);
    }
    expect(out[0]).toEqual({
      id: "reddit:k1cmt01",
      platform: "reddit",
      kind: "comment",
      url: `${POST_URL}k1cmt01/`,
      author: "pragmatic_dev",
      text: "Tokio. Not because it is the best designed but because every crate you will need integrates with it.",
      truncated: false,
      created_at: new Date(1760432400 * 1000).toISOString(),
      score: 640,
      community: "rust",
      parent_url: POST_URL,
    });
  });

  it("splits `both` and never exceeds per_platform", async () => {
    const out = await make(routed()).search(query({ kind: "both", per_platform: 5 }), signal());
    expect(out).toHaveLength(5);
    expect(out.map((i) => i.kind)).toEqual(["post", "post", "post", "comment", "comment"]);
  });

  it("reads a thread: the post first, then its comments; deleted comments and `more` stubs are skipped", async () => {
    const f = routed();
    const out = await make(f).thread("https://old.reddit.com/r/rust/comments/1abcd01/anything/", query({ per_platform: 10 }), signal());
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/comments/1abcd01.json");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(out.map((i) => i.id)).toEqual(["reddit:1abcd01", "reddit:k1cmt01", "reddit:k1cmt02", "reddit:k1cmt04"]);
    expect(out[0]?.kind).toBe("post");
    expect(out[3]).toMatchObject({ kind: "comment", author: "thread_enjoyer", parent_url: POST_URL });
  });
});

describe("reddit: step 3, the handover", () => {
  const forbidden = (): Response => new Response("<html>blocked</html>", { status: 403 });

  it("hands a 403 from .json over to the configured fallback, with a caveat", async () => {
    const fallbackItems = [item({ id: "reddit:browser1", platform: "reddit", url: "https://www.reddit.com/r/x/comments/browser1/" })];
    const fallback = fakePlatform("reddit", { access: "browser", search: () => Promise.resolve(fallbackItems) });
    const f = routed(() => forbidden());
    const caveats: string[] = [];
    const q = query({ kind: "posts" });
    const out = await make(f, { fallback }).search(q, signal(), { caveats });
    expect(out).toEqual(fallbackItems);
    expect(fallback.searches).toHaveLength(1);
    expect(fallback.searches[0]?.q).toBe(q);
    expect(caveats).toEqual(["Reddit's public JSON endpoints answered HTTP 403; results come from the browser instead."]);
  });

  it("hands a 429 over too, and threads as well", async () => {
    const fallback = fakePlatform("reddit", { access: "browser" });
    const f = routed(() => new Response("", { status: 429, headers: { "retry-after": "5" } }));
    const out = await make(f, { fallback }).thread(POST_URL, query(), signal());
    expect(out.map((i) => i.id)).toEqual(["reddit:post", "reddit:c1"]);
    expect(fallback.threads[0]?.url).toBe(POST_URL);
  });

  it("ignores a fallback that is not configured", async () => {
    const fallback = fakePlatform("reddit", { access: "browser", configured: false });
    const err = await make(routed(() => forbidden()), { fallback })
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect(fallback.searches).toHaveLength(0);
  });

  it("without a fallback, a 403 explains the API keys and the accounts tool", async () => {
    const err = await make(routed(() => forbidden()))
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect(err).toMatchObject({ platform: "reddit", code: "provider", retryable: false, status: 403, needsLogin: false });
    const message = (err as Error).message;
    expect(message).toContain("REDDIT_CLIENT_ID");
    expect(message).toContain("REDDIT_CLIENT_SECRET");
    expect(message).toContain("accounts");
  });

  it("without a fallback, a 429 is retryable and carries Retry-After", async () => {
    const f = routed(() => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }));
    const err = await make(f)
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialHttpError);
    expect(err).toMatchObject({ platform: "reddit", code: "provider", retryable: true, status: 429, retryAfterMs: 12_000 });
  });

  it("other failures pass through untouched", async () => {
    const err = await make(routed(() => jsonResponse({ message: "oops" }, 500)), { fallback: fakePlatform("reddit") })
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, retryable: true });
  });
});

describe("reddit: URLs", () => {
  it("owns comment permalinks and redd.it short links", () => {
    expect(redditPostId(POST_URL)).toBe("1abcd01");
    expect(redditPostId("https://old.reddit.com/r/rust/comments/1abcd01")).toBe("1abcd01");
    expect(redditPostId("https://redd.it/1abcd01")).toBe("1abcd01");
    expect(redditPostId("https://www.reddit.com/r/rust/")).toBeUndefined();
    expect(redditPostId("https://www.reddit.com/user/someone/")).toBeUndefined();
    expect(redditPostId("https://example.com/r/rust/comments/1abcd01/")).toBeUndefined();
    const p = make(routed());
    expect(p.ownsUrl(POST_URL)).toBe(true);
    expect(p.ownsUrl("https://news.ycombinator.com/item?id=1")).toBe(false);
  });

  it("rejects a non-post URL and a missing query as invalid_input", async () => {
    const p = make(routed());
    await expect(p.thread("https://www.reddit.com/r/rust/", query(), signal())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(p.search(query({ query: undefined }), signal())).rejects.toMatchObject({ code: "invalid_input" });
  });
});
