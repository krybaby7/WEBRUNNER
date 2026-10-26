import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/config.js";
import type { BrowserCookie, BrowserSession } from "../../../src/core/browser/types.js";
import { buildAllMarketProviders } from "../../../src/core/markets/providers/index.js";
import { buildAllReviewSources } from "../../../src/core/reviews/sources/index.js";
import { buildAllSocialPlatforms } from "../../../src/core/social/platforms/index.js";
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
  reddit_client_id: "SECRET-reddit-id-0012",
  reddit_client_secret: "SECRET-reddit-secret-0013",
  youtube_api_key: "SECRET-youtube-0014",
  finnhub_api_key: "SECRET-finnhub-0015",
};

const CDP_URL = "http://user:SECRET-password-0009@127.0.0.1:9222/devtools/browser/SECRET-id-0010?token=SECRET-token-0011";
const COOKIE_VALUE = "SECRET-cookie-value-0016";
const SECRET_FRAGMENTS = [...Object.values(SECRETS), "SECRET-password-0009", "SECRET-id-0010", "SECRET-token-0011", COOKIE_VALUE];

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

/**
 * A browser that behaves like the real session: `cookies()` launches Chromium
 * when the browser is closed. Here that launch is a thrown error, so a health
 * call that touched cookies on a closed browser would fail its test.
 */
function strictFakeBrowser(open: boolean, cookies: BrowserCookie[] = []): BrowserSession & { cookieCalls: number } {
  const base = fakeBrowser({ mode: open ? "persistent" : null, open }, open);
  const wrapped = {
    ...base,
    cookieCalls: 0,
    cookies: () => {
      wrapped.cookieCalls += 1;
      if (!open) return Promise.reject(new Error("strictFakeBrowser: cookies() would launch Chromium"));
      return Promise.resolve(cookies);
    },
  };
  return wrapped;
}

const FUTURE = Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000);
function cookie(name: string, domain: string): BrowserCookie {
  return { name, domain, path: "/", expires: FUTURE, httpOnly: true, secure: true };
}

interface Health {
  version: string;
  uptime_s: number;
  config: {
    anthropic_api_key: boolean;
    search_providers: string[];
    fast_fetchers: string[];
    flight_sources: string[];
    hotel_sources: string[];
    market_sources: string[];
    social_platforms: Array<{ name: string; access: "api" | "browser" }>;
    review_sources: string[];
    reddit_api: boolean;
    youtube_api_key: boolean;
    finnhub_api_key: boolean;
    currency: string;
    models: Record<string, string>;
    llm: { backend: string; fallback: string };
    cache_dir: string;
    browser: { mode: string; profile_dir?: string; cdp_url?: string; headless_default: boolean };
  };
  browser: Record<string, unknown> | null;
  accounts: { connected: string[] | null };
  cache: { dir: string; entries: number; bytes: number };
  tools: string[];
}

/** What the builders say is configured, so the tests do not hard-code platform lists that WP18b and WP19b extend. */
function expectedSources(config: Config, deps: Deps) {
  const services = { ...(deps.browser !== undefined && { browser: deps.browser }), ...(deps.llm !== undefined && { llm: deps.llm }) };
  const configured = <T extends { isConfigured(): boolean }>(list: T[]): T[] => list.filter((p) => p.isConfigured());
  return {
    market: configured(buildAllMarketProviders(config, services)).map((p) => p.name),
    social: configured(buildAllSocialPlatforms(config, { ...services, version: "0" })).map((p) => ({ name: p.name, access: p.access })),
    review: configured(buildAllReviewSources(config, services)).map((p) => p.name),
  };
}

