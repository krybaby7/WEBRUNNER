import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmRequest, LlmResponse } from "../../../src/core/llm/types.js";
import {
  MAX_REPORT_CHARS,
  extractCitations,
  judgeReport,
  truncateReport,
  type Verdict,
} from "../../evals/research/judge.js";
import { formatTable, runEvals, writeJsonReport, type EvalProgress } from "../../evals/research/run.js";
import {
  CRITERION_KINDS,
  DeepResearchResultSchema,
  QUESTION_TYPES,
  QuestionItemSchema,
  QuestionsFileSchema,
  loadQuestions,
  type DeepResearchResult,
  type Depth,
  type QuestionItem,
} from "../../evals/research/schema.js";

function fixture(name: string): DeepResearchResult {
  const raw: unknown = JSON.parse(readFileSync(new URL(`../../fixtures/evals/${name}`, import.meta.url), "utf8"));
  return DeepResearchResultSchema.parse(raw);
}

const GOOD = fixture("result-good.json");
const DANGLING = fixture("result-dangling-citation.json");

const tmp = mkdtempSync(join(tmpdir(), "webrunner-evals-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// questions.json
// ---------------------------------------------------------------------------

describe("questions.json", () => {
  const items = loadQuestions();

  it("validates against the schema and has exactly 20 items", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("../../evals/research/questions.json", import.meta.url), "utf8"));
    expect(QuestionsFileSchema.safeParse(raw).success).toBe(true);
    expect(items).toHaveLength(20);
  });

  it("has unique question ids", () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("has the required type mix", () => {
    const count = (type: string): number => items.filter((i) => i.type === type).length;
    expect(count("recent_event")).toBeGreaterThanOrEqual(4);
    expect(count("technical_comparison")).toBe(4);
    expect(count("numeric_fact")).toBe(3);
    expect(count("multi_hop")).toBe(4);
    expect(count("how_to")).toBe(3);
    expect(count("controversial_or_contested")).toBe(2);
    for (const item of items) expect(QUESTION_TYPES).toContain(item.type);
  });

  it("has 3 to 6 criteria per item, valid weights and kinds, and unique criterion ids", () => {
    for (const item of items) {
      expect(item.rubric.length, item.id).toBeGreaterThanOrEqual(3);
      expect(item.rubric.length, item.id).toBeLessThanOrEqual(6);
      expect(new Set(item.rubric.map((c) => c.id)).size, item.id).toBe(item.rubric.length);
      for (const c of item.rubric) {
        expect([1, 2, 3], `${item.id}/${c.id}`).toContain(c.weight);
        expect(CRITERION_KINDS, `${item.id}/${c.id}`).toContain(c.kind);
      }
    }
  });

  it("gives every question a source-related criterion and notes for the human judge", () => {
    for (const item of items) {
      expect(item.rubric.some((c) => c.kind === "must_cite"), item.id).toBe(true);
      expect(item.notes.length, item.id).toBeGreaterThan(40);
    }
  });

  it("makes recent-event rubrics depend on the 60-day window and contested rubrics require uncertainty", () => {
    for (const item of items.filter((i) => i.type === "recent_event")) {
      expect(item.rubric.some((c) => /60[- ]day/.test(c.criterion)), item.id).toBe(true);
    }
    for (const item of items.filter((i) => i.type === "controversial_or_contested")) {
      expect(item.rubric.some((c) => c.kind === "must_acknowledge_uncertainty"), item.id).toBe(true);
    }
  });

  it("rejects malformed items", () => {
    const good = items[0] as QuestionItem;
    const bad = (patch: Record<string, unknown>): boolean =>
      QuestionItemSchema.safeParse({ ...good, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ id: "Not A Slug" })).toBe(false);
    expect(bad({ rubric: good.rubric.slice(0, 2) })).toBe(false);
    expect(bad({ rubric: [good.rubric[0], good.rubric[0], good.rubric[1]] })).toBe(false); // duplicate criterion ids
    expect(bad({ rubric: good.rubric.map((c) => ({ ...c, weight: 4 })) })).toBe(false);
    expect(bad({ type: "trivia" })).toBe(false);
    expect(bad({ depth: "extreme" })).toBe(false);
    expect(QuestionsFileSchema.safeParse([good, good]).success).toBe(false); // duplicate question ids
  });
});

