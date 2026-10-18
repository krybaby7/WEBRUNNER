import { afterEach, describe, expect, it } from "vitest";
import { AccountsError, type AccountsListOutput, type AccountsService } from "../../../src/core/accounts/index.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { AccountsOutputObjectSchema, registerAccountsTool, type AccountsToolOptions } from "../../../src/tools/accounts.js";
import { AccountsOutputSchema } from "../../../src/schemas/accounts.js";
import { TOOL_WALL_CLOCK_MS } from "../../../src/tools/guard.js";
import { makeConfig } from "../llm/helpers.js";
import { recordingLogger } from "../research/helpers.js";
import { callTool, connectServer, fakeBrowser, type Connected, type ToolResult } from "../tools/helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const LIST: AccountsListOutput = {
  action: "list",
  mode: "persistent",
  profile_dir: "/tmp/profile",
  accounts: [
    { platform: "reddit", connected: true, domains: ["reddit.com"], used_by: ["social_search (reddit)"], checked_at: "2026-10-18T12:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z" },
    { platform: "google", connected: false, domains: ["google.com"], used_by: ["search_hotels"], checked_at: "2026-10-18T12:00:00.000Z" },
  ],
  caveats: ["c"],
};

function forever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function fakeService(over: Partial<AccountsService> = {}): AccountsService & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const svc: AccountsService & { calls: unknown[][] } = {
    calls,
    list: () => {
      calls.push(["list"]);
      return Promise.resolve(LIST);
    },
    connect: (platform, waitSeconds) => {
      calls.push(["connect", platform, waitSeconds]);
      return Promise.resolve({
        action: "connect",
        platform,
        status: "pending",
        login_url: "https://www.reddit.com/login/",
        waited_s: waitSeconds,
        instructions: "log in",
        caveats: [],
      });
    },
    disconnect: (platform) => {
      calls.push(["disconnect", platform]);
      return Promise.resolve({ action: "disconnect", platform, status: "disconnected", cookies_cleared: 3, caveats: [] });
    },
    connectedPlatforms: () => Promise.resolve([]),
    ...over,
  };
  return svc;
}

async function connect(options: AccountsToolOptions, depsOver: Partial<Deps> = {}): Promise<Connected & { lines: ReturnType<typeof recordingLogger>["lines"] }> {
  const { logger, lines } = recordingLogger();
  const deps: Deps = { config: makeConfig(), log: logger, browser: fakeBrowser(), ...depsOver };
  const c = await connectServer((server) => registerAccountsTool(server, deps, options));
  cleanups.push(() => c.close());
  return { ...c, lines };
}

function envelope(result: ToolResult) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

