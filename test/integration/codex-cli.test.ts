import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { createCodexCliClient } from "../../src/core/llm/codex-cli.js";
import { CostMeter } from "../../src/core/llm/cost.js";
import { DEFAULT_CODEX_MODEL } from "../../src/core/llm/models.js";
import { resolveExecutable } from "../../src/core/llm/process.js";

// Real `codex exec` calls on the owner's ChatGPT plan (PLAN.md 15.4). They use a little
// plan quota and bill nothing. Run with: RUN_INTEGRATION=1 npm test (needs Codex 0.164+, signed in).
const codexPath = resolveExecutable(process.env["WEBRUNNER_CODEX_PATH"] ?? "codex");
const enabled = process.env["RUN_INTEGRATION"] === "1" && codexPath !== undefined;
const exec = promisify(execFile);

/** Names of every process below this one right now. */
async function descendantNames(): Promise<string[]> {
  let rows: Array<[number, number, string]>;
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], {
      maxBuffer: 64e6,
    });
    rows = (JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>).map((r) => [r.ProcessId, r.ParentProcessId, r.Name]);
  } else {
    const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,comm="]);
    rows = stdout
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .map(([pid, ppid, ...comm]) => [Number(pid), Number(ppid), comm.join(" ")]);
  }
  const names: string[] = [];
  const stack = [process.pid];
  while (stack.length > 0) {
    const parent = stack.pop();
    for (const [pid, ppid, name] of rows) {
      if (ppid === parent) {
        names.push(name);
        stack.push(pid);
      }
    }
  }
  return names;
}

describe.skipIf(!enabled)("codex-cli backend against the real codex", () => {
  const work = mkdtempSync(join(tmpdir(), "webrunner-codex-live-"));
  const client = createCodexCliClient(loadConfig(), { command: codexPath as string, workDir: work });

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("returns validated structured output, with usage and an API-equivalent cost, and starts nothing but codex", async () => {
    const meter = new CostMeter();
    const call = client.complete({
      role: "scorer",
      system: "You score how relevant a text is to a question, from 0 to 10.",
      messages: [
        {
          role: "user",
          content: "Question: what is the weather in Paris this week?\nText: Paris forecast for this week: sunny Monday to Wednesday with highs of 18 °C, showers on Thursday, 14 °C and windy on Friday.",
        },
      ],
      schema: z.object({ score: z.number().int().min(0).max(10), reason: z.string(), caveat: z.string().optional() }),
      meter,
    });
    let done = false;
    const seen = new Set<string>();
    const watching = (async () => {
      while (!done) for (const name of await descendantNames()) seen.add(name.toLowerCase());
    })();
    const res = await call.finally(() => (done = true));
    await watching;

    expect((res.parsed as { score: number }).score).toBeGreaterThanOrEqual(6);
    expect(res.model).toBe(loadConfig().codex_model ?? DEFAULT_CODEX_MODEL);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(meter.calls).toBe(1);
    // Codex's npm shim, the native binary, and this test's own process listing: no MCP server.
    const allowed = /^(node|codex|conhost|powershell|ps)(\.exe)?$/;
    expect([...seen].filter((name) => !allowed.test(name))).toEqual([]);
    expect([...seen].some((name) => name.startsWith("codex"))).toBe(true);
  }, 180_000);

  it("reads a screenshot passed with --image", async () => {
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
  }, 180_000);
});
