import { describe, expect, it } from "vitest";
import { DailyCostCap } from "../../../src/core/llm/daily-cap.js";
import { LlmError } from "../../../src/core/llm/types.js";
import { runResearch } from "../../../src/core/research/engine.js";
import { ResearchError } from "../../../src/core/research/types.js";
import { fakeSearch, makeRig, pageByQuery, plan } from "./helpers.js";

const QUESTION = "Why is Canberra the capital of Australia?";

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the run to fail");
}

function expectTimeout(err: unknown): void {
  expect(err).toBeInstanceOf(ResearchError);
  expect(err).toMatchObject({ code: "timeout", retryable: true });
}

describe("runResearch with an AbortSignal", () => {
  it("passes the signal to every LLM call", async () => {
    const controller = new AbortController();
    const rig = makeRig({ planner: [plan(["q-1"])] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION, depth: "quick" }, { ...rig.deps, signal: controller.signal });
    expect(rig.llm.requests.length).toBeGreaterThan(3);
    for (const req of rig.llm.requests) expect(req.signal).toBe(controller.signal);
  });

  it("passes no signal when none was given", async () => {
    const rig = makeRig({ planner: [plan(["q-1"])] }, { search: fakeSearch(pageByQuery) });
    await runResearch({ question: QUESTION, depth: "quick" }, rig.deps);
    for (const req of rig.llm.requests) expect("signal" in req).toBe(false);
  });

  it("a signal that is already aborted ends the run with timeout before any call", async () => {
    const controller = new AbortController();
    controller.abort();
    const rig = makeRig({ planner: [plan(["q-1"])] });
    const err = await caught(runResearch({ question: QUESTION, depth: "quick" }, { ...rig.deps, signal: controller.signal }));
    expectTimeout(err);
    expect(rig.llm.requests).toHaveLength(0);
    expect(rig.search.calls).toHaveLength(0);
  });

  it("stops before searching when the signal aborts during planning", async () => {
    const controller = new AbortController();
    const rig = makeRig(
      {
        planner: [
          () => {
            controller.abort();
            return plan(["q-1"]);
          },
        ],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const err = await caught(runResearch({ question: QUESTION, depth: "standard" }, { ...rig.deps, signal: controller.signal }));
    expectTimeout(err);
    expect(rig.search.calls).toHaveLength(0);
    expect(rig.llm.byRole("scorer")).toHaveLength(0);
  });

  it("stops before scoring and reading when the signal aborts during the search step", async () => {
    const controller = new AbortController();
    const search = fakeSearch(pageByQuery);
    const original = search.search.getMockImplementation();
    search.search.mockImplementation(async (input) => {
      controller.abort();
      return original?.(input) ?? Promise.reject(new Error("no implementation"));
    });
    const rig = makeRig({ planner: [plan(["q-1"])] }, { search });
    const err = await caught(runResearch({ question: QUESTION, depth: "standard" }, { ...rig.deps, signal: controller.signal }));
    expectTimeout(err);
    expect(rig.llm.byRole("scorer")).toHaveLength(0);
    expect(rig.fetch.calls).toHaveLength(0);
  });

  it("stops between reads when the signal aborts while pages are being read", async () => {
    const controller = new AbortController();
    const rig = makeRig({ planner: [plan(["q-1"])] }, { search: fakeSearch(() => pageByQuery("q-1").concat(pageByQuery("q-1"))) });
    rig.fetch.fetchPage.mockImplementationOnce(async (input) => {
      controller.abort();
      return {
        url: input.url,
        final_url: input.url,
        title: "t",
        markdown: "# t\n\n- fact one.\n- fact two.\n",
        truncated: false,
        method: "direct",
        fetched_at: "2026-10-18T09:00:00.000Z",
        cached: false,
      };
    });
    const err = await caught(runResearch({ question: QUESTION, depth: "standard" }, { ...rig.deps, signal: controller.signal }));
    expectTimeout(err);
    expect(rig.llm.byRole("writer")).toHaveLength(0);
  });

  it("does not write a partial report when the signal aborts after the research steps", async () => {
    const controller = new AbortController();
    const rig = makeRig(
      {
        planner: [plan(["q-1"])],
        // The first extractor call aborts the run; everything after must not run.
        extractor: [
          () => {
            controller.abort();
            return { relevance: 8, published_at: null, claims: [{ text: "a", quote: "a", confidence: "high" }] };
          },
        ],
      },
      { search: fakeSearch(pageByQuery) },
    );
    const err = await caught(runResearch({ question: QUESTION, depth: "quick" }, { ...rig.deps, signal: controller.signal }));
    expectTimeout(err);
    expect(rig.llm.byRole("writer")).toHaveLength(0);
  });

  it("an LLM call that fails because the run was cancelled is a timeout, not a partial result", async () => {
    const controller = new AbortController();
    let aborted = false;
    const rig = makeRig(
      { planner: [plan(["q-1"])] },
      {
        search: fakeSearch(pageByQuery),
      },
    );
    // The writer is the call in flight when the cap fires: it rejects the way the SDK does on abort.
    const complete = rig.deps.llm.complete.bind(rig.deps.llm);
    rig.deps.llm.complete = async (req) => {
      if (req.role === "extractor" && req.messages[0]?.content?.toString().includes("<notes>") === true) {
        controller.abort();
        aborted = true;
        throw new LlmError("timeout", "network", "Request was aborted", { retryable: true });
      }
      return complete(req);
    };
    const err = await caught(runResearch({ question: QUESTION, depth: "quick" }, { ...rig.deps, signal: controller.signal }));
    expect(aborted).toBe(true);
    expectTimeout(err);
  });

  it("a model failure without an abort still degrades to the fallback report", async () => {
    const controller = new AbortController();
    const rig = makeRig(
      {
        planner: [plan(["q-1"])],
        failures: (role) => (role === "writer" ? new LlmError("provider", "api", "writer down", { retryable: true }) : undefined),
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "quick" }, { ...rig.deps, signal: controller.signal });
    expect(result.gaps.join(" ")).toMatch(/writer failed/);
  });
});

describe("runResearch when the daily cost cap runs out mid-run", () => {
  it("stops with the budget reason and says the daily cap was the cause", async () => {
    const dailyError = new LlmError(
      "budget_exceeded",
      "api",
      "Daily cost cap reached: $5.10 spent today (UTC 2026-10-18) against the $5.00 limit set by WEBRUNNER_DAILY_COST_CAP_USD.",
      { retryable: false, details: { scope: "daily", variable: "WEBRUNNER_DAILY_COST_CAP_USD" } },
    );
    expect(dailyError.details).toMatchObject({ scope: "daily" });
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), () => undefined],
        failures: (role, n) => (role === "planner" && n === 1 ? dailyError : undefined),
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    const text = result.gaps.join("\n");
    expect(text).toContain("WEBRUNNER_DAILY_COST_CAP_USD");
    expect(text).not.toMatch(/cost cap of \$3\.00/);
    expect(result.report_markdown).toContain("WEBRUNNER_DAILY_COST_CAP_USD");
  });

  it("still names the per-call amount for the per-call cap", async () => {
    const rig = makeRig(
      {
        planner: [plan(["q-1"]), () => undefined],
        failures: (role, n) =>
          role === "planner" && n === 1 ? new LlmError("budget_exceeded", "api", "cap reached", { retryable: false }) : undefined,
      },
      { search: fakeSearch(pageByQuery) },
    );
    const result = await runResearch({ question: QUESTION, depth: "standard" }, rig.deps);
    expect(result.stats.stopped_reason).toBe("budget");
    expect(result.gaps.join("\n")).toMatch(/cost cap of \$3\.00 was reached/);
  });

  it("exposes the details shape the engine reads on the real DailyCostCap error", () => {
    const cap = new DailyCostCap({ capUsd: 1, dir: "/nonexistent-dir-for-test", now: () => Date.parse("2026-10-18T00:00:00Z") });
    cap.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2);
    expect(cap.exceededError()?.details).toMatchObject({ scope: "daily" });
  });
});
