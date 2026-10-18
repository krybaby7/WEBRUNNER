import { describe, expect, it } from "vitest";
import { filterReviews, interleave, mergeReviews, sortReviews } from "../../../src/core/reviews/merge.js";
import type { NormalizedReviewsQuery, Review, ReviewSort } from "../../../src/schemas/reviews.js";
import { BASE_QUERY, NOW, review } from "./helpers.js";

const day = 86_400_000;
const at = (daysAgo: number): string => new Date(NOW - daysAgo * day).toISOString();

const A = [
  review("app_store", "a1", { rating: 5, created_at: at(1) }),
  review("app_store", "a2", { rating: 2, created_at: at(10) }),
  review("app_store", "a3", { rating: 4, created_at: at(40) }),
];
const B = [
  review("trustpilot", "b1", { rating: 1, created_at: at(3) }),
  review("trustpilot", "b2", { rating: 3.5, created_at: at(400) }),
];
const unrated = review("trustpilot", "u", { rating: undefined, created_at: at(10) });
const undated = review("trustpilot", "d", { created_at: undefined });

describe("filterReviews", () => {
  it.each<[Partial<NormalizedReviewsQuery>, string[], number, number]>([
    [{}, ["a1", "a2", "a3", "b1", "b2", "u", "d"], 0, 0],
    [{ min_rating: 4 }, ["a1", "a3", "d"], 1, 0],
    [{ max_rating: 2 }, ["a2", "b1"], 1, 0],
    [{ min_rating: 2, max_rating: 4 }, ["a2", "a3", "b2", "d"], 1, 0],
    [{ min_rating: 3.5, max_rating: 3.5 }, ["b2"], 1, 0],
    [{ recency: "day" }, ["a1"], 0, 1],
    [{ recency: "week" }, ["a1", "b1"], 0, 1],
    [{ recency: "month" }, ["a1", "a2", "b1", "u"], 0, 1],
    [{ recency: "year" }, ["a1", "a2", "a3", "b1", "u"], 0, 1],
    [{ recency: "month", min_rating: 3 }, ["a1"], 1, 1],
  ])("%j keeps %j", (over, ids, droppedUnrated, droppedUndated) => {
    const out = filterReviews([...A, ...B, unrated, undated], { ...BASE_QUERY, ...over }, NOW);
    expect(out.kept.map((r) => r.id.split(":")[1])).toEqual(ids);
    expect(out.droppedUnrated).toBe(droppedUnrated);
    expect(out.droppedUndated).toBe(droppedUndated);
  });
});

describe("sortReviews", () => {
  const ids = (rs: Review[]): string[] => rs.map((r) => r.id.split(":")[1] as string);

  it("interleaves sources round-robin", () => {
    expect(interleave([[1, 2, 3], [10, 20], [], [100]])).toEqual([1, 10, 100, 2, 20, 3]);
  });

  it.each<[ReviewSort, string[]]>([
    ["relevance", ["a1", "b1", "a2", "b2", "a3", "u", "d"]],
    ["recent", ["a1", "b1", "a2", "u", "a3", "b2", "d"]],
    ["rating_low", ["b1", "a2", "b2", "a3", "d", "a1", "u"]],
    ["rating_high", ["a1", "a3", "d", "b2", "a2", "b1", "u"]],
  ])("%s", (sort, expected) => {
    // `u` has no rating (dated 10 days ago, like a2) and `d` has no date (rated 4, like a3).
    expect(ids(sortReviews([A, [...B, unrated, undated]], sort))).toEqual(expected);
  });

  it("is stable for ties", () => {
    const tied = [review("app_store", "x", { rating: 4 }), review("app_store", "y", { rating: 4 })];
    expect(ids(sortReviews([tied, [review("trustpilot", "z", { rating: 4 })]], "rating_high"))).toEqual(["x", "z", "y"]);
  });
});

describe("mergeReviews", () => {
  const q: NormalizedReviewsQuery = { ...BASE_QUERY, sources: ["trustpilot", "app_store"] };
  const results = [
    { source: "app_store" as const, reviews: A },
    { source: "trustpilot" as const, reviews: B },
  ];

  it("follows the query's source order, interleaves and reports nothing omitted when everything fits", () => {
    const out = mergeReviews(results, q, NOW);
    expect(out.reviews.map((r) => r.id)).toEqual(["trustpilot:b1", "app_store:a1", "trustpilot:b2", "app_store:a2", "app_store:a3"]);
    expect(out.omitted).toBe(0);
  });

  it.each<[number, number, number]>([
    [1, 1, 4],
    [2, 2, 3],
    [5, 5, 0],
    [100, 5, 0],
  ])("max_results %d keeps %d and omits %d", (max, kept, omitted) => {
    const out = mergeReviews(results, { ...q, max_results: max }, NOW);
    expect(out.reviews).toHaveLength(kept);
    expect(out.omitted).toBe(omitted);
  });

  it("applies the filters before the cut and counts what they dropped", () => {
    const out = mergeReviews([...results, { source: "trustpilot", reviews: [unrated] }], { ...q, min_rating: 4, max_results: 1 }, NOW);
    expect(out.reviews.map((r) => r.id)).toEqual(["app_store:a1"]);
    expect(out.omitted).toBe(1);
    expect(out.droppedUnrated).toBe(0); // the second trustpilot entry is ignored: one entry per source
  });

  it("drops a duplicate id within the merged list", () => {
    const dup = [review("app_store", "a1", { rating: 1 }), review("app_store", "a1", { rating: 5 })];
    const out = mergeReviews([{ source: "app_store", reviews: dup }], { ...q, sources: ["app_store"] }, NOW);
    expect(out.reviews).toHaveLength(1);
    expect(out.reviews[0]?.rating).toBe(1);
  });

  it("ignores results for sources the query did not ask for", () => {
    const out = mergeReviews(results, { ...q, sources: ["app_store"] }, NOW);
    expect(out.reviews.every((r) => r.source === "app_store")).toBe(true);
  });
});
