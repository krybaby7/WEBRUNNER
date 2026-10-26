import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { probeChromium, startFixtureServer, type FixtureServer } from "./browser/helpers.js";

/**
 * Shutdown and orphan test (PLAN.md WP14: killing the server mid-browse leaves
 * no orphan Chromium). Spawns the built server, makes it launch a real
 * Chromium with a throwaway profile directory, stops the server and checks
 * that it exits 0 within 10 s and that no process using that profile remains.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(root, "dist", "index.js");
const EXIT_DEADLINE_MS = 10_000;
// Windows has no SIGTERM: child.kill() ends the process at once without running its handlers.
const isWindows = process.platform === "win32";

const probe = await probeChromium();
if (!probe.available) console.warn(`[shutdown test] ${probe.reason}: the shutdown tests that need Chromium are skipped`);

interface Proc {
  pid: number;
  args: string;
}

/** Every process's command line. /proc where it exists, CIM on Windows, else `ps`. */
function listProcesses(): Proc[] {
  if (process.platform === "win32") {
    const cim = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'],
      { encoding: "utf8" },
    );
    return cim.stdout
      .split(/\r?\n/)
      .map((line) => /^(\d+)\s+(.+)$/.exec(line))
      .flatMap((m) => (m !== null ? [{ pid: Number(m[1]), args: m[2] ?? "" }] : []));
  }
  if (existsSync("/proc/self/cmdline")) {
    const out: Proc[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim();
        if (args !== "") out.push({ pid: Number(name), args });
      } catch {
        // The process exited while we were looking.
      }
    }
    return out;
  }
  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  return ps.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .flatMap((m) => (m !== null ? [{ pid: Number(m[1]), args: m[2] ?? "" }] : []));
}

/** Processes started with this profile directory: the browser and its helpers. */
function browserProcesses(profileDir: string): Proc[] {
  return listProcesses().filter((p) => p.args.includes(profileDir) && p.pid !== process.pid);
}

