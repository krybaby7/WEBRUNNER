import { describe, expect, it } from "vitest";
import { clipText, compareSocialItems, finalizeItem, mergeSocialItems, safeAuthor } from "../../../src/core/social/merge.js";
import { SOCIAL_TEXT_MAX_CHARS, type SocialItem } from "../../../src/schemas/social.js";
import { item } from "./helpers.js";

const a = item({ id: "hackernews:a", score: 50, created_at: "2026-10-10T00:00:00.000Z" });
const b = item({ id: "reddit:b", platform: "reddit", score: 90, created_at: "2026-10-01T00:00:00.000Z" });
const c = item({ id: "bluesky:c", platform: "bluesky", score: 50, created_at: "2026-10-12T00:00:00.000Z" });
const noScore = item({ id: "youtube:d", platform: "youtube", created_at: "2026-10-15T00:00:00.000Z" });
const noDate = item({ id: "hackernews:e", score: 70 });
const nothing = item({ id: "hackernews:f" });

describe("mergeSocialItems", () => {
  it.each<{ name: string; items: SocialItem[]; sort: "engagement" | "recent"; max: number; ids: string[] }>([
    {
      name: "engagement: score desc, unknown scores last, ties by newest",
      items: [a, b, c, noScore, noDate, nothing],
      sort: "engagement",
      max: 30,
      ids: ["reddit:b", "hackernews:e", "bluesky:c", "hackernews:a", "youtube:d", "hackernews:f"],
    },
    {
      name: "recent: created_at desc, unknown dates last",
      items: [a, b, c, noScore, noDate, nothing],
      sort: "recent",
      max: 30,
      ids: ["youtube:d", "bluesky:c", "hackernews:a", "reddit:b", "hackernews:e", "hackernews:f"],
    },
    {
      name: "max_results cuts after sorting",
      items: [a, b, c],
      sort: "engagement",
      max: 2,
      ids: ["reddit:b", "bluesky:c"],
    },
    {
      name: "duplicate URLs keep the first occurrence",
      items: [a, { ...b, url: a.url }, c],
      sort: "engagement",
      max: 30,
      ids: ["bluesky:c", "hackernews:a"],
    },
    {
      name: "empty input",
      items: [],
      sort: "recent",
      max: 10,
      ids: [],
    },
  ])("$name", ({ items, sort, max, ids }) => {
    expect(mergeSocialItems(items, sort, max).map((i) => i.id)).toEqual(ids);
  });

  it("is a total order: ties on score and date fall back to the id", () => {
    const x = item({ id: "hackernews:x", score: 1, created_at: "2026-01-01T00:00:00.000Z" });
    const y = item({ id: "hackernews:y", score: 1, created_at: "2026-01-01T00:00:00.000Z" });
    expect(compareSocialItems("engagement", x, y)).toBeLessThan(0);
    expect(compareSocialItems("engagement", y, x)).toBeGreaterThan(0);
    expect(compareSocialItems("recent", x, x)).toBe(0);
  });

  it("clips over-long text and drops email-like authors on the way through", () => {
    const long = item({ id: "hackernews:long", text: "x".repeat(SOCIAL_TEXT_MAX_CHARS + 10), author: "someone@example.com" });
    const [out] = mergeSocialItems([long], "engagement", 5);
    expect(out?.text).toHaveLength(SOCIAL_TEXT_MAX_CHARS);
    expect(out?.truncated).toBe(true);
    expect("author" in (out ?? {})).toBe(false);
    // Already-valid items are returned as they are.
    expect(finalizeItem(a)).toBe(a);
  });
});

describe("clipText and safeAuthor", () => {
  it("clipText normalises line endings and cuts at the limit", () => {
    expect(clipText("  a\r\nb  ")).toEqual({ text: "a\nb", truncated: false });
    expect(clipText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(clipText("abc ", 3)).toEqual({ text: "abc", truncated: false });
  });

  it("safeAuthor never returns an email address", () => {
    expect(safeAuthor("tazjin")).toBe("tazjin");
    expect(safeAuthor("  ")).toBeUndefined();
    expect(safeAuthor(null)).toBeUndefined();
    expect(safeAuthor("owner@example.com")).toBeUndefined();
    expect(safeAuthor("Jane <jane@example.org>")).toBeUndefined();
  });
});
