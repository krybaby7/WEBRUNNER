import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PlanStatus } from "../../../src/core/llm/claude-cli.js";
import { DEFAULT_CODEX_MODEL } from "../../../src/core/llm/models.js";
import {
  createFallbackClient,
  createModelClient,
  DEFAULT_LIMITED_MS,
  NO_BACKEND_MESSAGE,
  resolveBackend,
} from "../../../src/core/llm/router.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "../../../src/core/llm/types.js";
import type { Config } from "../../../src/config.js";
import { makeConfig, makeLogger } from "./helpers.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "llm");
const FAKE_CLAUDE = join(FIXTURES, "fake-claude.mjs");
const FAKE_CODEX = join(FIXTURES, "fake-codex.mjs");
const REQ: LlmRequest = { role: "scorer", system: "s", messages: [{ role: "user", content: "q" }] };
const response = (model: string): LlmResponse => ({
  model,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  stopReason: "end_turn",
  text: model,
});
const planLimit = (resetsAt?: number) =>
  new LlmError("provider", "rate_limit", "usage limit reached", {
    retryable: false,
    details: { plan_limit: true, ...(resetsAt !== undefined && { resets_at: resetsAt }) },
  });

const noKey = (over: Partial<Config> = {}): Config => {
  const c = makeConfig(over);
  if (!("anthropic_api_key" in over)) delete c.anthropic_api_key;
  return c;
};
const found = (path: string) => (name: string) => (name === "claude" || name === path ? path : undefined);
const nothing = () => undefined;

describe("resolveBackend (PLAN.md 15.2)", () => {
  it.each<[string, Partial<Config>, (n: string) => string | undefined, string]>([
    ["auto, key set: the API", { anthropic_api_key: "k" }, found("/bin/claude"), "api"],
    ["auto, no key, claude installed: the CLI", {}, found("/bin/claude"), "claude-cli"],
    ["auto, neither: none", {}, nothing, "none"],
    ["api with a key", { llm_backend: "api", anthropic_api_key: "k" }, found("/bin/claude"), "api"],
    ["api without a key: none, even with claude installed", { llm_backend: "api" }, found("/bin/claude"), "none"],
    ["claude-cli wins over a key", { llm_backend: "claude-cli", anthropic_api_key: "k" }, found("/bin/claude"), "claude-cli"],
    ["claude-cli without the executable: none", { llm_backend: "claude-cli" }, nothing, "none"],
  ])("%s", (_name, over, which, backend) => {
    expect(resolveBackend(noKey(over), which).backend).toBe(backend);
  });

  it("looks claude up under claude_path when set", () => {
    const which = vi.fn((n: string) => (n === "D:/tools/claude.exe" ? n : undefined));
    expect(resolveBackend(noKey({ llm_backend: "claude-cli", claude_path: "D:/tools/claude.exe" }), which)).toEqual({
      backend: "claude-cli",
      claudePath: "D:/tools/claude.exe",
    });
    expect(which).toHaveBeenCalledWith("D:/tools/claude.exe");
  });
});