describe("health tool", () => {
  it("is listed as read-only with no input", async () => {
    const { client } = await connect(makeDeps(makeConfig()));
    const tool = (await client.listTools()).tools.find((t) => t.name === "health");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool?.inputSchema.properties ?? {}).toEqual({});
  });

  it("reports configuration, browser, accounts, cache and tools with the documented shape", async () => {
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
    const browser = strictFakeBrowser(true, [cookie("reddit_session", ".reddit.com"), cookie("auth_token", ".x.com")]);
    const deps = makeDeps(config, { browser });
    const { client } = await connect(deps);

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const health = result.structuredContent as Health;
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(health);

    const expected = expectedSources(config, deps);
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(health.uptime_s).toBeGreaterThanOrEqual(0);
    expect(health.config).toEqual({
      anthropic_api_key: true,
      search_providers: ["brave", "exa", "tavily", "perplexity"],
      fast_fetchers: ["firecrawl", "jina", "direct"],
      flight_sources: ["duffel", "google_flights"],
      hotel_sources: ["google_hotels"],
      market_sources: expected.market,
      social_platforms: expected.social,
      review_sources: expected.review,
      reddit_api: true,
      youtube_api_key: true,
      finnhub_api_key: true,
      currency: "EUR",
      models: { planner: "p-model", scorer: "s-model", extractor: "e-model", writer: "w-model" },
      llm: { backend: "api", fallback: "none" },
      cache_dir: cacheDir,
      browser: { mode: "persistent", profile_dir: profileDir, headless_default: true },
    });
    // The names the plan promises (14.2, 14.5, 14.6) are among what the builders report.
    expect(health.config.market_sources).toEqual(expect.arrayContaining(["yahoo", "finnhub", "coingecko", "google_finance"]));
    expect(health.config.social_platforms).toEqual(
      expect.arrayContaining([
        { name: "reddit", access: "api" },
        { name: "hackernews", access: "api" },
        { name: "bluesky", access: "api" },
        { name: "youtube", access: "api" },
      ]),
    );
    expect(health.config.review_sources).toEqual(expect.arrayContaining(["app_store", "trustpilot"]));
    expect(health.browser).toMatchObject({ mode: "persistent", open: true, is_open: true, headless: true, activePages: 0, maxPages: 3 });
    expect(health.accounts).toEqual({ connected: ["reddit", "x"] });
    expect(health.cache).toEqual({ dir: cacheDir, entries: 2, bytes: 15 });
    expect(health.tools).toEqual([...TOOL_NAMES]);
    expect(health.tools).toContain("health");
  });

  it("never includes a configured key value or a cookie value anywhere in the result", async () => {
    const config = makeConfig({
      ...SECRETS,
      browser: { profile_dir: "/tmp/webrunner-test/profile", cdp_url: CDP_URL, headless: false },
    });
    const browser = strictFakeBrowser(true, [
      { name: "SID", domain: ".google.com", path: "/", expires: FUTURE, httpOnly: false, secure: true },
      { name: "SAPISID", domain: ".google.com", path: "/", expires: FUTURE, httpOnly: false, secure: true },
    ]);
    const { client } = await connect(makeDeps(config, { browser }));

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const everything = JSON.stringify(result);
    for (const secret of SECRET_FRAGMENTS) expect(everything).not.toContain(secret);

    const health = result.structuredContent as Health;
    expect(health.config.anthropic_api_key).toBe(true);
    expect(health.config.reddit_api).toBe(true);
    expect(health.config.browser).toEqual({ mode: "cdp", cdp_url: "http://127.0.0.1:9222", headless_default: false });
    expect(health.accounts).toEqual({ connected: ["google"] });
  });

  it("reports accounts.connected as null and never touches cookies when the browser is closed", async () => {
    const browser = strictFakeBrowser(false);
    const { client } = await connect(makeDeps(makeConfig(SECRETS), { browser }));

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const health = result.structuredContent as Health;
    expect(health.accounts).toEqual({ connected: null });
    expect(health.browser).toMatchObject({ open: false, is_open: false });
    expect(browser.cookieCalls).toBe(0);
    // The browser-backed sources are still configured: a closed browser launches on first use.
    expect(health.config.hotel_sources).toEqual(["google_hotels"]);
    expect(health.config.market_sources).toContain("google_finance");
  });

  it("reports an empty connected list, not null, when the browser is open and no platform is logged in", async () => {
    const browser = strictFakeBrowser(true, [cookie("unrelated", ".example.com")]);
    const { client } = await connect(makeDeps(makeConfig(), { browser }));
    const health = (await callTool(client, "health")).structuredContent as Health;
    expect(health.accounts).toEqual({ connected: [] });
    expect(browser.cookieCalls).toBe(1);
  });

  it("reports the model backend buildDeps resolved, such as the claude CLI on a key-less machine (PLAN.md 15.5)", async () => {
    const config = makeConfig({ cache_dir: join(tempDir(), "cache") });
    delete config.anthropic_api_key;
    const deps = { ...makeDeps(config, { browser: fakeBrowser() }), llmInfo: { backend: "claude-cli" as const, fallback: "none" as const } };
    const { client } = await connect(deps);
    const health = (await callTool(client, "health")).structuredContent as Health;
    expect(health.config.llm).toEqual({ backend: "claude-cli", fallback: "none" });
    expect(health.config.anthropic_api_key).toBe(false);
  });

  it("reports an empty, key-less setup without failing", async () => {
    const missing = join(tempDir(), "does-not-exist");
    const config = makeConfig({ cache_dir: missing });
    delete config.anthropic_api_key;
    const deps = makeDeps(config, { browser: fakeBrowser() });
    const { client } = await connect(deps);

    const result = await callTool(client, "health");
    expect(result.isError).toBeUndefined();
    const health = result.structuredContent as Health;
    const expected = expectedSources(config, deps);
    expect(health.config.anthropic_api_key).toBe(false);
    expect(health.config.llm).toEqual({ backend: "none", fallback: "none" });
    expect(health.config.search_providers).toEqual([]);
    expect(health.config.fast_fetchers).toEqual(["jina", "direct"]);
    expect(health.config.flight_sources).toEqual(["google_flights"]);
    expect(health.config.hotel_sources).toEqual(["google_hotels"]);
    expect(health.config.market_sources).toEqual(expected.market);
    expect(health.config.market_sources).not.toContain("finnhub");
    expect(health.config.social_platforms).toEqual(expected.social);
    expect(health.config.social_platforms.map((p) => p.name)).not.toContain("youtube");
    expect(health.config.review_sources).toEqual(expected.review);
    expect(health.config.reddit_api).toBe(false);
    expect(health.config.youtube_api_key).toBe(false);
    expect(health.config.finnhub_api_key).toBe(false);
    expect(health.browser).toMatchObject({ mode: null, open: false, is_open: false });
    expect(health.accounts).toEqual({ connected: null });
    expect(health.cache).toEqual({ dir: missing, entries: 0, bytes: 0 });
  });

  it("reports browser: null, accounts null and no browser-backed sources when the browser dependency is absent", async () => {
    const config = makeConfig();
    const deps: Deps = { config, log: recordingLogger().logger };
    const { client } = await connect(deps);
    const health = (await callTool(client, "health")).structuredContent as Health;
    const expected = expectedSources(config, deps);
    expect(health.browser).toBeNull();
    expect(health.accounts).toEqual({ connected: null });
    expect(health.config.flight_sources).toEqual([]);
    expect(health.config.hotel_sources).toEqual([]);
    expect(health.config.market_sources).toEqual(expected.market);
    expect(health.config.market_sources).not.toContain("google_finance");
    expect(health.config.social_platforms).toEqual(expected.social);
    expect(health.config.social_platforms.every((p) => p.access === "api")).toBe(true);
    expect(health.config.review_sources).toEqual(expected.review);
  });

  it("lists exactly the tools that tools/list returns", async () => {
    const { client } = await connect(makeDeps(makeConfig()));
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect([...TOOL_NAMES].sort()).toEqual(listed);
  });
});
