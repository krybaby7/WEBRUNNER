import { describe, expect, it } from "vitest";
import {
  addGapLines,
  assertInvariants,
  buildFallbackReport,
  citationOrder,
  clipQuote,
  renumberCitations,
} from "../../../src/core/research/report.js";
import { ResearchError, type Note } from "../../../src/core/research/types.js";
import type { ResearchFinding, ResearchSource } from "../../../src/schemas/deep_research.js";

const src = (id: number): ResearchSource => ({
  id,
  url: `https://example.org/${id}`,
  title: `Source ${id}`,
  accessed_at: "2026-10-18T09:00:00.000Z",
  used_for: `used ${id}`,
});
const finding = (claim: string, ...ids: number[]): ResearchFinding => ({ claim, confidence: "high", source_ids: ids });

describe("renumberCitations", () => {
  const cases: Array<{
    name: string;
    report: string;
    findings: ResearchFinding[];
    sources: number[];
    expectReport: string;
    expectSources: Array<[number, string]>;
    expectFindings: Array<[string, number[]]>;
    dropped?: number[];
  }> = [
    {
      name: "already in order stays as it is",
      report: "A [1]. B [2].\n\n## Gaps\n\n- none",
      findings: [finding("a", 1), finding("b", 2)],
      sources: [1, 2],
      expectReport: "A [1]. B [2].\n\n## Gaps\n\n- none",
      expectSources: [
        [1, "https://example.org/1"],
        [2, "https://example.org/2"],
      ],
      expectFindings: [
        ["a", [1]],
        ["b", [2]],
      ],
    },
    {
      name: "provisional ids are assigned in first-citation order",
      report: "C [3]. A [1]. C again [3]. B [2].",
      findings: [finding("a", 1), finding("b", 2), finding("c", 3)],
      sources: [1, 2, 3],
      expectReport: "C [1]. A [2]. C again [1]. B [3].",
      expectSources: [
        [1, "https://example.org/3"],
        [2, "https://example.org/1"],
        [3, "https://example.org/2"],
      ],
      expectFindings: [
        ["a", [2]],
        ["b", [3]],
        ["c", [1]],
      ],
    },
    {
      name: "uncited sources are dropped, and with them findings that only used them",
      report: "Only the second [2].",
      findings: [finding("one", 1), finding("two", 2), finding("both", 1, 2)],
      sources: [1, 2, 3],
      expectReport: "Only the second [1].",
      expectSources: [[1, "https://example.org/2"]],
      expectFindings: [
        ["two", [1]],
        ["both", [1]],
      ],
    },
    {
      name: "grouped citations keep their form and are remapped",
      report: "Both [4, 2]. Separate [2][4]. Triple [2, 4, 7].",
      findings: [finding("x", 2, 4)],
      sources: [2, 4, 7],
      expectReport: "Both [1, 2]. Separate [2][1]. Triple [2, 1, 3].",
      expectSources: [
        [1, "https://example.org/4"],
        [2, "https://example.org/2"],
        [3, "https://example.org/7"],
      ],
      expectFindings: [["x", [1, 2]]],
    },
    {
      name: "a citation with no source is removed from the text and reported",
      report: "Real [1]. Invented [9]. Mixed [1, 9]. Gone [8, 9].",
      findings: [finding("f", 1, 9)],
      sources: [1],
      expectReport: "Real [1]. Invented. Mixed [1]. Gone.",
      expectSources: [[1, "https://example.org/1"]],
      expectFindings: [["f", [1]]],
      dropped: [8, 9],
    },
    {
      name: "repeated ids in one group collapse",
      report: "Dup [2, 2].",
      findings: [finding("f", 2, 2)],
      sources: [2],
      expectReport: "Dup [1].",
      expectSources: [[1, "https://example.org/2"]],
      expectFindings: [["f", [1]]],
    },
    {
      name: "a report without citations has no sources and no findings",
      report: "Nothing is cited here.",
      findings: [finding("f", 1)],
      sources: [1],
      expectReport: "Nothing is cited here.",
      expectSources: [],
      expectFindings: [],
    },
    {
      name: "findings naming unknown sources lose those ids",
      report: "Cited [1].",
      findings: [finding("f", 5, 1)],
      sources: [1],
      expectReport: "Cited [1].",
      expectSources: [[1, "https://example.org/1"]],
      expectFindings: [["f", [1]]],
    },
  ];

  it.each(cases)("$name", (c) => {
    const out = renumberCitations(c.report, c.findings, c.sources.map(src));
    expect(out.report_markdown).toBe(c.expectReport);
    expect(out.sources.map((s) => [s.id, s.url])).toEqual(c.expectSources);
    expect(out.findings.map((f) => [f.claim, f.source_ids])).toEqual(c.expectFindings);
    expect(out.dropped_citations).toEqual(c.dropped ?? []);
    // Whatever the input, the output satisfies the invariants.
    expect(out.sources.map((s) => s.id)).toEqual(out.sources.map((_, i) => i + 1));
    expect(citationOrder(out.report_markdown)).toEqual(out.sources.map((s) => s.id));
  });

  it("keeps the rest of each source untouched", () => {
    const out = renumberCitations("x [2]", [], [src(1), { ...src(2), published_at: "2025-01-01T00:00:00.000Z" }]);
    expect(out.sources[0]).toEqual({ ...src(2), id: 1, published_at: "2025-01-01T00:00:00.000Z" });
  });
});

