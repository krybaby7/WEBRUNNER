import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { createClaudeCliClient } from "../../src/core/llm/claude-cli.js";
import { CostMeter } from "../../src/core/llm/cost.js";
import { resolveExecutable } from "../../src/core/llm/process.js";

// Real `claude -p` calls on the owner's Claude subscription (PLAN.md 15.3). They use a little
// plan quota and bill nothing. Run with: RUN_INTEGRATION=1 npm test (needs Claude Code, signed in).
const claudePath = resolveExecutable(process.env["WEBRUNNER_CLAUDE_PATH"] ?? "claude");
const enabled = process.env["RUN_INTEGRATION"] === "1" && claudePath !== undefined;

describe.skipIf(!enabled)("claude-cli backend against the real claude", () => {
  const work = mkdtempSync(join(tmpdir(), "webrunner-claude-live-"));
  const client = createClaudeCliClient(loadConfig(), { command: claudePath as string, workDir: work });

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("returns validated structured output from the scorer model, with usage and a plan status", async () => {
    const meter = new CostMeter();
    const res = await client.complete({
      role: "scorer",
      system: "You score how relevant a text is to a question, from 0 to 10.",
      messages: [
        {
          role: "user",
          content: "Question: what is the weather in Paris this week?\nText: Paris forecast for this week: sunny Monday to Wednesday with highs of 18 °C, showers on Thursday, 14 °C and windy on Friday.",
        },
      ],
      schema: z.object({ score: z.number().int().min(0).max(10), reason: z.string() }),
      meter,
    });
    expect((res.parsed as { score: number }).score).toBeGreaterThanOrEqual(6);
    expect(res.model).toMatch(/haiku/);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(meter.calls).toBe(1);
    expect(client.planStatus()?.status).toMatch(/^allowed/);
  }, 120_000);

  it("reads a screenshot sent as an image block", async () => {
    const browser = await chromium.launch();
    let data: string;
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 120 } });
      await page.setContent('<body style="margin:0;background:#fff"><h1 style="font:bold 48px sans-serif;padding:20px">ZEBRA 4417</h1></body>');
      data = (await page.screenshot()).toString("base64");
    } finally {
      await browser.close();
    }
    const res = await client.complete({
      role: "scorer",
      system: "You read screenshots and report exactly the text they show.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Which word and number does the screenshot show?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        },
      ],
      schema: z.object({ word: z.string(), number: z.number().int() }),
    });
    expect(res.parsed).toEqual({ word: "ZEBRA", number: 4417 });
  }, 120_000);
});
