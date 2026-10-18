import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildDeps, closeDeps } from "../../src/deps.js";
import { runResearch } from "../../src/core/research/engine.js";
import { assertInvariants } from "../../src/core/research/report.js";
import { DeepResearchResultSchema } from "../../src/schemas/deep_research.js";

// One real quick-depth run: a handful of searches, a few page reads and a few
// model calls. Expect roughly $0.10 to $0.30.
// Run with: RUN_INTEGRATION=1 ANTHROPIC_API_KEY=... BRAVE_API_KEY=... npm test
const searchKeys = ["BRAVE_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "PERPLEXITY_API_KEY"];
const enabled =
  process.env["RUN_INTEGRATION"] === "1" &&
  Boolean(process.env["ANTHROPIC_API_KEY"]) &&
  searchKeys.some((k) => Boolean(process.env[k]));

describe.skipIf(!enabled)("runResearch against the real services", () => {
  it("answers a simple question at quick depth with a consistent, cited report", async () => {
    const config = loadConfig();
    const deps = buildDeps(config);
    try {
      const result = await runResearch(
        { question: "What is the capital of Australia, and why was it chosen over Sydney and Melbourne?", depth: "quick" },
        {
          config: deps.config,
          log: deps.log,
          llm: deps.llm!,
          search: deps.search!,
          fetch: deps.fetch!,
        },
      );

      expect(DeepResearchResultSchema.safeParse(result).success).toBe(true);
      assertInvariants(result);
      expect(result.depth).toBe("quick");
      expect(result.stats.iterations).toBe(1);
      expect(result.stats.searches).toBeGreaterThan(0);
      expect(result.stats.pages_read).toBeGreaterThan(0);
      expect(result.stats.cost_usd).toBeGreaterThan(0);
      expect(result.stats.input_tokens).toBeGreaterThan(0);
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.report_markdown).toMatch(/canberra/i);
      expect(result.report_markdown).toMatch(/^#{1,6}\s*gaps/im);
    } finally {
      await closeDeps(deps);
    }
  }, 300_000);
});
