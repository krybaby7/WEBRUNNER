import { describe, expect, it } from "vitest";
import {
  kindsDefaultingTo,
  normalizeRating,
  normalizeReviewsInput,
  parseHttpUrl,
  parseReviewDate,
  reviewId,
  truncateReviewText,
  type RatingScale,
} from "../../../src/core/reviews/normalize.js";
import {
  DEFAULT_SOURCES_BY_KIND,
  NormalizedReviewsQuerySchema,
  REVIEW_KINDS,
  REVIEW_SOURCES,
  REVIEW_TEXT_MAX_CHARS,
  type ReviewKind,
  type ReviewSource,
} from "../../../src/schemas/reviews.js";
import { NOW, parsedInput } from "./helpers.js";

const ALL = [...REVIEW_SOURCES];

describe("normalizeReviewsInput", () => {
  it("keeps a name as the subject with no subject_url", () => {
    const q = normalizeReviewsInput(parsedInput({ subject: "  Notion  " }), { configuredSources: ALL });
    expect(q.subject).toBe("Notion");
    expect(q.subject_url).toBeUndefined();
    expect(NormalizedReviewsQuerySchema.safeParse(q).success).toBe(true);
  });

  it("sets subject_url when the subject is an http(s) URL, and not for other schemes", () => {
    const url = normalizeReviewsInput(parsedInput({ subject: "https://apps.apple.com/us/app/id1232780281" }), { configuredSources: ALL });
    expect(url.subject_url).toBe("https://apps.apple.com/us/app/id1232780281");
    const ftp = normalizeReviewsInput(parsedInput({ subject: "ftp://example.org/file" }), { configuredSources: ALL });
    expect(ftp.subject_url).toBeUndefined();
    expect(parseHttpUrl("not a url")).toBeUndefined();
    expect(parseHttpUrl("HTTP://Example.org/A")).toBe("http://example.org/A");
  });

  it.each(REVIEW_KINDS.map((k) => [k] as const))("kind %s defaults to the sources the plan lists when all are configured", (kind) => {
    const q = normalizeReviewsInput(parsedInput({ kind }), { configuredSources: ALL });
    expect(q.sources).toEqual([...DEFAULT_SOURCES_BY_KIND[kind]]);
    expect(q.kind).toBe(kind);
  });

  it.each<[ReviewKind, ReviewSource[], ReviewSource[]]>([
    ["app", ["trustpilot", "app_store"], ["app_store"]],
    ["business", ["app_store", "trustpilot"], ["trustpilot"]],
    ["product", ["trustpilot", "app_store"], ["trustpilot"]],
    ["any", ["trustpilot", "app_store"], ["trustpilot", "app_store"]],
    // No default source for the kind is configured: every configured source answers.
    ["place", ["app_store", "trustpilot"], ["app_store", "trustpilot"]],
    ["app", ["trustpilot"], ["trustpilot"]],
  ])("kind %s with configured %j gives %j", (kind, configured, expected) => {
    const q = normalizeReviewsInput(parsedInput({ kind }), { configuredSources: configured });
    expect(q.sources).toEqual(expected);
  });

  it("keeps an explicit source list as given (deduplicated), even when unconfigured", () => {
    const q = normalizeReviewsInput(parsedInput({ sources: ["amazon", "app_store", "amazon"] }), { configuredSources: ["trustpilot"] });
    expect(q.sources).toEqual(["amazon", "app_store"]);
  });

  it("refuses to run with nothing configured and no explicit sources", () => {
    expect(() => normalizeReviewsInput(parsedInput(), { configuredSources: [] })).toThrow(RangeError);
  });

  it("carries filters, sort, limits, trimmed location and the lowercased storefront", () => {
    const q = normalizeReviewsInput(
      parsedInput({
        location: " Paris ",
        max_results: 7,
        per_source: 3,
        min_rating: 2,
        max_rating: 4,
        recency: "month",
        sort: "recent",
        app_store_country: "GB",
      }),
      { configuredSources: ALL },
    );
    expect(q).toMatchObject({
      location: "Paris",
      max_results: 7,
      per_source: 3,
      min_rating: 2,
      max_rating: 4,
      recency: "month",
      sort: "recent",
      app_store_country: "gb",
    });
    expect(NormalizedReviewsQuerySchema.safeParse(q).success).toBe(true);
  });
});