// ---------------------------------------------------------------------------
// Scripted collaborators
// ---------------------------------------------------------------------------

function makeItem(id: string, over: Partial<QuestionItem> = {}): QuestionItem {
  return {
    id,
    question: `Question text for ${id}, as of today?`,
    type: "recent_event",
    depth: "standard",
    rubric: [
      { id: "c1", criterion: `${id}: states the key fact`, kind: "must_state", weight: 3 },
      { id: "c2", criterion: `${id}: cites an official source`, kind: "must_cite", weight: 2 },
      { id: "c3", criterion: `${id}: flags uncertainty`, kind: "must_acknowledge_uncertainty", weight: 1 },
    ],
    notes: `Notes for the judge about ${id}.`,
    ...over,
  };
}

const ITEM_GOOD = makeItem("q-good");
const ITEM_DANGLING = makeItem("q-dangling");
const ITEM_THROWS = makeItem("q-throws");

const VERDICTS: Record<string, { verdict: Verdict; costUsd: number }> = {
  "q-good": {
    verdict: {
      criteria: [
        { id: "c1", met: true, evidence: "States v99.1.0 and the date." },
        { id: "c2", met: true, evidence: "Cites nodejs.org [1]." },
        { id: "c3", met: false, evidence: "No uncertainty about newer patches beyond the gaps note." },
      ],
      overall_score: 8,
      hallucination_risk: "low",
      citation_quality: "good",
      summary: "Solid and well sourced.",
    },
    costUsd: 0.002,
  },
  "q-dangling": {
    verdict: {
      criteria: [
        { id: "c1", met: true, evidence: "States the decision." },
        { id: "c2", met: false, evidence: "Citation [7] has no source." },
        { id: "c3", met: false, evidence: "Presents market pricing as fact." },
      ],
      overall_score: 4,
      hallucination_risk: "high",
      // The model is generous here; the judge must still cap this because of the dangling [7].
      citation_quality: "good",
      summary: "Dangling citation.",
    },
    costUsd: 0.003,
  },
};

interface FakeLlm extends LlmClient {
  complete: ReturnType<typeof vi.fn<(req: LlmRequest) => Promise<LlmResponse>>>;
  prompts(): string[];
}

