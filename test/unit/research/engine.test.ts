import { describe, expect, it } from "vitest";
import { CostMeter } from "../../../src/core/llm/cost.js";
import { LlmError } from "../../../src/core/llm/types.js";
import { PROMPT_VERSION } from "../../../src/core/research/prompts.js";
import { runResearch } from "../../../src/core/research/engine.js";
import { ResearchError } from "../../../src/core/research/types.js";
import { SearchError } from "../../../src/core/search/index.js";
import { DEPTH_BUDGETS, DeepResearchResultSchema, type DeepResearchResult } from "../../../src/schemas/deep_research.js";
import { DeepResearchResultSchema as JudgeResultSchema } from "../../evals/research/schema.js";
import {
  blocked,
  candidatesIn,
  defaultExtractor,
  fakeFetch,
  fakeSearch,
  makeRig,
  pageByQuery,
  pageResult,
  pageUrl,
  plan,
  scoreWith,
  searchPool,
  userText,
  type PoolResult,
} from "./helpers.js";

const QUESTION = "Why is Canberra the capital of Australia?";

const pages = (...ns: number[]): PoolResult[] => ns.map(pageResult);
const budgetError = (): LlmError => new LlmError("budget_exceeded", "api", "cap reached", { retryable: false });

/** The citation numbers in a report, in order of first appearance. */
function citedIds(report: string): number[] {
  const out: number[] = [];
  for (const m of report.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const p of (m[1] ?? "").split(",")) {
      const n = Number(p.trim());
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

function expectInvariants(result: DeepResearchResult): void {
  const ids = result.sources.map((s) => s.id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
  const cited = citedIds(result.report_markdown);
  expect(cited).toEqual(ids);
  for (const f of result.findings) {
    expect(f.source_ids.length).toBeGreaterThan(0);
    for (const id of f.source_ids) expect(ids).toContain(id);
  }
  expect(result.report_markdown).toMatch(/^## Gaps/m);
}

describe("runResearch: a full mocked run", () => {
  it.each(["quick", "standard", "deep"] as const)(
    "completes a %s run in under 2 s and stops at the iteration ceiling",
    async (depth) => {
      const ceiling = DEPTH_BUDGETS[depth].iterations;
      const rig = makeRig(
        { planner: Array.from({ length: ceiling }, (_, i) => plan([`q-${i + 1}`])) },
        { search: fakeSearch(pageByQuery) },
      );
      const t0 = performance.now();
      const result = await runResearch({ question: QUESTION, depth }, rig.deps);
      expect(performance.now() - t0).toBeLessThan(2000);

      expect(result.depth).toBe(depth);
      expect(result.stats.iterations).toBe(ceiling);
      expect(result.stats.stopped_reason).toBe("iterations");
      expect(result.stats.searches).toBe(ceiling);
      expect(result.stats.pages_read).toBe(ceiling);
      expect(result.stats.pages_failed).toBe(0);
      // The last round needs no reflect call: one planner call per iteration.
      expect(rig.llm.byRole("planner")).toHaveLength(ceiling);
      expect(result.sources).toHaveLength(ceiling);
      expectInvariants(result);
      // The writer cites the notes in reverse, so the last page read is cited first.
      expect(result.sources[0]?.url).toBe(pageUrl(ceiling));
      expect(result.sources[0]?.published_at).toBeDefined();

      // Quick depth writes with the Sonnet-class role, the others with the writer role.
      const writerCall = rig.llm.requests.at(-1);
      expect(writerCall?.role).toBe(depth === "quick" ? "extractor" : "writer");
      expect(rig.llm.byRole("writer")).toHaveLength(depth === "quick" ? 0 : 1);
    },
  );

  it("fills sources and findings from the notes and validates against both result schemas", async () => {
    const rig = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION }, rig.deps);

    expect(DeepResearchResultSchema.safeParse(result).success).toBe(true);
    // The WP9 judge's schema must accept the engine's result as is.
    expect(JudgeResultSchema.safeParse(result).success).toBe(true);
    expect(result.question).toBe(QUESTION);
    expect(result.depth).toBe("standard");
    expect(result.sources[0]).toMatchObject({
      id: 1,
      url: pageUrl(1),
      title: "Canberra: the capital of Australia",
      accessed_at: "2026-10-18T09:00:00.000Z",
      published_at: "2024-05-01T00:00:00.000Z",
    });
    expect(result.sources[0]?.used_for).toMatch(/Canberra/);
    expect(result.findings[0]?.quote).toBe(
      "Canberra is the capital city of Australia and the seat of its federal parliament.",
    );
    expect(result.stats.input_tokens).toBeGreaterThan(0);
    expect(result.stats.output_tokens).toBeGreaterThan(0);
    expect(result.stats.elapsed_ms).toBeGreaterThanOrEqual(0);
    expectInvariants(result);
  });

  it("measures elapsed_ms with the injected clock", async () => {
    let t = 1000;
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] },
      { search: fakeSearch(pageByQuery), now: () => (t += 250) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.stats.elapsed_ms).toBeGreaterThan(0);
    expect(result.stats.elapsed_ms % 250).toBe(0);
  });
});

