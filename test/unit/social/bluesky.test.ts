import { describe, expect, it } from "vitest";
import { BlueskyProvider, blueskyPostRef } from "../../../src/core/social/platforms/bluesky.js";
import { SocialItemSchema } from "../../../src/schemas/social.js";
import { fakeFetch, jsonResponse, loadFixture, query, signal } from "./helpers.js";

/** Fixtures built from the documented shapes (see the `_note` in each file). */
const search = loadFixture("bluesky-search");
const thread = loadFixture("bluesky-thread");
const resolve = loadFixture("bluesky-resolve-handle");

const NOW = Date.parse("2026-10-18T12:00:00Z");
const POST_URL = "https://bsky.app/profile/rustacean.example.com/post/3kz7abcdefg2a";

function routed(): ReturnType<typeof fakeFetch> {
  return fakeFetch((_call, url) => {
    if (url.pathname.endsWith("app.bsky.feed.searchPosts")) return jsonResponse(search);
    if (url.pathname.endsWith("app.bsky.feed.getPostThread")) return jsonResponse(thread);
    if (url.pathname.endsWith("com.atproto.identity.resolveHandle")) return jsonResponse(resolve);
    return jsonResponse({ error: "unknown" }, 404);
  });
}

const make = (f: ReturnType<typeof fakeFetch>): BlueskyProvider => new BlueskyProvider({ fetchImpl: f.fetchImpl, now: () => NOW });

describe("bluesky: mapping", () => {
  it("is always configured and keyless", () => {
    expect(make(routed()).isConfigured()).toBe(true);
  });

  it("maps searchPosts to posts with web URLs, counts and lang", async () => {
    const f = routed();
    const out = await make(f).search(query({ kind: "posts", per_platform: 10, lang: "en" }), signal());
    expect(out).toHaveLength(3);
    for (const i of out) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(out[0]).toEqual({
      id: "bluesky:did:plc:aaaa1111bbbb2222cccc3333/3kz7abcdefg2a",
      platform: "bluesky",
      kind: "post",
      url: POST_URL,
      author: "rustacean.example.com",
      text: "Tokio's new runtime metrics saved us a week of debugging. Async Rust is finally pleasant.",
      truncated: false,
      created_at: "2026-10-15T09:12:00.000Z",
      score: 42,
      replies: 4,
      reposts: 7,
      lang: "en",
    });
    // No langs: no lang field. A regional tag is reduced to its primary subtag.
    expect("lang" in (out[1] ?? {})).toBe(false);
    expect(out[2]?.lang).toBe("en");

    const url = new URL(f.calls[0]?.url ?? "");
    // public.api.bsky.app refuses searchPosts (403, live 2026-10-21); the AppView serves it keyless.
    expect(url.origin).toBe("https://api.bsky.app");
    expect(url.searchParams.get("q")).toBe("rust async");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("sort")).toBe("top");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.has("since")).toBe(false);
  });

  it("uses sort=latest for recent and an ISO since for recency", async () => {
    const f = routed();
    await make(f).search(query({ sort: "recent", recency: "day" }), signal());
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.searchParams.get("sort")).toBe("latest");
    expect(url.searchParams.get("since")).toBe(new Date(NOW - 86_400_000).toISOString());
  });

  it("builds comments from the replies of the top 3 posts via getPostThread depth 1", async () => {
    const f = routed();
    const out = await make(f).search(query({ kind: "comments", per_platform: 4 }), signal());
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("limit")).toBe("3");
    const threads = f.to("getPostThread");
    expect(threads).toHaveLength(3);
    expect(new URL(threads[0]?.url ?? "").searchParams.get("uri")).toBe("at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/3kz7abcdefg2a");
    expect(new URL(threads[0]?.url ?? "").searchParams.get("depth")).toBe("1");
    expect(out).toHaveLength(4);
    for (const i of out) {
      expect(SocialItemSchema.safeParse(i).success).toBe(true);
      expect(i.kind).toBe("comment");
      expect(i.parent_url).toBe(POST_URL);
    }
    expect(out[0]).toMatchObject({ author: "observer.bsky.social", score: 3, replies: 1 });
  });

  it("reads a thread after resolving the handle to a DID; not-found replies are skipped", async () => {
    const f = routed();
    const out = await make(f).thread(POST_URL, query({ per_platform: 10 }), signal());
    const resolveCall = f.to("resolveHandle")[0];
    expect(new URL(resolveCall?.url ?? "").searchParams.get("handle")).toBe("rustacean.example.com");
    const threadCall = f.to("getPostThread")[0];
    expect(new URL(threadCall?.url ?? "").searchParams.get("uri")).toBe("at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/3kz7abcdefg2a");
    expect(out.map((i) => i.kind)).toEqual(["post", "comment", "comment"]);
    expect(out[0]?.url).toBe(POST_URL);
    expect(out[1]?.parent_url).toBe(POST_URL);
    expect(out[2]).toMatchObject({ author: "skeptic.example.net", reposts: 1, score: 9 });
  });

  it("skips handle resolution when the URL already carries a DID", async () => {
    const f = routed();
    await make(f).thread("https://bsky.app/profile/did:plc:aaaa1111bbbb2222cccc3333/post/3kz7abcdefg2a", query(), signal());
    expect(f.to("resolveHandle")).toHaveLength(0);
    expect(f.to("getPostThread")).toHaveLength(1);
  });

  it("searches on api.bsky.app and reads threads and handles on public.api.bsky.app", async () => {
    const f = routed();
    await make(f).search(query({ kind: "both", per_platform: 4 }), signal());
    await make(f).thread(POST_URL, query({ per_platform: 5 }), signal());
    const origins = f.calls.map((c) => {
      const u = new URL(c.url);
      return `${u.origin} ${u.pathname.split("/").pop() ?? ""}`;
    });
    expect(new Set(origins)).toEqual(
      new Set([
        "https://api.bsky.app app.bsky.feed.searchPosts",
        "https://public.api.bsky.app app.bsky.feed.getPostThread",
        "https://public.api.bsky.app com.atproto.identity.resolveHandle",
      ]),
    );
    const one = new BlueskyProvider({ fetchImpl: f.fetchImpl, baseUrl: "http://127.0.0.1:9" });
    await one.search(query({ kind: "posts", per_platform: 1 }), signal());
    expect(new URL(f.calls.at(-1)?.url ?? "").origin).toBe("http://127.0.0.1:9");
  });

  it("owns bsky.app post URLs only", () => {
    expect(blueskyPostRef(POST_URL)).toEqual({ handle: "rustacean.example.com", rkey: "3kz7abcdefg2a" });
    const p = make(routed());
    expect(p.ownsUrl(POST_URL)).toBe(true);
    expect(p.ownsUrl("https://bsky.app/profile/rustacean.example.com")).toBe(false);
    expect(p.ownsUrl("https://example.com/profile/a/post/b")).toBe(false);
  });

  it("maps a 429 to a retryable provider error carrying Retry-After", async () => {
    const f = fakeFetch(() => jsonResponse({ error: "RateLimitExceeded" }, 429, { "retry-after": "30" }));
    const err = await make(f)
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ platform: "bluesky", code: "provider", retryable: true, status: 429, retryAfterMs: 30_000 });
  });
});

