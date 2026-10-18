import { describe, expect, it } from "vitest";
import { YOUTUBE_QUOTA_CAVEAT, YouTubeProvider, youTubeVideoId } from "../../../src/core/social/platforms/youtube.js";
import { SocialProviderError } from "../../../src/core/social/types.js";
import { SocialItemSchema } from "../../../src/schemas/social.js";
import { fakeFetch, jsonResponse, loadFixture, query, signal } from "./helpers.js";

/** Fixtures built from the documented shapes (see the `_note` in each file). */
const search = loadFixture("youtube-search");
const videos = loadFixture("youtube-videos");
const commentThreads = loadFixture("youtube-comment-threads");

const KEY = "AIzaSy-test-key-0123456789";
const NOW = Date.parse("2026-10-18T12:00:00Z");
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function routed(over: Partial<Record<"search" | "videos" | "commentThreads", (url: URL) => Response>> = {}): ReturnType<typeof fakeFetch> {
  return fakeFetch((_call, url) => {
    if (url.pathname.endsWith("/search")) return over.search?.(url) ?? jsonResponse(search);
    if (url.pathname.endsWith("/videos")) return over.videos?.(url) ?? jsonResponse(videos);
    if (url.pathname.endsWith("/commentThreads")) return over.commentThreads?.(url) ?? jsonResponse(commentThreads);
    return jsonResponse({ error: "unknown" }, 404);
  });
}

const make = (f: ReturnType<typeof fakeFetch>, opts: { apiKey?: string } = { apiKey: KEY }): YouTubeProvider =>
  new YouTubeProvider({ fetchImpl: f.fetchImpl, now: () => NOW, ...(opts.apiKey !== undefined && { apiKey: opts.apiKey }) });

describe("youtube: configuration", () => {
  it("is configured only with a key and never calls the network without one", async () => {
    const f = routed();
    expect(make(f, {}).isConfigured()).toBe(false);
    expect(make(f, { apiKey: "  " }).isConfigured()).toBe(false);
    expect(make(f).isConfigured()).toBe(true);
    const err = await make(f, {})
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect(err).toMatchObject({ platform: "youtube", code: "config", retryable: false });
    expect((err as Error).message).toContain("YOUTUBE_API_KEY");
    expect(f.calls).toHaveLength(0);
  });
});