describe("runResearch: when the loop stops", () => {
  it("stops on convergence when the planner says stop", async () => {
    const rig = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("converged");
    expect(result.stats.iterations).toBe(1);
    expect(rig.llm.byRole("planner")).toHaveLength(2);
  });

  it("stops as converged when the planner reports no gaps even without stop", async () => {
    const rig = makeRig({ planner: [plan(["q-1"]), plan(["q-2"], { stop: false, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("converged");
    expect(result.stats.iterations).toBe(1);
  });

  it("stops when the last iteration added fewer than 2 new claims", async () => {
    // Page 6 has a single claim.
    const rig = makeRig({ planner: [plan(["q-1"]), plan(["q-6"])] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("converged");
    expect(result.stats.iterations).toBe(2);
    expect(rig.llm.byRole("planner")).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
  });

  it("stops on the iteration budget", async () => {
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan(["q-2"]), plan(["q-3"])] },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("iterations");
    expect(result.stats.iterations).toBe(3);
  });

  it("stops when the read budget is exhausted", async () => {
    const rig = makeRig({ planner: [plan(["everything"])] }, { search: fakeSearch(() => pages(1, 2, 3, 4, 5, 6)) });
    const result = await runResearch({ question: QUESTION, depth: "quick" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("reads");
    expect(result.stats.pages_read).toBe(DEPTH_BUDGETS.quick.pages);
    expect(rig.fetch.calls).toHaveLength(6);
    // Reads run three at a time.
    expect(rig.fetch.calls.every((c) => c.mode === "auto" && c.max_chars === 60000)).toBe(true);
  });

  it("stops when the search budget is exhausted and never issues more searches than the budget", async () => {
    const queries = ["q-1", "q-2", "q-3", "q-4", "q-5", "q-6"];
    const rig = makeRig({ planner: [plan(queries)] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION, depth: "quick" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("searches");
    expect(result.stats.searches).toBe(DEPTH_BUDGETS.quick.searches);
    expect(rig.search.calls).toHaveLength(4);
  });

  it("reports no_results when no candidate scores 5 or more, and does not call the writer", async () => {
    const rig = makeRig({ planner: [plan(["q-1"])], scorer: scoreWith(() => 4) });
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("no_results");
    expect(result.stats.iterations).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.report_markdown).toMatch(/No usable sources/);
    expect(result.report_markdown).toMatch(/^## Gaps/m);
    expect(rig.llm.byRole("writer")).toHaveLength(0);
    expect(rig.fetch.calls).toHaveLength(0);
  });

  it("reports no_results at quick depth when the search finds nothing", async () => {
    const rig = makeRig({ planner: [plan(["nothing"])] }, { search: fakeSearch(() => []) });
    const result = await runResearch({ question: QUESTION, depth: "quick" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("no_results");
    expect(rig.llm.byRole("scorer")).toHaveLength(0);
    expect(rig.llm.requests.map((r) => r.role)).toEqual(["planner"]);
  });

  it("drops notes whose relevance is under 4 and reports no_results when none remain", async () => {
    const rig = makeRig({
      planner: [plan(["q-1"])],
      extractor: (req, n) => ({ ...(defaultExtractor(req, n) as object), relevance: 3 }),
    }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION, depth: "quick" }, rig.deps);
    expect(result.stats.pages_read).toBe(1);
    expect(result.stats.stopped_reason).toBe("no_results");
    expect(result.sources).toEqual([]);
  });

  it("drops candidates scored under 5 so they are never read", async () => {
    const rig = makeRig({ planner: [plan(["everything"]), plan([], { stop: true, gaps: [] })] });
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    const read = rig.fetch.calls.map((c) => c.url);
    expect(read).toHaveLength(6);
    expect(read.some((u) => u.includes("spam"))).toBe(false);
    expect(result.stats.pages_read).toBe(6);
  });
});

describe("runResearch: budget", () => {
  it("stops the loop on budget_exceeded, adds a gap line and still writes the report", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"])],
        failures: (role, n) => (role === "planner" && n === 1 ? budgetError() : undefined),
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    expect(result.stats.iterations).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.report_markdown).toMatch(/^# Report/);
    expect(result.gaps.some((g) => /cost cap of \$3\.00/.test(g))).toBe(true);
    const gapsSection = result.report_markdown.split(/^## Gaps/m)[1] ?? "";
    expect(gapsSection).toMatch(/cost cap of \$3\.00/);
    expectInvariants(result);
  });

  it("keeps the notes of pages read in the same wave when an extraction hits the budget", async () => {
    const rig = makeRig(
      {
        planner: [plan(["three"])],
        failures: (role, n) => (role === "extractor" && n === 1 ? budgetError() : undefined),
      },
      { search: fakeSearch(() => pages(1, 2, 3)) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    expect(result.stats.pages_read).toBe(3);
    expect(result.sources).toHaveLength(2);
    expectInvariants(result);
  });

  it("builds the report from the notes when the writer is refused by the budget", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })],
        failures: (role) => (role === "writer" ? budgetError() : undefined),
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    expect(result.report_markdown).toContain(
      "- Canberra is the capital city of Australia and the seat of its federal parliament. [1]",
    );
    expect(result.findings).toHaveLength(3);
    expect(result.sources).toHaveLength(1);
    expect(result.gaps.some((g) => /cost cap/.test(g))).toBe(true);
    expectInvariants(result);
  });

  it("leaves room for the writer: a real meter stops the loop before the writer would be refused", async () => {
    // Every call costs 0.15 against a cap of 0.9. The loop must stop with enough left for the writer call to start.
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan(["q-2"]), plan(["q-3"])], costPerCall: 0.15 },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard", max_cost_usd: 0.9 }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    // The written report, not the fallback list.
    expect(result.report_markdown).toMatch(/^# Report/);
    expect(rig.llm.byRole("writer")).toHaveLength(1);
    expect(result.stats.cost_usd).toBeCloseTo(0.9, 6);
    expectInvariants(result);
  });

  it("falls back to the extracted claims when the cap is already spent before the writer", async () => {
    const rig = makeRig(
      { planner: [plan(["three"])], costPerCall: 0.5 },
      { search: fakeSearch(() => pages(1, 2, 3)) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard", max_cost_usd: 1.2 }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    expect(result.report_markdown).toMatch(/list of extracted claims|claims extracted/);
    expect(result.report_markdown).not.toMatch(/^# Report/);
    expect(result.stats.cost_usd).toBeCloseTo(2.5, 6);
    expect(result.sources).toHaveLength(3);
    expectInvariants(result);
  });

  it("uses the config cap by default and max_cost_usd when given, on every call", async () => {
    const rig = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION, max_cost_usd: 1.5 }, rig.deps);
    const meters = new Set(rig.llm.requests.map((r) => r.meter));
    expect(meters.size).toBe(1);
    const meter = [...meters][0];
    expect(meter).toBeInstanceOf(CostMeter);
    expect(meter?.maxCostUsd).toBe(1.5);

    const other = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION }, other.deps);
    expect(other.llm.requests[0]?.meter?.maxCostUsd).toBe(3);
  });
});

describe("runResearch: failures", () => {
  it("counts a failing fetch in pages_failed and continues", async () => {
    const rig = makeRig(
      { planner: [plan(["three"]), plan([], { stop: true, gaps: [] })] },
      { search: fakeSearch(() => pages(1, 2, 3)), fetch: fakeFetch({ fail: (u) => (u === pageUrl(2) ? blocked() : undefined) }) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.pages_failed).toBe(1);
    expect(result.stats.pages_read).toBe(2);
    expect(result.sources.map((s) => s.url).sort()).toEqual([pageUrl(1), pageUrl(3)]);
    expect(rig.lines.some((l) => l.level === "warn" && l.msg === "research page fetch failed")).toBe(true);
    expectInvariants(result);
  });

  it("replaces a failed page with the next candidate in the same iteration", async () => {
    const rig = makeRig(
      { planner: [plan(["many"])] },
      {
        search: fakeSearch(() => pages(1, 2, 3, 4, 5, 6)),
        fetch: fakeFetch({ fail: (u) => (u === pageUrl(1) ? blocked() : undefined) }),
      },
    );
    const result = await runResearch({ question: QUESTION, depth: "quick" }, rig.deps);
    expect(result.stats.pages_failed).toBe(1);
    // Quick reads up to six pages and there are exactly six good ones left after one failure... five.
    expect(result.stats.pages_read).toBe(5);
    expect(result.stats.stopped_reason).toBe("iterations");
  });

  it("throws ResearchError config when every search fails with config", async () => {
    const rig = makeRig(
      { planner: [plan(["a", "b"])] },
      {
        search: fakeSearch(() => {
          throw new SearchError({ code: "config", message: "no providers", retryable: false });
        }),
      },
    );
    await expect(runResearch({ question: QUESTION }, rig.deps)).rejects.toMatchObject({
      name: "ResearchError",
      code: "config",
      retryable: false,
    });
    expect(rig.search.calls).toHaveLength(2);
  });

  it("throws ResearchError provider when every search fails and nothing was found yet", async () => {
    const rig = makeRig(
      { planner: [plan(["a"])] },
      {
        search: fakeSearch(() => {
          throw new SearchError({ code: "provider", message: "all providers failed", retryable: true });
        }),
      },
    );
    await expect(runResearch({ question: QUESTION }, rig.deps)).rejects.toMatchObject({ code: "provider", retryable: true });
  });

  it("survives one failing search among several", async () => {
    const rig = makeRig(
      { planner: [plan(["bad", "q-1"]), plan([], { stop: true, gaps: [] })] },
      {
        search: fakeSearch((q) => {
          if (q === "bad") throw new SearchError({ code: "timeout", message: "timed out", retryable: true });
          return pageByQuery(q);
        }),
      },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.stats.searches).toBe(2);
    expect(result.sources).toHaveLength(1);
  });

  it("stops with stopped_reason searches when every search fails in a later round", async () => {
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan(["q-2"])] },
      {
        search: fakeSearch((q, i) => {
          if (i >= 1) throw new SearchError({ code: "provider", message: "down", retryable: true });
          return pageByQuery(q);
        }),
      },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.stats.stopped_reason).toBe("searches");
    expect(result.gaps.some((g) => /Searches failed/.test(g))).toBe(true);
    expect(result.sources).toHaveLength(1);
    expectInvariants(result);
  });

  it("maps an unconfigured LLM to ResearchError config", async () => {
    const rig = makeRig({
      planner: [plan(["a"])],
      failures: () => new LlmError("config", "not_configured", "ANTHROPIC_API_KEY is not set", { retryable: false }),
    });
    await expect(runResearch({ question: QUESTION }, rig.deps)).rejects.toMatchObject({ code: "config" });
    expect(rig.search.calls).toHaveLength(0);
  });

  it("maps a provider failure of the first planner call to ResearchError provider", async () => {
    const rig = makeRig({
      failures: () => new LlmError("provider", "api", "overloaded", { retryable: true }),
    });
    await expect(runResearch({ question: QUESTION }, rig.deps)).rejects.toMatchObject({ code: "provider", retryable: true });
  });

  it("writes from the notes it has when a later model call fails", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"])],
        failures: (role, n) => (role === "planner" && n === 1 ? new LlmError("provider", "api", "boom", { retryable: true }) : undefined),
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.sources).toHaveLength(1);
    expect(result.gaps.some((g) => /model call failed/.test(g))).toBe(true);
    expectInvariants(result);
  });

  it("skips a page whose extraction fails without counting it as a failed fetch", async () => {
    const rig = makeRig(
      {
        planner: [plan(["three"]), plan([], { stop: true, gaps: [] })],
        failures: (role, n) => (role === "extractor" && n === 0 ? new LlmError("provider", "schema", "bad json", { retryable: false }) : undefined),
      },
      { search: fakeSearch(() => pages(1, 2, 3)) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.stats.pages_read).toBe(3);
    expect(result.stats.pages_failed).toBe(0);
    expect(result.sources).toHaveLength(2);
  });

  it("rejects invalid input with ResearchError", async () => {
    const rig = makeRig({});
    await expect(runResearch({ question: "" }, rig.deps)).rejects.toBeInstanceOf(ResearchError);
    await expect(runResearch({ question: "x".repeat(2001) }, rig.deps)).rejects.toBeInstanceOf(ResearchError);
    await expect(runResearch({ question: "ok", max_cost_usd: -1 }, rig.deps)).rejects.toBeInstanceOf(ResearchError);
    expect(rig.llm.requests).toHaveLength(0);
  });

  it("never lets an API key reach a log line, the report or the gaps", async () => {
    const key = "sk-ant-api03-SUPER-SECRET-KEY-VALUE";
    const rig = makeRig(
      { planner: [plan(["bad", "three"]), plan([], { stop: true, gaps: [] })] },
      {
        config: { anthropic_api_key: key },
        search: fakeSearch((q) => {
          if (q === "bad") throw new SearchError({ code: "provider", message: `denied for key=${key}`, retryable: false });
          return pages(1, 2, 3);
        }),
        fetch: fakeFetch({ fail: (u) => (u === pageUrl(2) ? new Error(`GET failed with Authorization: Bearer ${key}`) : undefined) }),
      },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.stats.pages_failed).toBe(1);
    expect(JSON.stringify(rig.lines)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(rig.lines.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(2);
  });
});

describe("runResearch: what is asked of the models", () => {
  it("passes the meter to every call and uses the planned token limits and efforts", async () => {
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan(["q-2"]), plan([], { stop: true, gaps: [] })] },
      { search: fakeSearch(pageByQuery) },
    );
    await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);

    const meters = new Set(rig.llm.requests.map((r) => r.meter));
    expect(meters.size).toBe(1);
    expect([...meters][0]).toBeInstanceOf(CostMeter);

    expect(rig.llm.byRole("planner").length).toBeGreaterThanOrEqual(2);
    for (const r of rig.llm.byRole("planner")) {
      expect(r.maxTokens).toBe(16000);
      expect(r.effort).toBe("high");
      expect(r.schema).toBeDefined();
    }
    for (const r of rig.llm.byRole("scorer")) expect(r.effort).toBe("low");
    for (const r of rig.llm.byRole("extractor")) {
      expect(r.effort).toBe("medium");
      expect(r.maxTokens).toBe(8192);
    }
    const writer = rig.llm.byRole("writer");
    expect(writer).toHaveLength(1);
    expect(writer[0]?.maxTokens).toBe(32000);
    expect(writer[0]?.effort).toBe("high");
    for (const r of rig.llm.requests) {
      expect(r.schema).toBeDefined();
      // No tool use: only a system prompt and one user message.
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]?.role).toBe("user");
    }
  });

  it("keeps each role's system prompt stable across calls and free of model names", async () => {
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan(["q-2"]), plan(["q-3"])] },
      { search: fakeSearch(pageByQuery) },
    );
    await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    for (const role of ["planner", "scorer", "extractor", "writer"] as const) {
      const systems = new Set(rig.llm.byRole(role).map((r) => r.system));
      expect(systems.size).toBe(1);
      expect([...systems][0]).not.toMatch(/claude|opus|sonnet|haiku|anthropic|gpt/i);
    }
    // The question lives in the user message, not in the cached system prompt.
    for (const r of rig.llm.requests) {
      expect(r.system).not.toContain(QUESTION);
      expect(userText(r)).toContain(QUESTION.slice(0, 20));
    }
  });

  it("scores candidates in batches of at most 40", async () => {
    const many: PoolResult[] = Array.from({ length: 95 }, (_, i) => ({
      url: `https://example.net/g-${i}`,
      title: `Generated result ${i}`,
      snippet: `Snippet ${i}`,
    }));
    const rig = makeRig(
      { planner: [plan(["lots"]), plan([], { stop: true, gaps: [] })] },
      { search: fakeSearch(() => many) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    const sizes = rig.llm.byRole("scorer").map((r) => candidatesIn(r).length);
    expect(sizes).toEqual([40, 40, 15]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(40);
    // The first iteration may read ceil(20 / 3) = 7 pages.
    expect(result.stats.pages_read).toBe(7);
  });

  it("does not re-read URLs across iterations", async () => {
    const rig = makeRig(
      { planner: [plan(["a"]), plan(["b"]), plan(["c"])] },
      // Each search returns every page seen so far plus one more.
      { search: fakeSearch((_q, i) => pages(...[1, 2, 3, 4, 5, 6].slice(0, 3 + i))) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    const urls = rig.fetch.calls.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toEqual([pageUrl(1), pageUrl(2), pageUrl(3), pageUrl(4), pageUrl(5)]);
    expect(result.stats.iterations).toBe(3);
    // Candidates seen once are scored once.
    const scored = rig.llm.byRole("scorer").flatMap((r) => candidatesIn(r).map((c) => c.url));
    expect(new Set(scored).size).toBe(scored.length);
  });

  it("recognises one page under two URLs by canonical form", async () => {
    const rig = makeRig(
      { planner: [plan(["a", "b"]), plan([], { stop: true, gaps: [] })] },
      {
        search: fakeSearch((q) => [
          { ...pageResult(1), url: q === "a" ? pageUrl(1) : `${pageUrl(1)}/?utm_source=news#top` },
        ]),
      },
    );
    await runResearch({ question: QUESTION }, rig.deps);
    expect(rig.fetch.calls).toHaveLength(1);
  });

  it("passes recency and domain filters to the search", async () => {
    const rig = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    await runResearch(
      { question: QUESTION, recency: "month", focus_domains: ["example.org"], exclude_domains: ["spam.example.com"] },
      rig.deps,
    );
    expect(rig.search.calls[0]).toMatchObject({
      query: "q-1",
      max_results: 10,
      recency: "month",
      include_domains: ["example.org"],
      exclude_domains: ["spam.example.com"],
    });
    expect(userText(rig.llm.byRole("planner")[0]!)).toContain("last month");
  });

  it("falls back to the question itself when the first plan has no queries", async () => {
    const rig = makeRig({ planner: [plan([]), plan([], { stop: true, gaps: [] })] });
    await runResearch({ question: QUESTION }, rig.deps);
    expect(rig.search.calls[0]?.query).toBe(QUESTION);
  });

  it("does not repeat a query the planner already ran", async () => {
    const rig = makeRig({ planner: [plan(["q-1"]), plan(["Q-1 "])] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(rig.search.calls).toHaveLength(1);
    expect(result.stats.stopped_reason).toBe("converged");
  });

  it("passes the output format through to the writer prompt", async () => {
    const brief = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION, output: "brief" }, brief.deps);
    const briefWriter = brief.llm.byRole("writer")[0]!;
    expect(userText(briefWriter)).toContain("brief (at most 300 words");
    expect(briefWriter.system).toMatch(/300 words/);

    const full = makeRig({ planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION }, full.deps);
    expect(userText(full.llm.byRole("writer")[0]!)).toContain("report (full Markdown report)");
  });

  it("hands the writer notes, not raw pages, keyed by provisional id", async () => {
    const rig = makeRig({ planner: [plan(["q-1", "q-2"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION }, rig.deps);
    const text = userText(rig.llm.byRole("writer")[0]!);
    expect(text).toMatch(/^\[1\] /m);
    expect(text).toMatch(/^\[2\] /m);
    // Prose from the page body that is not a claim stays out of the writer prompt.
    expect(text).not.toContain("It is the largest inland city");
    expect(text).toContain("Claim 1 (high)");
  });

  it("truncates an over-long quote from the extractor instead of rejecting it", async () => {
    const long = "Alpha ".repeat(100);
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })],
        extractor: (req, n) => {
          const base = defaultExtractor(req, n) as { claims: Array<{ quote: string }> };
          return { ...base, claims: base.claims.map((c) => ({ ...c, quote: long })) };
        },
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    const quotes = result.findings.map((f) => f.quote).filter((q): q is string => q !== undefined);
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) {
      expect(q.length).toBeLessThanOrEqual(300);
      expect(long.startsWith(q)).toBe(true);
    }
    expect(userText(rig.llm.byRole("writer")[0]!)).not.toContain("Alpha ".repeat(60));
    expect(DeepResearchResultSchema.safeParse(result).success).toBe(true);
  });

  it("drops a finding quote that is not a span of a cited note's quote", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })],
        writer: [
          {
            report_markdown: "# R\n\nCanberra is the capital. [1]\n\n## Gaps\n\n- None.\n",
            findings: [
              { claim: "Canberra is the capital.", confidence: "high", source_ids: [1], quote: "Words the page never said." },
              { claim: "It is the seat of parliament.", confidence: "high", source_ids: [1], quote: "the seat of its federal parliament" },
            ],
            source_notes: [{ source_id: 1, used_for: "Capital status." }],
            gaps: [],
          },
        ],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.findings[0]?.quote).toBeUndefined();
    expect(result.findings[1]?.quote).toBe("the seat of its federal parliament");
  });
});