function promptOf(req: LlmRequest): string {
  const content = req.messages[0]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function makeLlm(script: (req: LlmRequest) => { verdict: Verdict; costUsd: number } = defaultScript): FakeLlm {
  const complete = vi.fn(async (req: LlmRequest): Promise<LlmResponse> => {
    const { verdict, costUsd } = script(req);
    return {
      parsed: verdict,
      text: JSON.stringify(verdict),
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd,
      model: "claude-haiku-5-5",
      stopReason: "end_turn",
    };
  });
  return {
    complete,
    prompts: () => complete.mock.calls.map(([req]) => promptOf(req)),
  };
}

function defaultScript(req: LlmRequest): { verdict: Verdict; costUsd: number } {
  const prompt = promptOf(req);
  const hit = Object.entries(VERDICTS).find(([id]) => prompt.includes(`Question id: ${id}\n`));
  if (hit === undefined) throw new Error("fake judge: unexpected question in prompt");
  return hit[1];
}

function scriptedResearch(): (question: string, depth: Depth) => Promise<DeepResearchResult> {
  return async (question) => {
    if (question === ITEM_GOOD.question) return GOOD;
    if (question === ITEM_DANGLING.question) return DANGLING;
    throw new Error("search provider exploded");
  };
}

// ---------------------------------------------------------------------------
// judgeReport
// ---------------------------------------------------------------------------

describe("judgeReport", () => {
  it("computes the weighted rubric score separately from the model's overall score", async () => {
    const llm = makeLlm();
    const j = await judgeReport(llm, ITEM_GOOD, GOOD, { today: "2026-10-18" });
    expect(j.weighted_score).toBeCloseTo(5 / 6, 10);
    expect(j.overall_score).toBe(8);
    expect(j.criteria.map((c) => [c.id, c.met])).toEqual([
      ["c1", true],
      ["c2", true],
      ["c3", false],
    ]);
    expect(j.cost_usd).toBe(0.002);
    expect(j.citation_check).toEqual({
      cited: [1, 2],
      dangling: [],
      uncited_sources: [],
      findings_with_missing_sources: [],
    });
  });

  it("calls the scorer role with a schema and gives the judge everything in the 3.3 result plus the rubric", async () => {
    const llm = makeLlm();
    await judgeReport(llm, ITEM_GOOD, GOOD, { today: "2026-10-18" });
    const req = llm.complete.mock.calls[0]?.[0] as LlmRequest;
    expect(req.role).toBe("scorer");
    expect(req.schema).toBeDefined();
    expect(req.system).toMatch(/every cited number must exist in the sources list/i);
    expect(req.system).toMatch(/penalize factual claims, figures and dates that carry no citation/i);

    const prompt = promptOf(req);
    expect(prompt).toContain("Today's date: 2026-10-18");
    expect(prompt).toContain(GOOD.report_markdown);
    for (const s of GOOD.sources) {
      expect(prompt).toContain(s.url);
      expect(prompt).toContain(s.used_for);
    }
    for (const f of GOOD.findings) expect(prompt).toContain(f.claim);
    expect(prompt).toContain(GOOD.gaps[0]);
    for (const c of ITEM_GOOD.rubric) {
      expect(prompt).toContain(c.criterion);
      expect(prompt).toContain(`id: ${c.id}`);
    }
  });

  it("surfaces a dangling citation to the judge prompt and caps citation quality at weak", async () => {
    const llm = makeLlm();
    const j = await judgeReport(llm, ITEM_DANGLING, DANGLING, { today: "2026-10-18" });
    const prompt = llm.prompts()[0] as string;
    expect(prompt).toContain("DANGLING citations (cited in the report, absent from sources): [7]");
    expect(prompt).toContain("Source ids named by findings that are absent from sources: [7]");
    expect(prompt).toContain("Source ids never cited in the report: [2]");
    expect(j.citation_check.dangling).toEqual([7]);
    expect(j.citation_quality).toBe("weak");
    expect(j.hallucination_risk).toBe("high");
  });

  it("reports no dangling citations for a clean report", async () => {
    const llm = makeLlm();
    await judgeReport(llm, ITEM_GOOD, GOOD);
    expect(llm.prompts()[0]).toContain("DANGLING citations (cited in the report, absent from sources): none");
  });

  it("treats criteria the judge did not return as not met and clamps the overall score", async () => {
    const llm = makeLlm(() => ({
      verdict: {
        criteria: [{ id: "c1", met: true, evidence: "yes" }, { id: "zzz", met: true, evidence: "unknown id" }],
        overall_score: 11,
        hallucination_risk: "medium",
        citation_quality: "weak",
        summary: "s",
      },
      costUsd: 0,
    }));
    const j = await judgeReport(llm, ITEM_GOOD, GOOD);
    expect(j.weighted_score).toBeCloseTo(3 / 6, 10);
    expect(j.overall_score).toBe(10);
    expect(j.criteria.find((c) => c.id === "c2")?.met).toBe(false);
  });

  it("truncates the report at 60K characters with a visible marker", async () => {
    const long = { ...GOOD, report_markdown: "x".repeat(MAX_REPORT_CHARS + 5_000) };
    const llm = makeLlm();
    const j = await judgeReport(llm, ITEM_GOOD, long);
    const prompt = llm.prompts()[0] as string;
    expect(j.report_truncated).toBe(true);
    expect(prompt).toContain("REPORT TRUNCATED FOR THE JUDGE: 5000 of 65000 characters omitted");
    expect(prompt).not.toContain("x".repeat(MAX_REPORT_CHARS + 1));
    expect(prompt.length).toBeLessThan(MAX_REPORT_CHARS + 10_000);

    expect(truncateReport("short")).toEqual({ text: "short", truncated: false });
  });

  it("extracts single and grouped citations", () => {
    expect(extractCitations("a [3] b [1, 2] c [1][4] d [text](http://x) e [10]")).toEqual([1, 2, 3, 4, 10]);
  });
});

// ---------------------------------------------------------------------------
// runEvals
// ---------------------------------------------------------------------------

describe("runEvals", () => {
  it("produces rows and totals, records a throwing research call as a score-0 row, and does not abort", async () => {
    const llm = makeLlm();
    const events: EvalProgress[] = [];
    const result = await runEvals({
      research: scriptedResearch(),
      llm,
      items: [ITEM_GOOD, ITEM_DANGLING, ITEM_THROWS],
      today: "2026-10-18",
      onProgress: (e) => events.push(e),
    });

    expect(result.rows.map((r) => r.id)).toEqual(["q-good", "q-dangling", "q-throws"]);

    const [good, dangling, throws] = result.rows as [
      (typeof result.rows)[number],
      (typeof result.rows)[number],
      (typeof result.rows)[number],
    ];
    expect(good.type).toBe("recent_event");
    expect(good.weighted_score).toBeCloseTo(5 / 6, 10);
    expect(good.overall_score).toBe(8);
    expect(good.hallucination_risk).toBe("low");
    expect(good.citation_quality).toBe("good");
    expect(good.stats).toEqual(GOOD.stats);
    expect(good.judge_cost_usd).toBe(0.002);
    expect(good.error).toBeUndefined();

    expect(dangling.weighted_score).toBeCloseTo(0.5, 10);
    expect(dangling.overall_score).toBe(4);
    expect(dangling.hallucination_risk).toBe("high");
    expect(dangling.citation_quality).toBe("weak");
    expect(dangling.citation_check?.dangling).toEqual([7]);

    expect(throws.weighted_score).toBe(0);
    expect(throws.overall_score).toBe(0);
    expect(throws.stats).toBeNull();
    expect(throws.error).toContain("search provider exploded");
    expect(throws.judge_cost_usd).toBe(0);

    // The judge is never called for the failed run.
    expect(llm.complete).toHaveBeenCalledTimes(2);

    expect(result.totals.weighted_score).toBeCloseTo((5 / 6 + 0.5 + 0) / 3, 10);
    expect(result.totals.mean_overall).toBeCloseTo((8 + 4 + 0) / 3, 10);
    expect(result.totals.total_cost_usd).toBeCloseTo(0.21 + 0.74, 10);
    expect(result.totals.judge_cost_usd).toBeCloseTo(0.005, 10);
    expect(result.totals.total_elapsed_ms).toBeGreaterThanOrEqual(38_000 + 61_000);

    expect(events.filter((e) => e.type === "start")).toHaveLength(3);
    expect(events.filter((e) => e.type === "done")).toHaveLength(3);
  });

  it("uses each item's depth hint by default and the depth option when given", async () => {
    const seen: Depth[] = [];
    const research = async (_q: string, depth: Depth): Promise<DeepResearchResult> => {
      seen.push(depth);
      return GOOD;
    };
    const items = [makeItem("q-good", { depth: "quick" }), makeItem("q-dangling", { depth: "deep" })];
    await runEvals({ research, llm: makeLlm(), items, concurrency: 1 });
    expect(seen).toEqual(["quick", "deep"]);

    seen.length = 0;
    const result = await runEvals({ research, llm: makeLlm(), items, depth: "standard", concurrency: 1 });
    expect(seen).toEqual(["standard", "standard"]);
    expect(result.rows.map((r) => r.depth)).toEqual(["standard", "standard"]);
  });

  it("records an invalid research result as an error row", async () => {
    const research = async (): Promise<DeepResearchResult> => ({ question: "q" }) as unknown as DeepResearchResult;
    const llm = makeLlm();
    const result = await runEvals({ research, llm, items: [ITEM_GOOD] });
    expect(result.rows[0]?.error).toMatch(/invalid result/);
    expect(result.rows[0]?.weighted_score).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("records a judge failure as an error row but keeps the research stats and cost", async () => {
    const llm = makeLlm(() => {
      throw new Error("judge unavailable");
    });
    const result = await runEvals({ research: async () => GOOD, llm, items: [ITEM_GOOD] });
    const row = result.rows[0];
    expect(row?.error).toContain("judge failed: Error: judge unavailable");
    expect(row?.stats).toEqual(GOOD.stats);
    expect(row?.weighted_score).toBe(0);
    expect(result.totals.total_cost_usd).toBeCloseTo(0.21, 10);
  });

  it("limits concurrency, defaulting to 3", async () => {
    const run = async (concurrency: number | undefined): Promise<number> => {
      let inFlight = 0;
      let peak = 0;
      const research = async (): Promise<DeepResearchResult> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return GOOD;
      };
      const items = Array.from({ length: 8 }, (_, i) => makeItem(`q-good-${i}`));
      const llm = makeLlm(() => VERDICTS["q-good"] as { verdict: Verdict; costUsd: number });
      const result = await runEvals({ research, llm, items, ...(concurrency !== undefined && { concurrency }) });
      expect(result.rows).toHaveLength(8);
      return peak;
    };
    expect(await run(undefined)).toBe(3);
    expect(await run(2)).toBe(2);
    expect(await run(1)).toBe(1);
  });

  it("runs the real question set against a mocked engine", async () => {
    const items = loadQuestions();
    const llm = makeLlm((req) => {
      const rubricIds = [...promptOf(req).matchAll(/^- id: (c\d+) \|/gm)].map((m) => m[1] as string);
      return {
        verdict: {
          criteria: rubricIds.map((id) => ({ id, met: true, evidence: "ok" })),
          overall_score: 7,
          hallucination_risk: "low",
          citation_quality: "good",
          summary: "fine",
        },
        costUsd: 0.001,
      };
    });
    const result = await runEvals({ research: async () => GOOD, llm, concurrency: 5 });
    expect(result.rows).toHaveLength(items.length);
    expect(result.rows.map((r) => r.id)).toEqual(items.map((i) => i.id));
    expect(result.totals.weighted_score).toBe(1);
    expect(result.totals.mean_overall).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

describe("formatTable and writeJsonReport", () => {
  async function sample() {
    return runEvals({
      research: scriptedResearch(),
      llm: makeLlm(),
      items: [ITEM_GOOD, ITEM_DANGLING, ITEM_THROWS],
    });
  }

  it("lists every id, the error, and a totals line", async () => {
    const result = await sample();
    const table = formatTable(result);
    for (const id of ["q-good", "q-dangling", "q-throws"]) expect(table).toContain(id);
    expect(table).toContain("ERROR");
    expect(table).toContain("search provider exploded");
    const lines = table.split("\n");
    const totals = lines[lines.length - 1] as string;
    expect(totals).toMatch(/^TOTAL {2}n=3 /);
    expect(totals).toContain("weighted_score=");
    expect(totals).toContain("mean_overall=");
    expect(totals).toContain("research_cost=$0.9500");
    expect(totals).toContain("judge_cost=$0.0050");
  });

  it("produces fixed-width columns", async () => {
    const result = await sample();
    const lines = formatTable(result).split("\n");
    const ruleIdx = lines.findIndex((l) => /^-+( {2}-+)+$/.test(l));
    expect(ruleIdx).toBe(1);
    const rule = lines[ruleIdx] as string;
    // Every table row starts its columns at the same offsets as the rule.
    const starts = [...rule.matchAll(/-+/g)].map((m) => m.index ?? 0);
    const dataRows = lines.slice(ruleIdx + 1, ruleIdx + 1 + result.rows.length);
    for (const row of dataRows) {
      for (const s of starts.slice(1)) expect(row[s - 1], row).toBe(" ");
    }
  });

  it("writes a parseable JSON report, creating parent directories", async () => {
    const result = await sample();
    const path = join(tmp, "nested", "dir", "report.json");
    writeJsonReport(result, path);
    const back = JSON.parse(readFileSync(path, "utf8")) as typeof result;
    expect(back.rows).toHaveLength(3);
    expect(back.totals.total_cost_usd).toBeCloseTo(0.95, 10);
    expect(back.rows[0]?.report_markdown).toBe(GOOD.report_markdown);
  });
});
