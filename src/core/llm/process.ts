import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

/**
 * Child processes for the CLI model backends (PLAN.md 15.3, 15.4): run one
 * command with its prompt on stdin, collect stdout and stderr, and kill it on a
 * timeout or an abort. Nothing here writes to this process's stdout.
 */

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  /** Null when the child was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when this module killed the child. */
  killed?: "timeout" | "abort";
}

/** Rejects only when the child cannot be started (ENOENT, EACCES); every exit resolves. */
export type RunProcess = (opts: RunOptions) => Promise<RunResult>;

/** Output beyond this is dropped; a model reply in stream-json is far smaller. */
const MAX_OUTPUT_CHARS = 32 * 1024 * 1024;

export const runProcess: RunProcess = (opts) =>
  new Promise((resolve, reject) => {
    const { command, args } = launchable(opts.command, opts.args);
    let killed: RunResult["killed"];
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // A console program started from a GUI parent on Windows would otherwise flash a window.
      windowsHide: true,
    });

    const kill = (why: "timeout" | "abort"): void => {
      if (killed !== undefined || child.exitCode !== null) return;
      killed = why;
      killTree(child);
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = (): void => kill("abort");
    if (opts.signal?.aborted === true) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    // A child that exits before reading its input closes the pipe; that is reported through its exit.
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (exitCode) => {
      cleanup();
      resolve({ exitCode, stdout, stderr, ...(killed !== undefined && { killed }) });
    });
    child.stdin.end(opts.stdin);
  });

/**
 * Kills the child and everything it started. On Windows a killed Node shim
 * (npm's `codex`) would leave the native binary it launched running, holding
 * our pipes open, so the whole tree goes. Elsewhere SIGTERM reaches the child,
 * and the npm shims forward it.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.on("error", () => child.kill());
    return;
  }
  child.kill();
}

/**
 * How to start `command`. A Node script (`.js`, `.mjs`, `.cjs`) runs under
 * this Node. An npm `.cmd` shim, which Node can only start through cmd.exe
 * (and its quoting), is resolved to the script it wraps.
 */
export function launchable(command: string, args: readonly string[]): { command: string; args: string[] } {
  const ext = extname(command).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: process.execPath, args: [command, ...args] };
  if (ext === ".cmd" || ext === ".bat") {
    const script = npmShimTarget(command);
    if (script !== undefined) return { command: process.execPath, args: [script, ...args] };
  }
  return { command, args: [...args] };
}

/** The script an npm-generated `.cmd` shim runs (`"%dp0%\node_modules\...\cli.js" %*`), if it is one. */
export function npmShimTarget(shimPath: string, text?: string): string | undefined {
  let body = text;
  if (body === undefined) {
    try {
      body = readFileSync(shimPath, "utf8");
    } catch {
      return undefined;
    }
  }
  const m = /"%(?:~?dp0)%\\?([^"%]+\.(?:c|m)?js)"/i.exec(body);
  return m?.[1] !== undefined ? join(dirname(shimPath), m[1]) : undefined;
}

/**
 * Finds an executable the way a shell would: a path with a directory part is
 * taken as it is; a bare name is looked up on PATH (with PATHEXT on Windows).
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(name) || /[\\/]/.test(name)) return isFile(name) ? name : undefined;
  const pathVar = envValue(env, "PATH") ?? "";
  const exts =
    platform === "win32"
      ? ["", ...(envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")]
      : [""];
  for (const dir of pathVar.split(platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const ext of exts) {
      // On Windows a bare name without an extension is not runnable (it is the sh shim npm also writes).
      if (platform === "win32" && ext === "" && extname(name) === "") continue;
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Environment variables are case-insensitive on Windows; a copied env object is not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key !== undefined ? env[key] : undefined;
}

/** `env` without the named variables, matched case-insensitively. */
export function withoutVars(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((n) => n.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toUpperCase())));
}

/** A counting semaphore: at most `size` holders at once, the rest wait in order. */
export class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly size: number) {
    this.free = size;
  }

  /** Resolves with a release function. Rejects if `signal` aborts while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    const release = (): void => {
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.free++;
    };
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(once(release));
      };
      const onAbort = (): void => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted === true) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  /** Holders right now. */
  get inUse(): number {
    return this.size - this.free;
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
