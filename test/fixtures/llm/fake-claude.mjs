// A stand-in for `claude -p` (PLAN.md 15.6, WP34). It records how it was called
// to FAKE_CLAUDE_RECORD (one JSON line when it starts, one when it ends) and
// replays the stream-json events of FAKE_CLAUDE_SCENARIO:
//   { "events": [...], "delayMs": 0, "exitCode": 0, "stderr": "..." }
import { Buffer } from "node:buffer";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";

const scenario = JSON.parse(process.env.FAKE_CLAUDE_SCENARIO ?? "{}");
const argv = process.argv.slice(2);
const chunks = [];

function record(extra) {
  const file = process.env.FAKE_CLAUDE_RECORD;
  if (file === undefined || file === "") return;
  appendFileSync(file, JSON.stringify({ pid: process.pid, ...extra }) + "\n");
}

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const i = argv.indexOf("--system-prompt-file");
  record({
    phase: "start",
    at: Date.now(),
    argv,
    cwd: process.cwd(),
    stdin: Buffer.concat(chunks).toString("utf8"),
    systemPrompt: i >= 0 ? readFileSync(argv[i + 1], "utf8") : null,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
    },
  });
  setTimeout(() => {
    for (const e of scenario.events ?? []) process.stdout.write(JSON.stringify(e) + "\n");
    if (scenario.stderr !== undefined) process.stderr.write(scenario.stderr + "\n");
    record({ phase: "end", at: Date.now() });
    process.exitCode = scenario.exitCode ?? 0;
  }, scenario.delayMs ?? 0);
});
