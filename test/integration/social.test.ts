import { describe, expect, it } from "vitest";
import { BlueskyProvider } from "../../src/core/social/platforms/bluesky.js";
import { HackerNewsProvider } from "../../src/core/social/platforms/hackernews.js";
import { RedditProvider } from "../../src/core/social/platforms/reddit.js";
import { YouTubeProvider } from "../../src/core/social/platforms/youtube.js";
import { SocialItemSchema, type SocialItem, type SocialSearchQuery } from "../../src/schemas/social.js";

/**
 * Live calls to the social platforms' APIs. Runs only with RUN_INTEGRATION=1;
 * each platform also gates itself on its prerequisites:
 *
 *   hackernews  keyless; always runs
 *   bluesky     keyless; always runs (the public API refuses some cloud IPs)
 *   reddit      the public .json endpoints always run (reddit.com refuses many
 *               cloud IPs with 403); the API path runs when REDDIT_CLIENT_ID and
 *               REDDIT_CLIENT_SECRET are set
 *   youtube     YOUTUBE_API_KEY (one search costs 100 quota units)
 *
 *   RUN_INTEGRATION=1 npx vitest run test/integration/social.test.ts
 */
const enabled = process.env["RUN_INTEGRATION"] === "1";
const redditId = process.env["REDDIT_CLIENT_ID"];
const redditSecret = process.env["REDDIT_CLIENT_SECRET"];
const youtubeKey = process.env["YOUTUBE_API_KEY"];
const hasReddit = redditId !== undefined && redditId !== "" && redditSecret !== undefined && redditSecret !== "";
const hasYouTube = youtubeKey !== undefined && youtubeKey !== "";

const query = (over: Partial<SocialSearchQuery> = {}): SocialSearchQuery => ({
  mode: "search",
  query: "rust async",
  platforms: ["hackernews"],
  kind: "both",
  sort: "engagement",
  max_results: 30,
  per_platform: 6,
  ...over,
});

function expectValid(items: SocialItem[], platform: SocialItem["platform"]): void {
  expect(items.length).toBeGreaterThan(0);
  for (const i of items) {
    expect(SocialItemSchema.safeParse(i).success).toBe(true);
    expect(i.platform).toBe(platform);
    expect(i.text.length).toBeLessThanOrEqual(2000);
  }
}

describe.skipIf(!enabled)("social platforms, live", () => {
  it("hackernews: search returns stories and comments; a thread returns the story first", async () => {
    const p = new HackerNewsProvider();
    const items = await p.search(query(), AbortSignal.timeout(20_000));
    expectValid(items, "hackernews");
    expect(items.some((i) => i.kind === "post")).toBe(true);
    expect(items.some((i) => i.kind === "comment")).toBe(true);
    const post = items.find((i) => i.kind === "post") as SocialItem;
    const thread = await p.thread(post.url, query({ per_platform: 5 }), AbortSignal.timeout(20_000));
    expectValid(thread, "hackernews");
    expect(thread[0]?.kind).toBe("post");
    expect(thread[0]?.id).toBe(post.id);
  });

  it("bluesky: search returns posts; replies of the top posts are comments", async () => {
    const p = new BlueskyProvider();
    const items = await p.search(query({ platforms: ["bluesky"], kind: "both", lang: "en" }), AbortSignal.timeout(20_000));
    expectValid(items, "bluesky");
    expect(items.some((i) => i.kind === "post")).toBe(true);
    const post = items.find((i) => i.kind === "post") as SocialItem;
    const thread = await p.thread(post.url, query({ per_platform: 5 }), AbortSignal.timeout(20_000));
    expectValid(thread, "bluesky");
    expect(thread[0]?.url).toBe(post.url);
  });

  it("reddit: the public .json endpoints answer with posts and comments (or refuse this IP with a clear 403 message)", async () => {
    const p = new RedditProvider({ version: "integration" });
    expect(p.usesApi).toBe(false);
    try {
      const items = await p.search(query({ platforms: ["reddit"], subreddits: ["rust"] }), AbortSignal.timeout(20_000));
      expectValid(items, "reddit");
      expect(items.every((i) => i.community?.toLowerCase() === "rust")).toBe(true);
    } catch (err) {
      expect(err).toMatchObject({ platform: "reddit", status: 403 });
      expect((err as Error).message).toContain("REDDIT_CLIENT_ID");
    }
  });

  it.skipIf(!hasReddit)("reddit: the API path with app-only OAuth", async () => {
    const p = new RedditProvider({ version: "integration", clientId: redditId as string, clientSecret: redditSecret as string });
    expect(p.usesApi).toBe(true);
    const items = await p.search(query({ platforms: ["reddit"] }), AbortSignal.timeout(20_000));
    expectValid(items, "reddit");
    const post = items.find((i) => i.kind === "post") as SocialItem;
    const thread = await p.thread(post.url, query({ per_platform: 5 }), AbortSignal.timeout(20_000));
    expect(thread[0]?.kind).toBe("post");
  });

  it.skipIf(!hasYouTube)("youtube: videos with statistics, then comments for a video", async () => {
    const p = new YouTubeProvider({ apiKey: youtubeKey as string });
    const caveats: string[] = [];
    const items = await p.search(query({ platforms: ["youtube"], kind: "both", per_platform: 4 }), AbortSignal.timeout(20_000), { caveats });
    expectValid(items, "youtube");
    expect(caveats.some((c) => c.includes("100 units"))).toBe(true);
    const video = items.find((i) => i.kind === "post") as SocialItem;
    const thread = await p.thread(video.url, query({ per_platform: 5 }), AbortSignal.timeout(20_000));
    expect(thread[0]?.id).toBe(video.id);
  });
});
