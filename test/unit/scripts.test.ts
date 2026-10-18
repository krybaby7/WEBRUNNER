import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = {
  claude: join(root, "scripts", "install-claude-code.sh"),
  codex: join(root, "scripts", "install-codex.sh"),
  uninstall: join(root, "scripts", "uninstall.sh"),
};

/** Every variable the install scripts know about; cleared from the child environment unless a test sets it. */
const WEBRUNNER_VARS = [
  "ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "EXA_API_KEY",
  "TAVILY_API_KEY",
  "PERPLEXITY_API_KEY",
  "FIRECRAWL_API_KEY",
  "JINA_API_KEY",
  "DUFFEL_API_KEY",
  "BROWSER_CDP_URL",
  "BROWSER_HEADLESS",
  "RESEARCH_MAX_COST_USD",
  "WEBRUNNER_CACHE_DIR",
  "WEBRUNNER_LOG_LEVEL",
  "WEBRUNNER_BROWSER_PROFILE_DIR",
  "WEBRUNNER_SAVE_SCREENSHOTS",
  "WEBRUNNER_CURRENCY",
  "WEBRUNNER_MODEL_PLANNER",
  "WEBRUNNER_MODEL_SCORER",
  "WEBRUNNER_MODEL_EXTRACTOR",
  "WEBRUNNER_MODEL_WRITER",
];

// Obviously fake values that must never show up in a file or in output.
const SECRET_ANTHROPIC = "sentinel-anthropic-0001";
const SECRET_BRAVE = "sentinel-brave-0002";
const SECRET_EXA = "sentinel-exa-0003";

let work: string;
let home: string;
let fakeBin: string;
let claudeLog: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "webrunner-scripts-"));
  home = join(work, "home");
  fakeBin = join(work, "bin");
  claudeLog = join(work, "claude-calls.log");
  mkdirSync(home);
  mkdirSync(fakeBin);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A `claude` stand-in that records its arguments and succeeds. */
function installFakeClaude(): void {
  const path = join(fakeBin, "claude");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeLog}'\nexit 0\n`);
  chmodSync(path, 0o755);
}

function runScript(script: string, args: string[], extraEnv: Record<string, string> = {}, replacePath = false) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !WEBRUNNER_VARS.includes(k)) env[k] = v;
  }
  env["HOME"] = home;
  env["PATH"] = `${fakeBin}:${process.env["PATH"] ?? ""}`;
  Object.assign(env, extraEnv);
  if (replacePath) env["PATH"] = extraEnv["PATH"] ?? "";
  const r = spawnSync("bash", [script, ...args], { env, encoding: "utf8", cwd: work });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}

const codexConfig = (): string => join(home, ".codex", "config.toml");
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("shell syntax", () => {
  for (const [name, path] of Object.entries(scripts)) {
    it(`bash -n ${name}`, () => {
      const r = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });
  }
});