describe("runResearch: citations in the written report", () => {
  it("renumbers in first-citation order and drops sources and findings that are never cited", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1", "q-2", "q-3"]), plan([], { stop: true, gaps: [] })],
        writer: [
          {
            report_markdown: "# R\n\nThird fact. [3]\n\nFirst fact. [1][3]\n\n## Gaps\n\n- Unknown.\n",
            findings: [
              { claim: "About the first page.", confidence: "high", source_ids: [1], quote: null },
              { claim: "About the second page only.", confidence: "low", source_ids: [2], quote: null },
              { claim: "About the third page.", confidence: "medium", source_ids: [3, 2], quote: null },
            ],
            source_notes: [
              { source_id: 1, used_for: "First." },
              { source_id: 2, used_for: "Second." },
              { source_id: 3, used_for: "Third." },
            ],
            gaps: ["Unknown."],
          },
        ],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.report_markdown).toBe("# R\n\nThird fact. [1]\n\nFirst fact. [2][1]\n\n## Gaps\n\n- Unknown.\n");
    expect(result.sources.map((s) => [s.id, s.url, s.used_for])).toEqual([
      [1, pageUrl(3), "Third."],
      [2, pageUrl(1), "First."],
    ]);
    expect(result.findings.map((f) => [f.claim, f.source_ids])).toEqual([
      ["About the first page.", [2]],
      ["About the third page.", [1]],
    ]);
    expectInvariants(result);
  });

  it("removes a citation to a source that does not exist and says so in the gaps", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })],
        writer: [
          {
            report_markdown: "# R\n\nReal claim. [1]\n\nMade-up claim. [9]\n\n## Gaps\n\n- None.\n",
            findings: [{ claim: "Real claim.", confidence: "high", source_ids: [1, 9], quote: null }],
            source_notes: [{ source_id: 1, used_for: "Real." }],
            gaps: [],
          },
        ],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.report_markdown).not.toMatch(/\[9\]/);
    expect(result.report_markdown).toContain("Made-up claim.");
    expect(result.findings[0]?.source_ids).toEqual([1]);
    expect(result.gaps.some((g) => /do not exist/.test(g))).toBe(true);
    expect(result.report_markdown).toMatch(/do not exist/);
    expectInvariants(result);
  });

  it("uses the extracted claims when the writer cites nothing", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })],
        writer: [{ report_markdown: "# R\n\nNo citations here.\n", findings: [], source_notes: [], gaps: [] }],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.sources).toHaveLength(1);
    expect(result.report_markdown).toContain("Canberra is the capital city of Australia");
    expect(result.gaps.some((g) => /cited no sources/.test(g))).toBe(true);
    expectInvariants(result);
  });

  it("adds a Gaps section when the writer left it out", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), plan([], { stop: true, gaps: [] })],
        writer: [
          {
            report_markdown: "# R\n\nA claim. [1]\n",
            findings: [{ claim: "A claim.", confidence: "high", source_ids: [1], quote: null }],
            source_notes: [{ source_id: 1, used_for: "Claim." }],
            gaps: ["Something is unknown."],
          },
        ],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.report_markdown).toMatch(/^## Gaps\n\n- Something is unknown\.$/m);
    expect(result.gaps).toEqual(["Something is unknown."]);
    expectInvariants(result);
  });

  it("every finding in a mocked run has at least one source id", async () => {
    const rig = makeRig({ planner: [plan(["q-1", "q-2", "q-3"]), plan([], { stop: true, gaps: [] })] }, { search: fakeSearch(pageByQuery) });
    const result = await runResearch({ question: QUESTION }, rig.deps);
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) expect(f.source_ids.length).toBeGreaterThan(0);
  });
});

