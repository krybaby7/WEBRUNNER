// A stand-in for `codex exec` (PLAN.md 15.4, WP35). It records how it was called
// to FAKE_CODEX_RECORD (one JSON line when it starts, one when it ends), including
// the output schema and the image files it was handed, and replays the --json
// events of FAKE_CODEX_SCENARIO:
//   { "events": [...], "delayMs": 0, "exitCode": 0, "stderr": "...", "grandchild": false }
// With "grandchild", it first starts a long-running child that shares its output
// pipes, forwards SIGTERM to it as npm's codex.js does, and records its pid.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";

const scenario = JSON.parse(process.env.FAKE_CODEX_SCENARIO ?? "{}");
const argv = process.argv.slice(2);
const chunks = [];

function record(extra) {
  const file = process.env.FAKE_CODEX_RECORD;
  if (file === undefined || file === "") return;
  appendFileSync(file, JSON.stringify({ pid: process.pid, ...extra }) + "\n");
}

function valuesOf(flag) {
  return argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
}

let grandchild;
if (scenario.grandchild === true) {
  grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
  process.on("SIGTERM", () => grandchild.kill("SIGTERM"));
}

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const schemaFile = valuesOf("--output-schema")[0];
  record({
    phase: "start",
    at: Date.now(),
    argv,
    cwd: process.cwd(),
    stdin: Buffer.concat(chunks).toString("utf8"),
    schema: schemaFile !== undefined ? JSON.parse(readFileSync(schemaFile, "utf8")) : null,
    images: valuesOf("--image").map((f) => ({ file: f, base64: existsSync(f) ? readFileSync(f).toString("base64") : null })),
    grandchildPid: grandchild?.pid ?? null,
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
    },
  });
  setTimeout(() => {
    for (const e of scenario.events ?? []) process.stdout.write(JSON.stringify(e) + "\n");
    if (scenario.stderr !== undefined) process.stderr.write(scenario.stderr + "\n");
    record({ phase: "end", at: Date.now() });
    grandchild?.kill();
    process.exitCode = scenario.exitCode ?? 0;
  }, scenario.delayMs ?? 0);
});
