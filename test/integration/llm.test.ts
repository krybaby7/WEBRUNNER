import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { createLlmClient } from "../../src/core/llm/client.js";
import { CostMeter } from "../../src/core/llm/cost.js";

// One real call against the Claude API. Costs a fraction of a cent.
// Run with: RUN_INTEGRATION=1 ANTHROPIC_API_KEY=... npm test
const enabled = process.env["RUN_INTEGRATION"] === "1" && Boolean(process.env["ANTHROPIC_API_KEY"]);

describe.skipIf(!enabled)("LlmClient against the real API", () => {
  it("returns validated structured output from Haiku 5.5", async () => {
    const config = loadConfig();
    const meter = new CostMeter();
    const client = createLlmClient(config, { meter });
    const schema = z.object({ capital: z.string(), country: z.string() });

    const res = await client.complete({
      role: "scorer",
      system: "Answer with the requested JSON only.",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      schema,
      maxTokens: 1024,
    });

    expect(schema.parse(res.parsed).capital).toMatch(/paris/i);
    expect(res.model).toBe("claude-haiku-5-5");
    expect(res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.costUsd).toBeLessThan(0.01);
    expect(meter.totalCostUsd).toBeCloseTo(res.costUsd, 12);
  }, 60_000);
});