describe("install-codex.sh", () => {
  const keys = { ANTHROPIC_API_KEY: SECRET_ANTHROPIC, BRAVE_API_KEY: SECRET_BRAVE, EXA_API_KEY: SECRET_EXA };

  it("writes one block, replaces it on the second run, and never writes a key value", () => {
    const first = runScript(scripts.codex, ["--skip-build"], keys);
    expect(first.status, first.all).toBe(0);
    const once = readFileSync(codexConfig(), "utf8");
    expect(count(once, "[mcp_servers.webrunner]")).toBe(1);
    expect(once).toContain('command = "node"');
    expect(once).toContain(`args = ["${join(root, "dist", "index.js")}"]`);
    expect(once).toContain('env_vars = ["ANTHROPIC_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"]');
    expect(once).not.toContain("TAVILY_API_KEY");

    const second = runScript(scripts.codex, ["--skip-build"], keys);
    expect(second.status, second.all).toBe(0);
    expect(readFileSync(codexConfig(), "utf8")).toBe(once);

    // A changed environment replaces the block rather than adding a second one.
    const third = runScript(scripts.codex, ["--skip-build"], { BRAVE_API_KEY: SECRET_BRAVE });
    expect(third.status, third.all).toBe(0);
    const replaced = readFileSync(codexConfig(), "utf8");
    expect(count(replaced, "[mcp_servers.webrunner]")).toBe(1);
    expect(replaced).toContain('env_vars = ["BRAVE_API_KEY"]');
    expect(replaced).not.toContain("EXA_API_KEY");

    for (const output of [once, replaced, first.all, second.all, third.all]) {
      for (const secret of [SECRET_ANTHROPIC, SECRET_BRAVE, SECRET_EXA]) expect(output).not.toContain(secret);
    }
  });

  it("keeps unrelated config, replaces an unmarked webrunner table and backs the file up", () => {
    mkdirSync(join(home, ".codex"));
    const original = [
      'model = "something"',
      "",
      "[mcp_servers.other]",
      'command = "other-server"',
      "",
      "[mcp_servers.webrunner]",
      'command = "stale"',
      "",
      "[mcp_servers.webrunner.env]",
      'OLD = "value"',
      "",
      "[mcp_servers.webrunner-extra]",
      'command = "keep-me"',
      "",
    ].join("\n");
    writeFileSync(codexConfig(), original);

    const r = runScript(scripts.codex, ["--skip-build"], keys);
    expect(r.status, r.all).toBe(0);
    const text = readFileSync(codexConfig(), "utf8");
    expect(count(text, "[mcp_servers.webrunner]")).toBe(1);
    expect(text).not.toContain("stale");
    expect(text).not.toContain("OLD =");
    expect(text).toContain('model = "something"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain("[mcp_servers.webrunner-extra]");
    expect(text).toContain('command = "keep-me"');

    const backups = readdirSync(join(home, ".codex")).filter((f) => f.startsWith("config.toml.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, ".codex", backups[0] as string), "utf8")).toBe(original);
  });

  it("--dry-run prints the block and writes nothing", () => {
    const r = runScript(scripts.codex, ["--dry-run"], keys);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain("[mcp_servers.webrunner]");
    expect(r.stdout).toContain('env_vars = ["ANTHROPIC_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"]');
    expect(existsSync(join(home, ".codex"))).toBe(false);
    for (const secret of [SECRET_ANTHROPIC, SECRET_BRAVE, SECRET_EXA]) expect(r.all).not.toContain(secret);
  });

  it("uninstall.sh removes the block and leaves the rest", () => {
    installFakeClaude();
    mkdirSync(join(home, ".codex"));
    writeFileSync(codexConfig(), 'model = "something"\n');
    expect(runScript(scripts.codex, ["--skip-build"], keys).status).toBe(0);
    expect(readFileSync(codexConfig(), "utf8")).toContain("[mcp_servers.webrunner]");

    const dry = runScript(scripts.uninstall, ["--dry-run"]);
    expect(dry.status, dry.all).toBe(0);
    expect(readFileSync(codexConfig(), "utf8")).toContain("[mcp_servers.webrunner]");
    expect(existsSync(claudeLog)).toBe(false);

    const r = runScript(scripts.uninstall, []);
    expect(r.status, r.all).toBe(0);
    expect(readFileSync(codexConfig(), "utf8")).toBe('model = "something"\n');
    expect(readFileSync(claudeLog, "utf8").trim()).toBe("mcp remove --scope user webrunner");
  });
});

describe("install-claude-code.sh", () => {
  const keys = { BRAVE_API_KEY: SECRET_BRAVE, WEBRUNNER_CURRENCY: "EUR" };

  it("--dry-run prints the claude command, redacts keys and does not execute claude", () => {
    installFakeClaude();
    const r = runScript(scripts.claude, ["--dry-run"], keys);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain("claude mcp add --scope user");
    expect(r.stdout).toContain("--env BRAVE_API_KEY=REDACTED");
    expect(r.stdout).toContain("--env WEBRUNNER_CURRENCY=EUR");
    expect(r.stdout).toContain("--transport stdio webrunner -- node");
    expect(r.stdout).toContain(join(root, "dist", "index.js"));
    expect(r.stdout).not.toContain("EXA_API_KEY");
    expect(r.all).not.toContain(SECRET_BRAVE);
    expect(existsSync(claudeLog)).toBe(false);
  });

  it("--dry-run works without the claude CLI installed, a real run explains what to install", () => {
    // A PATH holding only the tools the script needs, so no real claude is visible.
    const bare = join(work, "bare-bin");
    mkdirSync(bare);
    for (const tool of ["bash", "node", "dirname", "sed", "cat"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found !== "") symlinkSync(found, join(bare, tool));
    }
    const only = { PATH: bare };

    const dry = runScript(scripts.claude, ["--dry-run"], only, true);
    expect(dry.status, dry.all).toBe(0);
    expect(dry.stdout).toContain("claude mcp add --scope user");
    expect(dry.stderr).toContain("claude CLI is not on PATH");

    const real = runScript(scripts.claude, ["--skip-build"], only, true);
    expect(real.status).toBe(1);
    expect(real.stderr).toContain("claude CLI is not installed");
    expect(real.stderr).toContain("claude-code");
  });

  it("removes then re-adds the server with only the set variables as --env flags", () => {
    installFakeClaude();
    const r = runScript(scripts.claude, ["--skip-build"], keys);
    expect(r.status, r.all).toBe(0);
    const calls = readFileSync(claudeLog, "utf8").trim().split("\n");
    expect(calls).toEqual([
      "mcp remove --scope user webrunner",
      `mcp add --scope user --env BRAVE_API_KEY=${SECRET_BRAVE} --env WEBRUNNER_CURRENCY=EUR --transport stdio webrunner -- node ${join(root, "dist", "index.js")}`,
    ]);
    // The key reaches claude (that is the point) but is not echoed by the script.
    expect(r.all).not.toContain(SECRET_BRAVE);
  });

  it("--no-env passes no variables", () => {
    installFakeClaude();
    const r = runScript(scripts.claude, ["--skip-build", "--no-env"], keys);
    expect(r.status, r.all).toBe(0);
    expect(readFileSync(claudeLog, "utf8")).not.toContain("--env");
  });
});
