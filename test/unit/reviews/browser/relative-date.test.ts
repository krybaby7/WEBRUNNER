import { describe, expect, it } from "vitest";
import { APPROXIMATE_DATE_CAVEAT, looksRelative, parseReviewDate } from "../../../../src/core/reviews/relative-date.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;

describe("parseReviewDate", () => {
  it.each([
    ["a day ago", NOW - DAY],
    ["an hour ago", NOW - 3_600_000],
    ["3 weeks ago", NOW - 21 * DAY],
    ["2 months ago", NOW - 60 * DAY],
    ["a year ago", NOW - 365 * DAY],
    ["Edited 2 days ago", NOW - 2 * DAY],
    ["Updated 5 minutes ago", NOW - 5 * 60_000],
    ["about 3 hours ago", NOW - 3 * 3_600_000],
    ["one week ago", NOW - 7 * DAY],
    ["yesterday", NOW - DAY],
    ["today", NOW],
    ["just now", NOW],
    ["2 months ago on Google", undefined],
  ])("approximates %j", (text, expectedMs) => {
    const parsed = parseReviewDate(text, NOW);
    if (expectedMs === undefined) {
      expect(parsed).toBeUndefined();
      return;
    }
    expect(parsed).toEqual({ iso: new Date(expectedMs).toISOString(), approximate: true });
  });

  it.each([
    ["March 3, 2026", "2026-03-03T00:00:00.000Z"],
    ["Reviewed in the United States on March 3, 2026", "2026-03-03T00:00:00.000Z"],
    ["Reviewed in the United Kingdom on February 14, 2026", "2026-02-14T00:00:00.000Z"],
    ["February 26, 2026", "2026-02-26T00:00:00.000Z"],
    ["Sept 1, 2025", "2025-09-01T00:00:00.000Z"],
    ["3 March 2026", "2026-03-03T00:00:00.000Z"],
    ["2026-03-03", "2026-03-03T00:00:00.000Z"],
    ["2026-03-03T10:15:00Z", "2026-03-03T10:15:00.000Z"],
    ["2026-03-03T10:15:00+02:00", "2026-03-03T08:15:00.000Z"],
    ["2026-03-03 10:15", "2026-03-03T10:15:00.000Z"],
  ])("reads %j exactly, in UTC", (text, iso) => {
    expect(parseReviewDate(text, NOW)).toEqual({ iso, approximate: false });
  });

  it.each(["", "   ", "Local Guide", "February 31, 2026", "Smarch 3, 2026", "5 stars", "Response from the owner"])("rejects %j", (text) => {
    expect(parseReviewDate(text, NOW)).toBeUndefined();
  });

  it("flags relative phrases", () => {
    expect(looksRelative("2 months ago")).toBe(true);
    expect(looksRelative("Edited a day ago")).toBe(true);
    expect(looksRelative("yesterday")).toBe(true);
    expect(looksRelative("March 3, 2026")).toBe(false);
  });

  it("has a caveat sentence for the tool", () => {
    expect(APPROXIMATE_DATE_CAVEAT).toMatch(/approximate/);
    expect(APPROXIMATE_DATE_CAVEAT).toMatch(/2 months ago/);
  });
});

describe("one date parser for every review source", () => {
  it("normalize.ts re-exports it, so API, fetch and browser sources read dates alike", async () => {
    const normalize = await import("../../../../src/core/reviews/normalize.js");
    expect(normalize.parseReviewDate).toBe(parseReviewDate);
    expect(normalize.APPROXIMATE_DATE_CAVEAT).toBe(APPROXIMATE_DATE_CAVEAT);
  });

  it("reads month-name dates in UTC whatever the server's zone, and zoned RFC 2822 dates", () => {
    expect(parseReviewDate("Oct 2, 2026", NOW)).toEqual({ iso: "2026-10-02T00:00:00.000Z", approximate: false });
    expect(parseReviewDate("Tue, 20 Oct 2026 08:19:14 GMT", NOW)).toEqual({ iso: "2026-10-20T08:19:14.000Z", approximate: false });
    expect(parseReviewDate("Tue, 20 Oct 2026 08:19:14 +0200", NOW)).toEqual({ iso: "2026-10-20T06:19:14.000Z", approximate: false });
    // A date-time with no zone that is not ISO stays unparsed rather than taking the server's zone.
    expect(parseReviewDate("10/20/2026 08:19", NOW)).toBeUndefined();
  });
});
