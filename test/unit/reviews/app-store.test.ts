import { describe, expect, it } from "vitest";
import { APP_STORE_MAX_PAGES, AppStoreSource, parseAppStoreUrl } from "../../../src/core/reviews/sources/app-store.js";
import { ReviewSourceError } from "../../../src/core/reviews/types.js";
import { ReviewSchema, ReviewSubjectSchema, type NormalizedReviewsQuery } from "../../../src/schemas/reviews.js";
import { BASE_QUERY, fakeFetch, forever, jsonResponse, loadJsonFixture, type RecordedCall } from "./helpers.js";

/**
 * Fixtures were recorded live on 2026-10-18 (see the `_note` in each file):
 * the search for "Notion" and page 1 of the Notion app's review feed, trimmed
 * to 10 entries. The feed URL shape and the entry fields are therefore real.
 */
const searchFixture = loadJsonFixture("app-store-search.json");
const feedFixture = loadJsonFixture("app-store-reviews-page1.json") as { feed: { entry: Array<Record<string, unknown>> } };
const EMPTY_FEED = { feed: { author: { name: { label: "iTunes Store" } } } };
const NOTION_ID = "1232780281";

const signal = (): AbortSignal => new AbortController().signal;

/** Routes the fake fetch like the real endpoints do. */
function appStoreFetch(over: Partial<Record<"search" | "lookup" | "feed", (call: RecordedCall, page: number) => Response>> = {}) {
  return fakeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === "/search") return (over.search ?? (() => jsonResponse(searchFixture)))(call, 0);
    if (url.pathname === "/lookup") return (over.lookup ?? (() => jsonResponse(searchFixture)))(call, 0);
    const page = Number(/\/page=(\d+)\//.exec(url.pathname)?.[1]);
    if (url.pathname.includes("/rss/customerreviews/")) {
      return (over.feed ?? ((_c, p) => jsonResponse(p === 1 ? feedFixture : EMPTY_FEED)))(call, page);
    }
    return new Response("not found", { status: 404 });
  });
}

async function failure(p: Promise<unknown>): Promise<ReviewSourceError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReviewSourceError);
  return err as ReviewSourceError;
}

