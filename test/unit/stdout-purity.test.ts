import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(root, "dist", "index.js");

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "webrunner-smoke-"));
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
    // A clean environment: no keys, and HOME points at an empty directory so
    // the developer's real ~/.config/webrunner/config.json is never read.
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "", HOME: home },
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

    // Newline-delimited JSON, as used by the stdio transport.
    for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
    child.stdin.end();
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("stdio server smoke test", () => {
  it("lists ping and writes only JSON-RPC frames to stdout", async () => {
    const { stdout, code } = await runServer([
      initialize,
      initialized,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } },
    ]);

    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Stdout purity: every line is a JSON-RPC 2.0 message, nothing else.
    const messages = lines.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`non-JSON line on stdout: ${JSON.stringify(line)}`);
      }
      expect(parsed).toMatchObject({ jsonrpc: "2.0" });
      return parsed as { id?: number; result?: Record<string, unknown> };
    });

    const byId = new Map(messages.filter((m) => m.id !== undefined).map((m) => [m.id, m]));

    const list = byId.get(2)?.result as { tools: Array<{ name: string }> } | undefined;
    expect(list?.tools.map((t) => t.name)).toContain("ping");
    expect(list?.tools.map((t) => t.name)).toContain("web_search");
    expect(list?.tools.map((t) => t.name)).toContain("fetch_page");
    expect(list?.tools.map((t) => t.name)).toContain("browse_task");
    expect(list?.tools.map((t) => t.name)).toContain("search_flights");
    expect(list?.tools.map((t) => t.name)).toContain("social_search");
    expect(list?.tools.map((t) => t.name)).toContain("search_hotels");
    expect(list?.tools.map((t) => t.name)).toContain("deep_research");
    expect(list?.tools.map((t) => t.name)).toContain("accounts");
    expect(list?.tools.map((t) => t.name)).toContain("health");

    const ping = byId.get(3)?.result as
      | { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> }
      | undefined;
    expect(ping?.structuredContent).toMatchObject({ ok: true, version: expect.any(String) });
    const text = JSON.parse(ping?.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(text).toEqual(ping?.structuredContent);
    expect(Number.isNaN(Date.parse(String(text["time"])))).toBe(false);

    expect(code).toBe(0);
  });

  it("logs to stderr only, as JSON lines", async () => {
    const { stdout, stderr } = await runServer([initialize]);
    expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
    const lines = stderr.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ level: expect.any(String), msg: expect.any(String) });
    }
  });

  it("fails startup with a readable message on invalid config", async () => {
    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, [entry], {
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "", HOME: home, RESEARCH_MAX_COST_USD: "abc" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code }));
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("RESEARCH_MAX_COST_USD");
  });
});
