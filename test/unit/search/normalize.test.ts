import { describe, expect, it } from "vitest";
import { normalizePublishedAt } from "../../../src/core/search/normalize.js";

const cases: Array<[label: string, input: unknown, expected: string | undefined]> = [
  ["RFC 2822 with GMT", "Tue, 11 Mar 2025 17:00:00 GMT", "2025-03-11T17:00:00.000Z"],
  ["RFC 2822 with numeric offset", "Tue, 11 Mar 2025 12:00:00 -0500", "2025-03-11T17:00:00.000Z"],
  ["ISO 8601 with Z", "2025-03-11T17:00:00Z", "2025-03-11T17:00:00.000Z"],
  ["ISO 8601 with milliseconds", "2025-03-11T17:00:00.123Z", "2025-03-11T17:00:00.123Z"],
  ["ISO 8601 with positive offset", "2025-03-11T18:30:00+01:30", "2025-03-11T17:00:00.000Z"],
  ["ISO 8601 with negative offset", "2025-09-25T10:00:00-05:00", "2025-09-25T15:00:00.000Z"],
  ["ISO 8601 without zone is read as UTC", "2025-03-11T17:00:00", "2025-03-11T17:00:00.000Z"],
  ["space-separated date-time without zone is read as UTC", "2025-03-04 08:30", "2025-03-04T08:30:00.000Z"],
  ["date-only becomes midnight UTC", "2025-03-11", "2025-03-11T00:00:00.000Z"],
  ["month-name date without zone is read as UTC", "Mar 3, 2025", "2025-03-03T00:00:00.000Z"],
  ["long month-name date", "March 3, 2025", "2025-03-03T00:00:00.000Z"],
  ["surrounding whitespace is trimmed", "  2025-03-11  ", "2025-03-11T00:00:00.000Z"],
  ["epoch seconds as number", 1741712400, "2025-03-11T17:00:00.000Z"],
  ["epoch milliseconds as number", 1741712400000, "2025-03-11T17:00:00.000Z"],
  ["epoch seconds as digit string", "1741712400", "2025-03-11T17:00:00.000Z"],
  ["Date instance", new Date("2025-03-11T17:00:00Z"), "2025-03-11T17:00:00.000Z"],
  ["garbage string", "not a date", undefined],
  ["garbage with a stray digit", "foo 2", undefined],
  ["relative human string", "2 weeks ago", undefined],
  ["placeholder string", "n/a", undefined],
  ["empty string", "", undefined],
  ["whitespace only", "   ", undefined],
  ["null", null, undefined],
  ["undefined", undefined, undefined],
  ["zero", 0, undefined],
  ["negative number", -5, undefined],
  ["NaN", Number.NaN, undefined],
  ["Infinity", Number.POSITIVE_INFINITY, undefined],
  ["invalid Date instance", new Date("nope"), undefined],
  ["object", { date: "2025-03-11" }, undefined],
  ["boolean", true, undefined],
  ["impossible calendar date", "2025-13-45", undefined],
];

describe("normalizePublishedAt", () => {
  it.each(cases)("%s", (_label, input, expected) => {
    expect(normalizePublishedAt(input)).toBe(expected);
  });

  it("always emits the YYYY-MM-DDTHH:mm:ss.sssZ shape when it returns a value", () => {
    for (const [, input, expected] of cases) {
      const out = normalizePublishedAt(input);
      if (expected !== undefined) expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("does not depend on the machine's time zone", () => {
    const original = process.env["TZ"];
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
        process.env["TZ"] = tz;
        expect(normalizePublishedAt("2025-03-11T17:00:00")).toBe("2025-03-11T17:00:00.000Z");
        expect(normalizePublishedAt("Mar 3, 2025")).toBe("2025-03-03T00:00:00.000Z");
        expect(normalizePublishedAt("2025-03-11")).toBe("2025-03-11T00:00:00.000Z");
      }
    } finally {
      if (original === undefined) delete process.env["TZ"];
      else process.env["TZ"] = original;
    }
  });
});