describe("AppStoreSource", () => {
  it("is keyless, answers for app and any, and parses App Store URLs", () => {
    const src = new AppStoreSource();
    expect(src.name).toBe("app_store");
    expect(src.isConfigured()).toBe(true);
    expect(src.defaultKinds).toEqual(["app", "any"]);
    expect(parseAppStoreUrl("https://apps.apple.com/us/app/notion-notes-tasks-ai/id1232780281?uo=4")).toEqual({ id: "1232780281", country: "us" });
    expect(parseAppStoreUrl("https://apps.apple.com/app/id1232780281")).toEqual({ id: "1232780281" });
    expect(parseAppStoreUrl("https://itunes.apple.com/gb/app/id42")).toEqual({ id: "42", country: "gb" });
    // A developer page carries a developer id, not an app id.
    expect(parseAppStoreUrl("https://apps.apple.com/us/developer/notion-labs-incorporated/id1232780280")).toBeUndefined();
    expect(parseAppStoreUrl("https://play.google.com/store/apps/details?id=notion.id")).toBeUndefined();
  });

  it("finds the app by name and maps the recorded feed page to reviews", async () => {
    const f = appStoreFetch();
    const caveats: string[] = [];
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search(BASE_QUERY, signal(), { caveats });

    // The search request, as the plan specifies it.
    const search = new URL(f.calls[0]?.url ?? "");
    expect(search.origin + search.pathname).toBe("https://itunes.apple.com/search");
    expect(Object.fromEntries(search.searchParams)).toEqual({ term: "Notion", entity: "software", country: "us", limit: "5" });
    // Then the feed, page 1, and page 2 because 10 reviews are fewer than per_source (15); page 2 is empty so it stops.
    expect(f.calls.map((c) => c.url).slice(1)).toEqual([
      `https://itunes.apple.com/us/rss/customerreviews/id=${NOTION_ID}/sortBy=mostRecent/page=1/json`,
      `https://itunes.apple.com/us/rss/customerreviews/id=${NOTION_ID}/sortBy=mostRecent/page=2/json`,
    ]);

    expect(ReviewSubjectSchema.safeParse(out.subject).success).toBe(true);
    expect(out.subject).toMatchObject({
      source: "app_store",
      name: "Notion: Notes, Tasks, AI",
      url: expect.stringContaining(`apps.apple.com/us/app/`) as string,
      review_count: expect.any(Number) as number,
      categories: expect.arrayContaining(["Productivity"]) as string[],
    });
    expect(out.subject.rating_avg).toBeGreaterThan(0);
    expect(out.subject.rating_avg).toBeLessThanOrEqual(5);

    expect(out.reviews).toHaveLength(10);
    for (const r of out.reviews) {
      expect(ReviewSchema.safeParse(r).success).toBe(true);
      expect(r.source).toBe("app_store");
      expect(r.id).toMatch(/^app_store:\d+$/);
      expect(r.url).toBe(`https://apps.apple.com/us/app/id${NOTION_ID}?see-all=reviews`);
      expect(r.rating).toBeGreaterThanOrEqual(1);
      expect(r.rating).toBeLessThanOrEqual(5);
      expect(r.version).toMatch(/^\d+\.\d+/);
      expect(r.title).toBeTruthy();
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.author).toBeTruthy();
      expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
    const second = out.reviews[1];
    expect(second).toMatchObject({ id: "app_store:14671531500", rating: 3, version: "1.7.346", title: "It’s alright", author: "pappaopag", created_at: "2026-10-16T00:37:32.000Z" });
    expect(second?.text).toMatch(/^Notion web is much better/);
    // Only one match caveat, naming the other apps found.
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toMatch(/matched "Notion" to "Notion: Notes, Tasks, AI"/);
    expect(caveats[0]).toContain("Notion Calendar");
  });

  it("skips the app's own entry (no im:rating) at the top of a page", async () => {
    const appEntry = {
      "im:name": { label: "Notion: Notes, Tasks, AI" },
      id: { label: `https://apps.apple.com/us/app/id${NOTION_ID}` },
      title: { label: "Notion: Notes, Tasks, AI - Notion Labs, Incorporated" },
      content: { label: "The app description" },
    };
    const withApp = { feed: { ...feedFixture.feed, entry: [appEntry, ...feedFixture.feed.entry] } };
    const f = appStoreFetch({ feed: (_c, page) => jsonResponse(page === 1 ? withApp : EMPTY_FEED) });
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search(BASE_QUERY, signal());
    expect(out.reviews).toHaveLength(10);
    expect(out.reviews.some((r) => r.text === "The app description")).toBe(false);
  });

  it("accepts a page whose single entry is an object, and a missing entry key as empty", async () => {
    const one = { feed: { entry: feedFixture.feed.entry[0] } };
    const f = appStoreFetch({ feed: (_c, page) => jsonResponse(page === 1 ? one : EMPTY_FEED) });
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search(BASE_QUERY, signal());
    expect(out.reviews).toHaveLength(1);
  });

  it("stops at per_source and reads page 1 only when it is enough", async () => {
    const f = appStoreFetch();
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search({ ...BASE_QUERY, per_source: 3 }, signal());
    expect(out.reviews).toHaveLength(3);
    expect(f.calls.filter((c) => c.url.includes("/rss/"))).toHaveLength(1);
  });

  it("reads at most three pages and deduplicates repeated entries", async () => {
    const f = appStoreFetch({ feed: () => jsonResponse(feedFixture) });
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search({ ...BASE_QUERY, per_source: 50 }, signal());
    expect(f.calls.filter((c) => c.url.includes("/rss/"))).toHaveLength(APP_STORE_MAX_PAGES);
    expect(out.reviews).toHaveLength(10);
  });

  it("takes the id and storefront from an App Store URL and looks the app up", async () => {
    const f = appStoreFetch();
    const q: NormalizedReviewsQuery = {
      ...BASE_QUERY,
      subject: `https://apps.apple.com/gb/app/notion-notes-tasks-ai/id${NOTION_ID}`,
      subject_url: `https://apps.apple.com/gb/app/notion-notes-tasks-ai/id${NOTION_ID}`,
    };
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search(q, signal());
    const lookup = new URL(f.calls[0]?.url ?? "");
    expect(lookup.pathname).toBe("/lookup");
    expect(Object.fromEntries(lookup.searchParams)).toEqual({ id: NOTION_ID, country: "gb" });
    expect(f.calls[1]?.url).toBe(`https://itunes.apple.com/gb/rss/customerreviews/id=${NOTION_ID}/sortBy=mostRecent/page=1/json`);
    expect(out.reviews[0]?.url).toBe(`https://apps.apple.com/gb/app/id${NOTION_ID}?see-all=reviews`);
    expect(out.subject.name).toBe("Notion: Notes, Tasks, AI");
  });

  it("falls back to the query's storefront and an id-only subject when the URL has none and the lookup is empty", async () => {
    const f = appStoreFetch({ lookup: () => jsonResponse({ resultCount: 0, results: [] }) });
    const caveats: string[] = [];
    const q: NormalizedReviewsQuery = { ...BASE_QUERY, subject: `https://apps.apple.com/app/id${NOTION_ID}`, subject_url: `https://apps.apple.com/app/id${NOTION_ID}`, app_store_country: "de" };
    const out = await new AppStoreSource({ fetchImpl: f.fetchImpl }).search(q, signal(), { caveats });
    expect(f.calls[1]?.url).toContain("/de/rss/");
    expect(out.subject.name).toBe(`App Store app id ${NOTION_ID}`);
    expect(caveats[0]).toMatch(/returned no metadata/);
  });

  it("is not_found for a URL that is not an App Store page or a name with no results", async () => {
    const f = appStoreFetch({ search: () => jsonResponse({ resultCount: 0, results: [] }) });
    const src = new AppStoreSource({ fetchImpl: f.fetchImpl });
    const notApp = await failure(src.search({ ...BASE_QUERY, subject_url: "https://example.org/app" }, signal()));
    expect(notApp.code).toBe("not_found");
    const noHit = await failure(src.search({ ...BASE_QUERY, subject: "zzzz" }, signal()));
    expect(noHit).toMatchObject({ code: "not_found", retryable: false });
    expect(noHit.message).toContain("zzzz");
  });

  it("maps HTTP failures: feed 404 is not_found, search 500 is a retryable provider error, an unexpected shape is provider", async () => {
    const feed404 = appStoreFetch({ feed: () => new Response("", { status: 404 }) });
    expect((await failure(new AppStoreSource({ fetchImpl: feed404.fetchImpl }).search(BASE_QUERY, signal()))).code).toBe("not_found");

    const search500 = appStoreFetch({ search: () => jsonResponse({ error: "down" }, 500) });
    expect(await failure(new AppStoreSource({ fetchImpl: search500.fetchImpl }).search(BASE_QUERY, signal()))).toMatchObject({ code: "provider", retryable: true, status: 500 });

    const odd = appStoreFetch({ search: () => jsonResponse({ results: [{ trackName: "no id" }] }) });
    const err = await failure(new AppStoreSource({ fetchImpl: odd.fetchImpl }).search(BASE_QUERY, signal()));
    expect(err.code).toBe("provider");
    expect(err.message).toContain("unexpected search response");
  });

  it("times out through the signal even when fetch ignores it", async () => {
    const f = fakeFetch(() => forever<Response>());
    const err = await failure(new AppStoreSource({ fetchImpl: f.fetchImpl }).search(BASE_QUERY, AbortSignal.timeout(30)));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
  });

  it("honours a base URL override", async () => {
    const f = appStoreFetch();
    const src = new AppStoreSource({ fetchImpl: f.fetchImpl, baseUrl: "http://127.0.0.1:1/" });
    // The fake routes by pathname only, so the override just changes the origin.
    await src.search(BASE_QUERY, signal());
    expect(f.calls[0]?.url.startsWith("http://127.0.0.1:1/search?")).toBe(true);
  });
});