describe("accounts tool", () => {
  it("is registered with the documented schema, annotations and cap", async () => {
    const { client } = await connect({ service: () => fakeService() });
    const tool = (await client.listTools()).tools.find((t) => t.name === "accounts");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["action", "platform", "wait_seconds"]);
    expect(tool?.description).toMatch(/330 seconds/);
    expect(tool?.description).toMatch(/timeout/);
    expect(tool?.description).toMatch(/never types/);
    expect(TOOL_WALL_CLOCK_MS.accounts).toBe(330_000);
  });

  it("list returns the service's output as text and structured content", async () => {
    const svc = fakeService();
    const { client } = await connect({ service: () => svc });
    const result = await callTool(client, "accounts", { action: "list" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(LIST);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(LIST);
    expect(svc.calls).toEqual([["list"]]);
  });

  it("connect passes the platform and wait_seconds through, defaulting the wait to 120", async () => {
    const svc = fakeService();
    const { client } = await connect({ service: () => svc });
    expect((await callTool(client, "accounts", { action: "connect", platform: "reddit" })).structuredContent).toMatchObject({ status: "pending", waited_s: 120 });
    await callTool(client, "accounts", { action: "connect", platform: "x", wait_seconds: 7 });
    expect(svc.calls).toEqual([
      ["connect", "reddit", 120],
      ["connect", "x", 7],
    ]);
  });

  it("disconnect passes the platform through", async () => {
    const svc = fakeService();
    const { client } = await connect({ service: () => svc });
    const result = await callTool(client, "accounts", { action: "disconnect", platform: "amazon" });
    expect(result.structuredContent).toMatchObject({ action: "disconnect", platform: "amazon", status: "disconnected", cookies_cleared: 3 });
    expect(svc.calls).toEqual([["disconnect", "amazon"]]);
  });

  it("rejects connect and disconnect without a platform, an unknown platform and an out-of-range wait before the service runs", async () => {
    const svc = fakeService();
    const { client } = await connect({ service: () => svc });
    for (const args of [
      { action: "connect" },
      { action: "disconnect" },
      { action: "connect", platform: "myspace" },
      { action: "connect", platform: "reddit", wait_seconds: 301 },
      { action: "connect", platform: "reddit", wait_seconds: -1 },
      { action: "nope" },
    ]) {
      const result = await callTool(client, "accounts", args);
      expect(result.isError).toBe(true);
      // The SDK validates the input schema (including its platform refinement) before the handler runs
      // and answers with a protocol error; the handler's own invalid_input envelope is the backstop.
      expect(result.content[0]?.text ?? "").toMatch(/Input validation error|invalid_input/);
    }
    expect(svc.calls).toEqual([]);
  });

  it("advertises an object output schema that accepts exactly what AccountsOutputSchema accepts", async () => {
    const { client } = await connect({ service: () => fakeService() });
    const tool = (await client.listTools()).tools.find((t) => t.name === "accounts");
    expect(tool?.outputSchema).toMatchObject({ type: "object" });
    expect(Object.keys((tool?.outputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(
      ["accounts", "action", "caveats", "cookies_cleared", "instructions", "login_url", "mode", "platform", "profile_dir", "status", "waited_s"],
    );
    expect(AccountsOutputObjectSchema.safeParse(LIST).success).toBe(true);
    // A disconnect carrying a connect-only status is rejected by both.
    const bad = { action: "disconnect", platform: "reddit", status: "pending", cookies_cleared: 0, caveats: [] };
    expect(AccountsOutputSchema.safeParse(bad).success).toBe(false);
    expect(AccountsOutputObjectSchema.safeParse(bad).success).toBe(false);
  });

  it("maps an AccountsError onto its envelope code and keeps retryable", async () => {
    const svc = fakeService({
      connect: () => Promise.reject(new AccountsError("config", "headless: set BROWSER_HEADLESS=false or BROWSER_CDP_URL")),
      disconnect: () => Promise.reject(new AccountsError("provider", "flaky", true)),
    });
    const { client } = await connect({ service: () => svc });
    const cfg = envelope(await callTool(client, "accounts", { action: "connect", platform: "google" }));
    expect(cfg).toMatchObject({ code: "config", retryable: false });
    expect(cfg.message).toMatch(/BROWSER_HEADLESS=false/);
    expect(envelope(await callTool(client, "accounts", { action: "disconnect", platform: "google" }))).toMatchObject({ code: "provider", retryable: true });
  });

  it("returns config when no browser session exists", async () => {
    const { client } = await connect({}, { browser: undefined });
    const err = envelope(await callTool(client, "accounts", { action: "list" }));
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/browser/);
  });

  it("turns an output that fails the schema into internal, and a thrown Error into a one-line internal envelope", async () => {
    const svc = fakeService({
      list: () => Promise.resolve({ action: "list", mode: "nope" } as unknown as AccountsListOutput),
      disconnect: () => Promise.reject(new Error("boom\n    at secret (/home/owner/x.ts:1:1)")),
    });
    const { client, lines } = await connect({ service: () => svc });
    expect(envelope(await callTool(client, "accounts", { action: "list" })).code).toBe("internal");
    const thrown = envelope(await callTool(client, "accounts", { action: "disconnect", platform: "reddit" }));
    expect(thrown.code).toBe("internal");
    expect(thrown.message).toBe("accounts failed: boom");
    expect(lines.some((l) => l.level === "error")).toBe(true);
  });

  it("returns the timeout envelope when the service hangs past the cap", async () => {
    const svc = fakeService({ connect: () => forever() });
    const { client } = await connect({ service: () => svc, wallClockMs: 40 });
    const err = envelope(await callTool(client, "accounts", { action: "connect", platform: "reddit", wait_seconds: 300 }));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
  });

  it("creates the service once so pending login pages survive across calls", async () => {
    let created = 0;
    const { client } = await connect({
      service: () => {
        created++;
        return fakeService();
      },
    });
    await callTool(client, "accounts", { action: "list" });
    await callTool(client, "accounts", { action: "list" });
    expect(created).toBe(1);
  });
});