describe("bluesky: live responses (recorded 2026-10-21)", () => {
  const liveSearch = loadFixture("bluesky-search-live");
  const liveThread = loadFixture("bluesky-thread-live");
  const liveResolve = loadFixture("bluesky-resolve-handle-live");
  const liveRouted = () =>
    fakeFetch((_call, url) => {
      if (url.pathname.endsWith("app.bsky.feed.searchPosts")) return jsonResponse(liveSearch);
      if (url.pathname.endsWith("app.bsky.feed.getPostThread")) return jsonResponse(liveThread);
      if (url.pathname.endsWith("com.atproto.identity.resolveHandle")) return jsonResponse(liveResolve);
      return jsonResponse({ error: "unknown" }, 404);
    });

  it("maps the live search: web URLs, handles, counts, created_at from the record", async () => {
    const out = await make(liveRouted()).search(query({ kind: "posts", per_platform: 3 }), signal());
    expect(out).toHaveLength(3);
    for (const i of out) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(out[0]).toMatchObject({
      id: "bluesky:did:plc:5ujaiwdzii5kb6ilzs4tadoz/3my67x6gk462q",
      kind: "post",
      url: "https://bsky.app/profile/compute.yee.nu/post/3my67x6gk462q",
      author: "compute.yee.nu",
      created_at: "2026-10-18T18:22:18.347Z",
      score: 4,
      replies: 1,
      reposts: 2,
    });
    expect(out[0]?.text).toMatch(/^Even the Rust programming language/);
  });

  it("maps the live thread: the post first, then its reply as a comment pointing at it", async () => {
    const f = liveRouted();
    const out = await make(f).thread("https://bsky.app/profile/compute.yee.nu/post/3my67x6gk462q", query({ per_platform: 5 }), signal());
    expect(out.map((i) => i.kind)).toEqual(["post", "comment"]);
    expect(out[1]).toMatchObject({
      author: "pupgirlcrystal.bsky.social",
      parent_url: "https://bsky.app/profile/compute.yee.nu/post/3my67x6gk462q",
      created_at: "2026-10-18T18:23:23.213Z",
    });
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("handle")).toBe("compute.yee.nu");
    expect(new URL(f.calls[1]?.url ?? "").searchParams.get("uri")).toBe("at://did:plc:5ujaiwdzii5kb6ilzs4tadoz/app.bsky.feed.post/3my67x6gk462q");
  });
});