async function until<T>(what: string, timeoutMs: number, probeFn: () => T | undefined, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probeFn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Where Playwright keeps its browsers, so the server (which gets a clean HOME) finds the same Chromium. */
function browsersPath(): string | undefined {
  const fromEnv = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return /^(.*?)[\\/](?:chromium|chromium_headless_shell)-\d+/.exec(chromium.executablePath())?.[1];
  } catch {
    return undefined;
  }
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  profileDir: string;
  stderr: () => string;
  /** Resolves with the JSON-RPC message that answers `id`. */
  response(id: number, timeoutMs?: number): Promise<{ result?: unknown; error?: unknown }>;
  send(message: object): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shutdown-test", version: "0" } },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("shutdown", () => {
  const dirs: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const profiles: string[] = [];
  let fixtures: FixtureServer | undefined;

  beforeAll(() => {
    // `npm test` builds first (pretest). Build on demand when vitest is run directly.
    if (!existsSync(entry)) {
      const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }, 120_000);

  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // Never leave Chromium running after the tests, whatever went wrong.
    for (const profileDir of profiles.splice(0)) {
      for (const p of browserProcesses(profileDir)) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await fixtures?.close();
    fixtures = undefined;
    // Windows keeps a dead process's files locked for a moment.
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 30_000);

  function start(extraEnv: Record<string, string> = {}): Running {
    const home = mkdtempSync(join(tmpdir(), "webrunner-shutdown-home-"));
    const profileDir = mkdtempSync(join(tmpdir(), "webrunner-shutdown-profile-"));
    dirs.push(home, profileDir);
    profiles.push(profileDir);
    const pwPath = browsersPath();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        // A clean environment: no keys, and an empty HOME so the developer's own config file is never read.
        HOME: home,
        WEBRUNNER_BROWSER_PROFILE_DIR: profileDir,
        WEBRUNNER_CACHE_DIR: join(home, "cache"),
        BROWSER_HEADLESS: "true",
        ...(pwPath !== undefined && { PLAYWRIGHT_BROWSERS_PATH: pwPath }),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);

    let stdout = "";
    let stderr = "";
    const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
    const seen = new Map<number, { result?: unknown; error?: unknown }>();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        if (line === "") continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined) {
          seen.set(msg.id, msg);
          waiting.get(msg.id)?.(msg);
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const send = (message: object): void => {
      child.stdin.write(JSON.stringify(message) + "\n");
    };
    return {
      child,
      profileDir,
      stderr: () => stderr,
      send,
      exited,
      response: (id, timeoutMs = 30_000) =>
        new Promise((resolve, reject) => {
          const have = seen.get(id);
          if (have !== undefined) {
            resolve(have);
            return;
          }
          const timer = setTimeout(() => reject(new Error(`no response to request ${id} after ${timeoutMs} ms\nstderr:\n${stderr}`)), timeoutMs);
          waiting.set(id, (m) => {
            clearTimeout(timer);
            resolve(m);
          });
        }),
    };
  }

  async function handshake(server: Running): Promise<void> {
    server.send(initialize);
    await server.response(1);
    server.send(initialized);
  }

  /** Stops the server with `stop` and checks the exit and the absence of orphans within the deadline. */
  async function expectCleanShutdown(server: Running, stop: () => void, opts: { expectRunning?: boolean } = {}): Promise<void> {
    if (opts.expectRunning ?? true) {
      const before = browserProcesses(server.profileDir);
      expect(before.length, "Chromium should be running before the server is stopped").toBeGreaterThan(0);
    }

    const stoppedAt = Date.now();
    stop();
    const outcome = await Promise.race([
      server.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), EXIT_DEADLINE_MS)),
    ]);
    const exitMs = Date.now() - stoppedAt;
    if (outcome === "timeout") throw new Error(`the server did not exit within ${EXIT_DEADLINE_MS} ms\nstderr:\n${server.stderr()}`);
    expect({ code: outcome.code, signal: outcome.signal }, `stderr:\n${server.stderr()}`).toEqual({ code: 0, signal: null });
    expect(exitMs).toBeLessThan(EXIT_DEADLINE_MS);

    // No Chromium (or helper) using this profile may remain, within the same deadline.
    const left = await until("the browser processes to disappear", Math.max(500, EXIT_DEADLINE_MS - exitMs), () => {
      const remaining = browserProcesses(server.profileDir);
      return remaining.length === 0 ? [] : undefined;
    }).catch(() => browserProcesses(server.profileDir));
    expect(left.map((p) => `${p.pid} ${p.args.slice(0, 120)}`), "orphaned browser processes").toEqual([]);
  }

  it.skipIf(isWindows)("exits 0 on SIGTERM when no browser was ever started", async () => {
    const server = start();
    await handshake(server);
    const started = Date.now();
    server.child.kill("SIGTERM");
    const { code, signal } = await server.exited;
    expect({ code, signal }, server.stderr()).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  it("exits 0 when the client closes stdin", async () => {
    const server = start();
    await handshake(server);
    server.child.stdin.end();
    const { code, signal } = await server.exited;
    expect({ code, signal }, server.stderr()).toEqual({ code: 0, signal: null });
  }, 30_000);

  describe.skipIf(!probe.available)(`with a real Chromium${probe.available ? "" : ` (skipped: ${probe.reason})`}`, () => {
    it.skipIf(isWindows)("SIGTERM in the middle of a browser fetch leaves no Chromium behind", async () => {
      fixtures = await startFixtureServer();
      const server = start();
      await handshake(server);
      // /hang accepts the request and never answers: the fetch is still in flight when the server is stopped.
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fetch_page", arguments: { url: `${fixtures.url}/hang`, mode: "browser" } },
      });
      await until("Chromium to start", 30_000, () => (browserProcesses(server.profileDir).length > 0 ? true : undefined));
      await expectCleanShutdown(server, () => server.child.kill("SIGTERM"));
    }, 60_000);

    it.skipIf(isWindows)("SIGTERM with an idle browser after a finished fetch leaves no Chromium behind", async () => {
      fixtures = await startFixtureServer();
      const server = start();
      await handshake(server);
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fetch_page", arguments: { url: `${fixtures.url}/article.html`, mode: "browser", max_chars: 2000 } },
      });
      const reply = (await server.response(2, 45_000)) as { result?: { isError?: boolean; structuredContent?: { method?: string } } };
      expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true);
      expect(reply.result?.structuredContent?.method).toBe("browser");
      await expectCleanShutdown(server, () => server.child.kill("SIGTERM"));
    }, 60_000);

    it.skipIf(isWindows)("SIGTERM while Chromium is still starting does not orphan it either", async () => {
      fixtures = await startFixtureServer();
      const server = start();
      await handshake(server);
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fetch_page", arguments: { url: `${fixtures.url}/hang`, mode: "browser" } },
      });
      // Stop right after the request is sent: the browser is launching or not yet started.
      await new Promise((r) => setTimeout(r, 150));
      await expectCleanShutdown(server, () => server.child.kill("SIGTERM"), { expectRunning: false });
    }, 60_000);

    it("closing stdin in the middle of a browser fetch also leaves no Chromium behind", async () => {
      fixtures = await startFixtureServer();
      const server = start();
      await handshake(server);
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fetch_page", arguments: { url: `${fixtures.url}/hang`, mode: "browser" } },
      });
      await until("Chromium to start", 30_000, () => (browserProcesses(server.profileDir).length > 0 ? true : undefined));
      await expectCleanShutdown(server, () => server.child.stdin.end());
    }, 60_000);

    // What a client does on Windows when it gives up on a server: no handler runs, so nothing in
    // webrunner closes the browser. Chromium must still not outlive the server.
    it.runIf(isWindows)("a hard kill in the middle of a browser fetch leaves no Chromium behind (Windows)", async () => {
      fixtures = await startFixtureServer();
      const server = start();
      await handshake(server);
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fetch_page", arguments: { url: `${fixtures.url}/hang`, mode: "browser" } },
      });
      await until("Chromium to start", 30_000, () => (browserProcesses(server.profileDir).length > 0 ? true : undefined));
      server.child.kill();
      await server.exited;
      const left = await until("the browser processes to disappear", EXIT_DEADLINE_MS, () => {
        const remaining = browserProcesses(server.profileDir);
        return remaining.length === 0 ? [] : undefined;
      }).catch(() => browserProcesses(server.profileDir));
      expect(left.map((p) => `${p.pid} ${p.args.slice(0, 120)}`), "orphaned browser processes").toEqual([]);
    }, 60_000);
  });
});