describe("assertInvariants", () => {
  const good = {
    report_markdown: "A [1]. B [2][1].\n\n## Gaps\n\n- none\n",
    findings: [finding("a", 1), finding("b", 1, 2)],
    sources: [src(1), src(2)],
  };

  it("accepts a consistent result", () => {
    expect(() => assertInvariants(good)).not.toThrow();
  });

  it("accepts a result with no sources and a Gaps section", () => {
    expect(() => assertInvariants({ report_markdown: "# Q\n\n## Gaps\n\n- x\n", findings: [], sources: [] })).not.toThrow();
  });

  function problemsOf(r: Parameters<typeof assertInvariants>[0]): string[] {
    try {
      assertInvariants(r);
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchError);
      expect((err as ResearchError).code).toBe("internal");
      return (err as ResearchError).details !== undefined ? ((err as ResearchError).details as { problems: string[] }).problems : [];
    }
    throw new Error("expected assertInvariants to throw");
  }

  it("throws when a [n] has no source", () => {
    const p = problemsOf({ ...good, report_markdown: "A [1]. B [2]. C [3].\n\n## Gaps\n" });
    expect(p.join(" ")).toMatch(/citations with no source: \[3\]/);
  });

  it("throws when a finding references a missing source", () => {
    const p = problemsOf({ ...good, findings: [finding("a", 1, 7)] });
    expect(p.join(" ")).toMatch(/missing sources: \[7\]/);
  });

  it("throws when ids are not contiguous from 1", () => {
    const p = problemsOf({ ...good, sources: [src(1), src(3)], report_markdown: "A [1]. B [3].\n\n## Gaps\n" });
    expect(p.join(" ")).toMatch(/not contiguous/);
  });

  it("throws when sources are not numbered in first-citation order", () => {
    const p = problemsOf({ ...good, report_markdown: "A [2]. B [1].\n\n## Gaps\n" });
    expect(p.join(" ")).toMatch(/first-citation order/);
  });

  it("throws when a source is never cited", () => {
    const p = problemsOf({ ...good, report_markdown: "A [1].\n\n## Gaps\n" });
    expect(p.join(" ")).toMatch(/never cited in the report: \[2\]/);
  });

  it("throws when the report has no Gaps section", () => {
    const p = problemsOf({ ...good, report_markdown: "A [1]. B [2]." });
    expect(p.join(" ")).toMatch(/no Gaps section/);
  });

  it("reports every problem at once", () => {
    const p = problemsOf({ report_markdown: "A [4]", findings: [finding("a", 8)], sources: [src(2)] });
    expect(p.length).toBeGreaterThanOrEqual(4);
  });
});

describe("addGapLines", () => {
  it("creates the section when the report has none", () => {
    expect(addGapLines("Body [1].", ["One.", "Two."])).toBe("Body [1].\n\n## Gaps\n\n- One.\n- Two.\n");
  });

  it("appends to an existing last section", () => {
    expect(addGapLines("Body.\n\n## Gaps\n\n- Old.\n", ["New."])).toBe("Body.\n\n## Gaps\n\n- Old.\n- New.\n");
  });

  it("appends inside the Gaps section when other sections follow it", () => {
    const out = addGapLines("## Gaps\n\n- Old.\n\n## Appendix\n\nMore.\n", ["New."]);
    expect(out).toBe("## Gaps\n\n- Old.\n- New.\n\n## Appendix\n\nMore.\n");
  });

  it("skips lines already present and is a no-op without lines", () => {
    const report = "x\n\n## Gaps\n\n- Old.\n";
    expect(addGapLines(report, ["Old."])).toBe(report);
    expect(addGapLines(report, [])).toBe(report);
  });
});

describe("clipQuote", () => {
  it("cuts to 300 characters and never rejects", () => {
    expect(clipQuote("a".repeat(500))).toHaveLength(300);
    expect(clipQuote("  short  ")).toBe("short");
  });
});

describe("buildFallbackReport", () => {
  const note = (id: number, relevance: number, texts: string[]): Note => ({
    source_id: id,
    url: `https://example.org/${id}`,
    title: `Note ${id}`,
    accessed_at: "2026-10-18T09:00:00.000Z",
    relevance,
    claims: texts.map((t) => ({ text: t, quote: `q: ${t}`, confidence: "medium" as const })),
  });

  it("lists the most relevant claims with citations and keeps a Gaps section", () => {
    const out = buildFallbackReport({
      question: "Q?",
      output: "report",
      notes: [note(1, 5, ["low"]), note(2, 9, ["high one", "high two"])],
      gaps: ["Unknown thing."],
    });
    const lines = out.report_markdown.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual(["- high one [2]", "- high two [2]", "- low [1]", "- Unknown thing."]);
    expect(out.findings[0]).toMatchObject({ claim: "high one", source_ids: [2], quote: "q: high one" });
    expect(out.sources.map((s) => s.id)).toEqual([1, 2]);
  });

  it("caps the brief at 8 claims", () => {
    const many = note(1, 9, Array.from({ length: 20 }, (_, i) => `claim ${i}`));
    const out = buildFallbackReport({ question: "Q?", output: "brief", notes: [many], gaps: [] });
    expect(out.findings).toHaveLength(8);
  });
});
