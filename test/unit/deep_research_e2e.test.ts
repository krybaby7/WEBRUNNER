import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "../../src/schemas/error.js";

/**
 * End to end over real stdio: the built server, an empty HOME and no API keys.
 * `deep_research` must be listed, and calling it must return the 3.6 error
 * envelope with code `config`, with stdout carrying nothing but JSON-RPC frames.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(root, "dist", "index.js");

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "webrunner-e2e-"));
  // `npm test` builds first (pretest). Build on demand when vitest is run directly.
  if (!existsSync(entry)) {
    const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
  }
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runServer(requests: object[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      // llm_backend "api" with no key means no backend, whether or not this machine has the claude CLI:
      // the default ("auto") would find an installed claude and spend the owner's subscription.
      env: { PATH: process.env["PATH"] ?? "", HOME: home, WEBRUNNER_LLM_BACKEND: "api" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);
    child.on("close", () => clearTimeout(timer));

    for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
    child.stdin.end();
  });
}

interface Frame {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

function parseFrames(stdout: string): Frame[] {
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`non-JSON line on stdout: ${JSON.stringify(line)}`);
      }
      expect(parsed).toMatchObject({ jsonrpc: "2.0" });
      return parsed as Frame;
    });
}

describe("deep_research over stdio", () => {
  it("is listed, and without ANTHROPIC_API_KEY returns the config error envelope", async () => {
    const { stdout, code } = await runServer([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-test", version: "0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "deep_research", arguments: { question: "test" } } },
    ]);

    // Stdout purity: three responses (initialize, list, call) and nothing else.
    const frames = parseFrames(stdout);
    expect(frames).toHaveLength(3);
    const byId = new Map(frames.map((f) => [f.id, f]));

    const tools = (byId.get(2)?.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
    const tool = tools.find((t) => t.name === "deep_research");
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["question", "depth"]));

    const call = byId.get(3)?.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    expect(call.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(JSON.parse(call.content[0]?.text ?? "{}"));
    expect(envelope.error.code).toBe("config");
    expect(envelope.error.message).toContain("ANTHROPIC_API_KEY");
    expect(envelope.error.retryable).toBe(false);
    expect(call.structuredContent).toEqual(envelope);

    expect(code).toBe(0);
  });
});