describe("createModelClient", () => {
  it("with no backend, every call is a config error naming both ways to get one, and the server warns once", async () => {
    const logger = makeLogger();
    const { client, info } = createModelClient(noKey(), { which: nothing, logger });
    expect(info).toEqual({ backend: "none", fallback: "none" });
    await expect(client.complete(REQ)).rejects.toMatchObject({ code: "config", kind: "not_configured", message: NO_BACKEND_MESSAGE });
    expect(NO_BACKEND_MESSAGE).toContain("ANTHROPIC_API_KEY");
    expect(NO_BACKEND_MESSAGE).toContain("claude-cli");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("reports the API and the CLI backends", () => {
    expect(createModelClient(noKey({ anthropic_api_key: "k" }), { which: nothing, logger: makeLogger() }).info.backend).toBe("api");
    expect(createModelClient(noKey(), { which: found("/bin/claude"), logger: makeLogger() }).info.backend).toBe("claude-cli");
  });

  it("with llm_fallback codex-cli and codex installed, puts Codex behind the primary and reports it", () => {
    const logger = makeLogger();
    const which = (n: string) => ({ claude: "/bin/claude", "/opt/codex": "/opt/codex" })[n];
    const { info } = createModelClient(noKey({ llm_fallback: "codex-cli", codex_path: "/opt/codex" }), { which, logger });
    expect(info).toEqual({ backend: "claude-cli", fallback: "codex-cli" });
    expect(logger.info).toHaveBeenCalledWith("model fallback", { fallback: "codex-cli", codex_path: "/opt/codex", model: DEFAULT_CODEX_MODEL });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports no fallback, with a warning, when codex is missing or there is no primary for it to stand in for", () => {
    const missing = makeLogger();
    expect(createModelClient(noKey({ llm_fallback: "codex-cli" }), { which: found("/bin/claude"), logger: missing }).info.fallback).toBe("none");
    expect(missing.warn).toHaveBeenCalledWith(expect.stringContaining('no codex executable was found at "codex"'));
    const alone = makeLogger();
    const which = (n: string) => (n === "codex" ? "/bin/codex" : undefined);
    expect(createModelClient(noKey({ llm_fallback: "codex-cli" }), { which, logger: alone }).info).toEqual({ backend: "none", fallback: "none" });
    expect(alone.warn).toHaveBeenCalledWith(expect.stringContaining("there is none"));
  });

  it("replays a call that hits Claude's plan limit on Codex, through both CLIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webrunner-router-"));
    try {
      const which = (n: string) => ({ claude: FAKE_CLAUDE, codex: FAKE_CODEX })[n];
      const env = {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: JSON.stringify({
          events: [
            { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 4102444800 } },
            { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", api_error_status: null },
          ],
          exitCode: 1,
        }),
        FAKE_CODEX_SCENARIO: JSON.stringify({
          events: [
            { type: "item.completed", item: { id: "i", type: "agent_message", text: "from codex" } },
            { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
          ],
        }),
      };
      const { client, info } = createModelClient(noKey({ llm_fallback: "codex-cli", cache_dir: dir }), { which, env, logger: makeLogger() });
      expect(info).toEqual({ backend: "claude-cli", fallback: "codex-cli" });
      const res = await client.complete(REQ);
      expect(res).toMatchObject({ text: "from codex", model: DEFAULT_CODEX_MODEL });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});

describe("createFallbackClient (PLAN.md 15.2)", () => {
  function setup(opts: { primary: LlmClient["complete"]; plan?: PlanStatus; maxUtilization?: number }) {
    let now = Date.UTC(2026, 9, 26, 12);
    const primary = { complete: vi.fn(opts.primary), planStatus: () => opts.plan };
    const fallback = { complete: vi.fn(async () => response("codex")) };
    const client = createFallbackClient(primary, fallback, {
      logger: makeLogger(),
      now: () => now,
      ...(opts.maxUtilization !== undefined && { maxUtilization: opts.maxUtilization }),
    });
    return { client, primary, fallback, advance: (ms: number) => (now += ms), now: () => now };
  }

  it("uses the primary while it answers", async () => {
    const s = setup({ primary: async () => response("claude") });
    expect((await s.client.complete(REQ)).model).toBe("claude");
    expect(s.fallback.complete).not.toHaveBeenCalled();
  });

  it("replays a plan-limited call on the fallback and keeps using it until the reset", async () => {
    const resetsAt = Math.floor(Date.UTC(2026, 9, 26, 15) / 1000);
    const s = setup({ primary: async () => Promise.reject(planLimit(resetsAt)) });
    expect((await s.client.complete(REQ)).model).toBe("codex");
    expect(s.fallback.complete).toHaveBeenCalledWith(REQ);
    expect(s.client.limitedUntil()).toBe(resetsAt * 1000);

    s.advance(60 * 60_000);
    await s.client.complete(REQ);
    expect(s.primary.complete).toHaveBeenCalledTimes(1);

    s.primary.complete.mockImplementation(async () => response("claude"));
    s.advance(3 * 60 * 60_000);
    expect((await s.client.complete(REQ)).model).toBe("claude");
    expect(s.client.limitedUntil()).toBeUndefined();
  });

  it("skips the primary for 15 minutes when Claude gave no reset time", async () => {
    const s = setup({ primary: async () => Promise.reject(planLimit()) });
    await s.client.complete(REQ);
    expect(s.client.limitedUntil()).toBe(s.now() + DEFAULT_LIMITED_MS);
  });

  it.each([
    ["a retryable rate limit", new LlmError("provider", "rate_limit", "429", { retryable: true })],
    ["a schema error", new LlmError("provider", "schema", "bad", { retryable: false })],
    ["a refusal", new LlmError("provider", "refusal", "no", { retryable: false })],
    ["a budget stop", new LlmError("budget_exceeded", "api", "cap", { retryable: false })],
  ])("does not retry %s on the fallback", async (_name, err) => {
    const s = setup({ primary: async () => Promise.reject(err) });
    await expect(s.client.complete(REQ)).rejects.toBe(err);
    expect(s.fallback.complete).not.toHaveBeenCalled();
  });

  it("with claude_max_utilization below 1, goes to the fallback once a window passes it, until that window resets", async () => {
    const resetsAt = Math.floor(Date.UTC(2026, 9, 28) / 1000);
    const plan: PlanStatus = { status: "allowed", windows: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.93, resetsAt } } };
    const s = setup({ primary: async () => response("claude"), plan, maxUtilization: 0.9 });
    expect((await s.client.complete(REQ)).model).toBe("codex");
    expect(s.client.limitedUntil()).toBe(resetsAt * 1000);
  });

  it("ignores utilization at the default of 1", async () => {
    const plan: PlanStatus = { status: "allowed", windows: { seven_day: { utilization: 0.99 } } };
    const s = setup({ primary: async () => response("claude"), plan });
    expect((await s.client.complete(REQ)).model).toBe("claude");
  });
});
