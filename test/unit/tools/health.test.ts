import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/config.js";
import type { Deps } from "../../../src/deps.js";
import { registerTools, TOOL_NAMES } from "../../../src/tools/index.js";
import { makeConfig } from "../llm/helpers.js";
import { recordingLogger, scriptedLlm } from "../research/helpers.js";
import { callTool, connectServer, fakeBrowser, type Connected } from "./helpers.js";

const SECRETS = {
  anthropic_api_key: "sk-ant-SECRET-anthropic-0001",
  brave_api_key: "SECRET-brave-0002",
  exa_api_key: "SECRET-exa-0003",
  tavily_api_key: "SECRET-tavily-0004",
  perplexity_api_key: "SECRET-perplexity-0005",
  firecrawl_api_key: "SECRET-firecrawl-0006",
  jina_api_key: "SECRET-jina-0007",
  duffel_api_key: "SECRET-duffel-0008",
};

const CDP_URL = "http://user:SECRET-password-0009@127.0.0.1:9222/devtools/browser/SECRET-id-0010?token=SECRET-token-0011";
const SECRET_FRAGMENTS = [...Object.values(SECRETS), "SECRET-password-0009", "SECRET-id-0010", "SECRET-token-0011"];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "webrunner-health-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(deps: Deps): Promise<Connected> {
  const c = await connectServer((server) => registerTools(server, deps));
  cleanups.push(() => c.close());
  return c;
}

function makeDeps(config: Config, over: Partial<Deps> = {}): Deps {
  return { config, log: recordingLogger().logger, llm: scriptedLlm({}), browser: fakeBrowser(), ...over };
}

interface Health {
  version: string;
  uptime_s: number;
  config: {
    anthropic_api_key: boolean;
    search_providers: string[];
    fast_fetchers: string[];
    flight_sources: string[];
    currency: string;
    models: Record<string, string>;
    cache_dir: string;
    browser: { mode: string; profile_dir?: string; cdp_url?: string; headless_default: boolean };
  };
  browser: Record<string, unknown> | null;
  cache: { dir: string; entries: number; bytes: number };
  tools: string[];
}

describe("health tool", () => {
  it("is listed as read-only with no input", async () => {
    const { client } = await connect(makeDeps(makeConfig()));
    const tool = (await client.listTools()).tools.find((t) => t.name === "health");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool?.inputSchema.properties ?? {}).toEqual({});
  });

  it("reports configuration, browser, cache and tools with the documented shape", async () => {
    const cacheDir = tempDir();
    mkdirSync(join(cacheDir, "ab"));
    writeFileSync(join(cacheDir, "ab", "one.json"), "12345");
    writeFileSync(join(cacheDir, "ab", "two.json"), "1234567890");
    writeFileSync(join(cacheDir, "ab", "not-an-entry.tmp"), "ignored");
    const profileDir = join(tempDir(), "profile");

    const config = makeConfig({
      ...SECRETS,
      cache_dir: cacheDir,
      currency: "EUR",
      browser: { profile_dir: profileDir, headless: true },
      models: { planner: "p-model", scorer: "s-model", extractor: "e-model", writer: "w-model" },
    });
    const browser = fakeBrowser({ mode: "persistent", open: true, totalAcquired: 4, launchedAt: "2026-10-18T09:00:00.000Z" }, true);
    const { client } = await connect(makeDeps(config, { browser }));

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const health = result.structuredContent as Health;
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(health);

    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(health.uptime_s).toBeGreaterThanOrEqual(0);
    expect(health.config).toEqual({
      anthropic_api_key: true,
      search_providers: ["brave", "exa", "tavily", "perplexity"],
      fast_fetchers: ["firecrawl", "jina", "direct"],
      flight_sources: ["duffel", "google_flights"],
      currency: "EUR",
      models: { planner: "p-model", scorer: "s-model", extractor: "e-model", writer: "w-model" },
      cache_dir: cacheDir,
      browser: { mode: "persistent", profile_dir: profileDir, headless_default: true },
    });
    expect(health.browser).toMatchObject({
      mode: "persistent",
      open: true,
      is_open: true,
      headless: true,
      activePages: 0,
      maxPages: 3,
      totalAcquired: 4,
      launchedAt: "2026-10-18T09:00:00.000Z",
    });
    expect(health.cache).toEqual({ dir: cacheDir, entries: 2, bytes: 15 });
    expect(health.tools).toEqual([...TOOL_NAMES]);
    expect(health.tools).toContain("health");
  });

  it("never includes a configured key value anywhere in the result", async () => {
    const config = makeConfig({
      ...SECRETS,
      browser: { profile_dir: "/tmp/webrunner-test/profile", cdp_url: CDP_URL, headless: false },
    });
    const { client } = await connect(makeDeps(config));

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const everything = JSON.stringify(result);
    for (const secret of SECRET_FRAGMENTS) expect(everything).not.toContain(secret);

    const health = result.structuredContent as Health;
    expect(health.config.anthropic_api_key).toBe(true);
    expect(health.config.browser).toEqual({ mode: "cdp", cdp_url: "http://127.0.0.1:9222", headless_default: false });
  });

  it("reports an empty, key-less setup without failing", async () => {
    const missing = join(tempDir(), "does-not-exist");
    const config = makeConfig({ cache_dir: missing });
    delete config.anthropic_api_key;
    const { client } = await connect(makeDeps(config, { browser: fakeBrowser() }));

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const health = result.structuredContent as Health;
    expect(health.config.anthropic_api_key).toBe(false);
    expect(health.config.search_providers).toEqual([]);
    expect(health.config.fast_fetchers).toEqual(["jina", "direct"]);
    expect(health.config.flight_sources).toEqual(["google_flights"]);
    expect(health.browser).toMatchObject({ mode: null, open: false, is_open: false });
    expect(health.cache).toEqual({ dir: missing, entries: 0, bytes: 0 });
  });

  it("reports browser: null and no Google Flights source when the browser dependency is absent", async () => {
    const { client } = await connect({ config: makeConfig(), log: recordingLogger().logger });
    const health = (await callTool(client, "health")).structuredContent as Health;
    expect(health.browser).toBeNull();
    expect(health.config.flight_sources).toEqual([]);
  });

  it("lists exactly the tools that tools/list returns", async () => {
    const { client } = await connect(makeDeps(makeConfig()));
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect([...TOOL_NAMES].sort()).toEqual(listed);
  });
});