describe("runResearch: logging", () => {
  it("logs the prompt version at debug, one info line per iteration and one at the end", async () => {
    const rig = makeRig(
      { planner: [plan(["q-1"]), plan(["q-2"]), plan(["q-3"])] },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);

    const start = rig.lines.find((l) => l.msg === "research start");
    expect(start?.level).toBe("debug");
    expect(start?.fields?.["prompt_version"]).toBe(PROMPT_VERSION);

    const iterationLines = rig.lines.filter((l) => l.msg === "research iteration");
    expect(iterationLines).toHaveLength(result.stats.iterations);
    for (const l of iterationLines) {
      expect(l.level).toBe("info");
      // Counts only: no question text, no page text, no URLs.
      for (const v of Object.values(l.fields ?? {})) expect(typeof v).toBe("number");
    }
    const end = rig.lines.filter((l) => l.msg === "research finished");
    expect(end).toHaveLength(1);
    expect(end[0]?.fields?.["stopped_reason"]).toBe("iterations");
    expect(JSON.stringify(rig.lines)).not.toContain(QUESTION);
  });
});

describe("fixtures", () => {
  it("has six pages and two spam results", () => {
    expect(searchPool).toHaveLength(8);
    expect(searchPool.filter((r) => r.title.startsWith("SPAM"))).toHaveLength(2);
  });
});
