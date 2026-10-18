import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_SYSTEM,
  ExtractSchema,
  PLANNER_SYSTEM,
  PROMPT_VERSION,
  PlanSchema,
  SCORER_SYSTEM,
  ScoreSchema,
  WRITER_SYSTEM,
  WriterSchema,
  extractorPrompt,
  plannerPrompt,
  scorerPrompt,
  writerPrompt,
} from "../../../src/core/research/prompts.js";
import type { Candidate, Note } from "../../../src/core/research/types.js";

const note = (id: number): Note => ({
  source_id: id,
  url: `https://example.org/${id}`,
  title: `Title ${id}`,
  published_at: "2026-01-02T00:00:00.000Z",
  accessed_at: "2026-10-18T09:00:00.000Z",
  relevance: 8,
  claims: [{ text: `Claim text ${id}`, quote: `Quote text ${id}`, confidence: "high" }],
});

describe("prompts", () => {
  it("has a version string", () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("names no model and no provider in any system prompt", () => {
    for (const s of [PLANNER_SYSTEM, SCORER_SYSTEM, EXTRACTOR_SYSTEM, WRITER_SYSTEM]) {
      expect(s).not.toMatch(/claude|opus|sonnet|haiku|anthropic|gpt|gemini|llama/i);
    }
  });

  it("tells every model to treat page text as data", () => {
    for (const s of [PLANNER_SYSTEM, SCORER_SYSTEM, EXTRACTOR_SYSTEM, WRITER_SYSTEM]) {
      expect(s).toMatch(/untrusted data/);
    }
  });

  it("all output schemas convert to JSON schema for structured output", () => {
    for (const schema of [PlanSchema, ScoreSchema, ExtractSchema, WriterSchema]) {
      expect(() => zodOutputFormat(schema)).not.toThrow();
    }
  });

  it("planner: question and notes go in the user message, the system prompt stays fixed", () => {
    const a = plannerPrompt({
      question: "Q one?",
      recency: "week",
      focusDomains: ["a.org"],
      excludeDomains: ["b.org"],
      notes: [note(1)],
      gaps: ["gap one"],
      previousQueries: ["old query"],
      round: 2,
      maxRounds: 3,
      searchesLeft: 7,
    });
    const b = plannerPrompt({ question: "Q two?", notes: [], gaps: [], previousQueries: [], round: 1, maxRounds: 3, searchesLeft: 12 });
    expect(a.system).toBe(b.system);
    expect(a.system).not.toContain("Q one?");
    expect(a.user).toContain("Q one?");
    expect(a.user).toContain("last week");
    expect(a.user).toContain("a.org");
    expect(a.user).toContain("b.org");
    expect(a.user).toContain("gap one");
    expect(a.user).toContain("old query");
    expect(a.user).toContain("Claim text 1");
    expect(a.user).toContain("round 2 of at most 3");
    expect(a.user).toContain("7 queries");
    expect(b.user).toContain("(no notes yet)");
    expect(PLANNER_SYSTEM).toMatch(/between 2 and 6/);
  });

  it("planner: a very large note set is cut with a visible marker", () => {
    const many = Array.from({ length: 2000 }, (_, i) => note(i + 1));
    const p = plannerPrompt({ question: "Q?", notes: many, gaps: [], previousQueries: [], round: 2, maxRounds: 3, searchesLeft: 5 });
    expect(p.user.length).toBeLessThan(80_000);
    expect(p.user).toMatch(/further notes omitted/);
  });

  it("scorer: numbers candidates from zero and clips long snippets", () => {
    const candidates: Candidate[] = [
      { url: "https://a.org/x", title: "A", snippet: "s".repeat(2000), published_at: "2026-05-05T00:00:00.000Z" },
      { url: "https://b.org/y", title: "B", snippet: "short" },
    ];
    const p = scorerPrompt({ question: "Q?", recency: "month", candidates });
    expect(p.user).toMatch(/^#0 \| A \| https:\/\/a\.org\/x \| 2026-05-05T00:00:00\.000Z$/m);
    expect(p.user).toMatch(/^#1 \| B \| https:\/\/b\.org\/y \| date unknown$/m);
    expect(p.user).not.toContain("s".repeat(500));
    expect(p.user).toContain("last month");
    expect(p.user).toContain("Score all 2 candidates");
    expect(SCORER_SYSTEM).toMatch(/primary/);
  });

  it("extractor: carries the page between markers and states the 300 character quote limit", () => {
    const p = extractorPrompt({ question: "Q?", url: "https://a.org", title: "T", markdown: "# Page body\n\n- fact", truncated: true });
    expect(p.user).toContain("<page>\n# Page body\n\n- fact\n</page>");
    expect(p.user).toContain("cut off");
    expect(EXTRACTOR_SYSTEM).toMatch(/300 characters/);
    expect(EXTRACTOR_SYSTEM).toMatch(/ISO 8601 UTC/);
    expect(EXTRACTOR_SYSTEM).toMatch(/verbatim/);
  });

  it("writer: keys notes by id, states the output format and requires a Gaps section", () => {
    const p = writerPrompt({
      question: "Q?",
      output: "brief",
      notes: [note(3), note(5)],
      gaps: ["still open"],
      stopNote: "Stopped early.",
      today: "2026-10-18",
    });
    expect(p.user).toMatch(/^\[3\] Title 3$/m);
    expect(p.user).toMatch(/^\[5\] Title 5$/m);
    expect(p.user).toContain("brief (at most 300 words");
    expect(p.user).toContain("still open");
    expect(p.user).toContain("Stopped early.");
    expect(p.user).toContain("Today's date: 2026-10-18");
    expect(WRITER_SYSTEM).toMatch(/## Gaps/);
    expect(WRITER_SYSTEM).toMatch(/300 words/);
    expect(WRITER_SYSTEM).toMatch(/Every factual sentence/);
    expect(writerPrompt({ question: "Q?", output: "report", notes: [note(1)], gaps: [], today: "2026-10-18" }).user).toContain(
      "report (full Markdown report)",
    );
  });
});