describe("kindsDefaultingTo", () => {
  it("inverts the plan's table", () => {
    expect(kindsDefaultingTo("app_store")).toEqual(["app", "any"]);
    expect(kindsDefaultingTo("trustpilot")).toEqual(["business", "product", "any"]);
    expect(kindsDefaultingTo("google_maps")).toEqual(["place", "business", "any"]);
    expect(kindsDefaultingTo("amazon")).toEqual(["product", "any"]);
  });
});

describe("normalizeRating", () => {
  it.each<[number, RatingScale, number | undefined]>([
    [5, 5, 5],
    [4, 5, 4],
    [3.5, 5, 3.5],
    [3.3, 5, 3.5],
    [3.2, 5, 3],
    [1, 5, 1],
    [6, 5, 5],
    // 10-point scales are halved
    [10, 10, 5],
    [8, 10, 4],
    [7, 10, 3.5],
    [2, 10, 1],
    [1, 10, 1],
    // percentages are divided by 20
    [100, 100, 5],
    [90, 100, 4.5],
    [85, 100, 4.5],
    [20, 100, 1],
    [10, 100, 1],
    // nothing to normalise
    [0, 5, undefined],
    [-1, 5, undefined],
    [Number.NaN, 5, undefined],
    [Number.POSITIVE_INFINITY, 10, undefined],
  ])("%d on a %d-point scale is %s", (value, scale, expected) => {
    expect(normalizeRating(value, scale)).toBe(expected);
  });

  it("defaults to the five-star scale", () => {
    expect(normalizeRating(4.4)).toBe(4.5);
  });
});

describe("truncateReviewText", () => {
  it("leaves short text alone apart from whitespace", () => {
    expect(truncateReviewText("  Great \t app \r\n\r\n\r\n\r\nreally  ")).toEqual({ text: "Great app\n\nreally", truncated: false });
  });

  it("cuts at REVIEW_TEXT_MAX_CHARS and says so", () => {
    const out = truncateReviewText("x".repeat(REVIEW_TEXT_MAX_CHARS + 50));
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(REVIEW_TEXT_MAX_CHARS);
  });
});

describe("parseReviewDate", () => {
  const day = 86_400_000;
  it.each<[string, { iso: string; approximate: boolean } | undefined]>([
    ["2026-10-02T10:11:12.000Z", { iso: "2026-10-02T10:11:12.000Z", approximate: false }],
    ["2026-10-15T17:37:32-07:00", { iso: "2026-10-16T00:37:32.000Z", approximate: false }],
    // A date with no zone is read as UTC midnight, whatever the server's time zone.
    ["Oct 2, 2026", { iso: "2026-10-02T00:00:00.000Z", approximate: false }],
    ["2 months ago", { iso: new Date(NOW - 60 * day).toISOString(), approximate: true }],
    ["2 weeks ago", { iso: new Date(NOW - 14 * day).toISOString(), approximate: true }],
    ["a day ago", { iso: new Date(NOW - day).toISOString(), approximate: true }],
    ["an hour ago", { iso: new Date(NOW - 3600_000).toISOString(), approximate: true }],
    ["Updated 3 days ago", { iso: new Date(NOW - 3 * day).toISOString(), approximate: true }],
    ["yesterday", { iso: new Date(NOW - day).toISOString(), approximate: true }],
    ["just now", { iso: new Date(NOW).toISOString(), approximate: true }],
    ["", undefined],
    ["sometime", undefined],
  ])("%j", (raw, expected) => {
    expect(parseReviewDate(raw, NOW)).toEqual(expected);
  });
});

describe("reviewId", () => {
  it("uses the native id when there is one, else a 12-hex hash of the fallback", () => {
    expect(reviewId("app_store", "14671531500", "ignored")).toBe("app_store:14671531500");
    expect(reviewId("trustpilot", "  ", "same text")).toMatch(/^trustpilot:[0-9a-f]{12}$/);
    expect(reviewId("trustpilot", undefined, "same text")).toBe(reviewId("trustpilot", "", "same text"));
    expect(reviewId("trustpilot", undefined, "other text")).not.toBe(reviewId("trustpilot", undefined, "same text"));
  });
});