describe("youtube: mapping", () => {
  it("maps search results plus one statistics call to video posts and adds the quota caveat", async () => {
    const f = routed();
    const caveats: string[] = [];
    const out = await make(f).search(query({ kind: "posts", per_platform: 3 }), signal(), { caveats });
    expect(out).toHaveLength(3);
    for (const i of out) expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(out[0]).toEqual({
      id: "youtube:dQw4w9WgXcQ",
      platform: "youtube",
      kind: "post",
      url: VIDEO_URL,
      author: "Systems Programming Weekly",
      title: "Async Rust in 2026: what changed",
      text: "A tour of the async Rust ecosystem: Tokio, smol, structured concurrency and the cancellation story.",
      truncated: false,
      created_at: "2026-10-10T15:00:00.000Z",
      score: 2150,
      replies: 312,
      community: "Systems Programming Weekly",
    });
    // Hidden likes: no score, but the comment count stays.
    expect(out[2]).toMatchObject({ replies: 45 });
    expect("score" in (out[2] ?? {})).toBe(false);
    expect(caveats).toEqual([YOUTUBE_QUOTA_CAVEAT]);

    expect(f.calls).toHaveLength(2);
    const s = new URL(f.calls[0]?.url ?? "");
    expect(s.origin + s.pathname).toBe("https://www.googleapis.com/youtube/v3/search");
    expect(Object.fromEntries(s.searchParams)).toEqual({
      part: "snippet",
      type: "video",
      q: "rust async",
      order: "relevance",
      maxResults: "3",
      key: KEY,
    });
    const v = new URL(f.calls[1]?.url ?? "");
    expect(v.pathname.endsWith("/videos")).toBe(true);
    expect(v.searchParams.get("part")).toBe("statistics");
    expect(v.searchParams.get("id")).toBe("dQw4w9WgXcQ,aBcDeFgHiJk,zYxWvUtSrQp");
  });

  it("uses order=date for recent and publishedAfter for recency", async () => {
    const f = routed();
    await make(f).search(query({ sort: "recent", recency: "month" }), signal());
    const s = new URL(f.calls[0]?.url ?? "");
    expect(s.searchParams.get("order")).toBe("date");
    expect(s.searchParams.get("publishedAfter")).toBe(new Date(NOW - 31 * 86_400_000).toISOString());
  });

  it("builds comments from commentThreads of the top 3 videos", async () => {
    const f = routed();
    const out = await make(f).search(query({ kind: "comments", per_platform: 6 }), signal());
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("maxResults")).toBe("3");
    const threads = f.to("/commentThreads");
    expect(threads).toHaveLength(3);
    const t = new URL(threads[0]?.url ?? "");
    expect(Object.fromEntries(t.searchParams)).toEqual({
      part: "snippet",
      videoId: "dQw4w9WgXcQ",
      order: "relevance",
      maxResults: "2",
      textFormat: "plainText",
      key: KEY,
    });
    expect(out).toHaveLength(6);
    for (const i of out) {
      expect(SocialItemSchema.safeParse(i).success).toBe(true);
      expect(i.kind).toBe("comment");
    }
    expect(out[0]).toEqual({
      id: "youtube:UgzCommentThread0001",
      platform: "youtube",
      kind: "comment",
      url: `${VIDEO_URL}&lc=UgzCommentThread0001`,
      author: "@asyncfan",
      text: "Finally someone explains cancellation safety without hand-waving. Great video.",
      truncated: false,
      created_at: "2026-10-11T02:14:00.000Z",
      score: 128,
      replies: 6,
      parent_url: VIDEO_URL,
    });
  });

  it("skips a video whose comments are disabled, with a caveat", async () => {
    const disabled = { error: { code: 403, message: "disabled", errors: [{ reason: "commentsDisabled", domain: "youtube.commentThread" }] } };
    const f = routed({ commentThreads: (url) => (url.searchParams.get("videoId") === "aBcDeFgHiJk" ? jsonResponse(disabled, 403) : jsonResponse(commentThreads)) });
    const caveats: string[] = [];
    const out = await make(f).search(query({ kind: "comments", per_platform: 6 }), signal(), { caveats });
    expect(out).toHaveLength(4);
    expect(caveats).toContain("YouTube: comments are disabled on https://www.youtube.com/watch?v=aBcDeFgHiJk.");
  });

  it("maps a quotaExceeded 403 to a non-retryable provider error naming the quota", async () => {
    const quota = { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }] } };
    const f = routed({ search: () => jsonResponse(quota, 403) });
    const err = await make(f)
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialProviderError);
    expect(err).toMatchObject({ platform: "youtube", code: "provider", retryable: false, status: 403 });
    expect((err as Error).message).toMatch(/quota/i);
    expect((err as Error).message).toContain("10,000");
  });

  it("never puts the key into an error message", async () => {
    const f = routed({ search: () => new Response(`bad request for key=${KEY}`, { status: 400 }) });
    const err = await make(f)
      .search(query(), signal())
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("400");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("reads a thread: the video first, then its comment threads", async () => {
    const f = routed();
    const out = await make(f).thread("https://youtu.be/dQw4w9WgXcQ", query({ per_platform: 10 }), signal());
    const v = new URL(f.calls[0]?.url ?? "");
    expect(v.pathname.endsWith("/videos")).toBe(true);
    expect(v.searchParams.get("part")).toBe("snippet,statistics");
    expect(v.searchParams.get("id")).toBe("dQw4w9WgXcQ");
    expect(new URL(f.calls[1]?.url ?? "").searchParams.get("maxResults")).toBe("10");
    expect(out.map((i) => i.kind)).toEqual(["post", "comment", "comment"]);
    expect(out[0]).toMatchObject({ id: "youtube:dQw4w9WgXcQ", score: 2150, replies: 312, title: "Async Rust in 2026: what changed" });
    expect(out[1]?.parent_url).toBe(VIDEO_URL);
  });

  it("owns watch, short, embed and youtu.be URLs", () => {
    expect(youTubeVideoId(VIDEO_URL)).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://www.youtube.com/@channel")).toBeUndefined();
    expect(youTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeUndefined();
    expect(make(routed()).ownsUrl(VIDEO_URL)).toBe(true);
  });
});
