import { describe, expect, it } from "vitest";
import { HackerNewsProvider, hackerNewsItemId } from "../../../src/core/social/platforms/hackernews.js";
import { SocialProviderError } from "../../../src/core/social/types.js";
import { SocialItemSchema } from "../../../src/schemas/social.js";
import { fakeFetch, jsonResponse, loadFixture, query, signal } from "./helpers.js";

/** Fixtures recorded live from hn.algolia.com (see the `_note` in each file). */
const stories = loadFixture("hackernews-search-stories");
const comments = loadFixture("hackernews-search-comments");
const itemFixture = loadFixture("hackernews-item");

const NOW = Date.parse("2026-10-18T12:00:00Z");

function routed(): ReturnType<typeof fakeFetch> {
  return fakeFetch((_call, url) => {
    if (url.pathname.startsWith("/api/v1/items/")) return jsonResponse(itemFixture);
    if (url.searchParams.get("tags") === "comment") return jsonResponse(comments);
    return jsonResponse(stories);
  });
}

const make = (f: ReturnType<typeof fakeFetch>): HackerNewsProvider => new HackerNewsProvider({ fetchImpl: f.fetchImpl, now: () => NOW });

describe("hackernews: mapping", () => {
  it("is always configured and keyless", () => {
    expect(make(routed()).isConfigured()).toBe(true);
    expect(make(routed()).access).toBe("api");
  });

  it("maps the recorded story hits to posts", async () => {
    const f = routed();
    const out = await make(f).search(query({ kind: "posts", per_platform: 5 }), signal());
    expect(out).toHaveLength(5);
    for (const i of out) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(out[0]).toEqual({
      id: "hackernews:26406989",
      platform: "hackernews",
      kind: "post",
      url: "https://news.ycombinator.com/item?id=26406989",
      author: "tazjin",
      title: "Why asynchronous Rust doesn't work",
      // A link post has no story_text: the linked URL stands in as the text.
      text: "https://theta.eu.org/2021/03/08/async-rust-2.html",
      truncated: false,
      created_at: "2021-03-10T02:16:55.000Z",
      score: 603,
      replies: 482,
    });
    // A text post keeps its own body.
    expect(out[1]?.text.startsWith("This RFD describes")).toBe(true);
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/search");
    expect(url.searchParams.get("query")).toBe("rust async");
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("hitsPerPage")).toBe("5");
    expect(url.searchParams.has("numericFilters")).toBe(false);
  });

  it("maps the recorded comment hits to comments with plain text and a parent_url", async () => {
    const out = await make(routed()).search(query({ kind: "comments", per_platform: 3 }), signal());
    expect(out).toHaveLength(3);
    for (const i of out) {
      expect(SocialItemSchema.safeParse(i).success).toBe(true);
      expect(i.kind).toBe("comment");
      expect(i.parent_url).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/);
      expect(i.text).not.toMatch(/<[a-z]+>|&#x27;|&quot;|&gt;/);
    }
    const first = out[0];
    expect(first?.author).toBe("kxo");
    expect(first?.text).toContain("If Rust had asynchronous I/O this would be less of a head scratcher.\nToo bad");
    expect("title" in (first ?? {})).toBe(false);
  });

  it("splits `both` between stories and comments and never exceeds per_platform", async () => {
    const f = routed();
    const out = await make(f).search(query({ kind: "both", per_platform: 4 }), signal());
    expect(out).toHaveLength(4);
    expect(out.map((i) => i.kind)).toEqual(["post", "post", "comment", "comment"]);
    expect(f.calls.map((c) => new URL(c.url).searchParams.get("hitsPerPage"))).toEqual(["2", "2"]);
  });

  it("uses search_by_date for recent and a created_at_i filter for recency", async () => {
    const f = routed();
    await make(f).search(query({ sort: "recent", recency: "week" }), signal());
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/search_by_date");
    expect(url.searchParams.get("numericFilters")).toBe(`created_at_i>${Math.floor((NOW - 7 * 86_400_000) / 1000)}`);
  });

  it("reads a thread: the story first, then its depth-1 children as comments", async () => {
    const f = routed();
    const out = await make(f).thread("https://news.ycombinator.com/item?id=26406989", query({ per_platform: 10 }), signal());
    expect(f.calls[0]?.url).toBe("https://hn.algolia.com/api/v1/items/26406989");
    for (const i of out) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(out[0]).toMatchObject({
      id: "hackernews:26406989",
      kind: "post",
      title: "Why asynchronous Rust doesn't work",
      author: "tazjin",
      score: 603,
      replies: 3,
      url: "https://news.ycombinator.com/item?id=26406989",
    });
    expect(out.length).toBe(4);
    const c = out[1];
    expect(c).toMatchObject({ kind: "comment", author: "Animats", parent_url: "https://news.ycombinator.com/item?id=26406989" });
    expect(c?.text.startsWith(`I'm coming around to the position that pure "async" is OK`)).toBe(true);
    // Grandchildren (depth 2) are not read.
    expect(out.some((i) => i.author === "socialdemocrat")).toBe(false);
  });

  it("caps thread comments at per_platform", async () => {
    const out = await make(routed()).thread("https://news.ycombinator.com/item?id=26406989", query({ per_platform: 1 }), signal());
    expect(out).toHaveLength(2);
  });

  it("rejects a non-item URL and a missing query as invalid_input", async () => {
    const p = make(routed());
    await expect(p.thread("https://news.ycombinator.com/news", query(), signal())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(p.search(query({ query: undefined }), signal())).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("surfaces HTTP failures as SocialProviderError with the right retryability", async () => {
    const f = fakeFetch(() => jsonResponse({ message: "down" }, 503));
    const err = await make(f)
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect(err).toMatchObject({ platform: "hackernews", code: "provider", retryable: true, status: 503 });
  });

  it("owns item URLs only", () => {
    expect(hackerNewsItemId("https://news.ycombinator.com/item?id=26406989")).toBe("26406989");
    expect(make(routed()).ownsUrl("https://news.ycombinator.com/item?id=1")).toBe(true);
    expect(make(routed()).ownsUrl("https://news.ycombinator.com/")).toBe(false);
    expect(make(routed()).ownsUrl("https://example.com/item?id=1")).toBe(false);
    expect(make(routed()).ownsUrl("not a url")).toBe(false);
  });
});
