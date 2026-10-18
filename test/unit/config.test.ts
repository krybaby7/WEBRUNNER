import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { log } from "../../src/log.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webrunner-config-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function load(env: Record<string, string>) {
  return loadConfig({ env, home });
}

function writeConfigFile(contents: unknown): void {
  mkdirSync(join(home, ".config", "webrunner"), { recursive: true });
  writeFileSync(join(home, ".config", "webrunner", "config.json"), JSON.stringify(contents));
}

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const config = load({});
    expect(config.research_max_cost_usd).toBe(3);
    expect(config.log_level).toBe("info");
    expect(config.cache_dir).toBe(join(home, ".cache", "webrunner"));
    expect(config.browser.profile_dir).toBe(join(home, ".config", "webrunner", "browser-profile"));
    expect(config.browser.headless).toBeUndefined();
    expect(config.browser.cdp_url).toBeUndefined();
    expect(config.save_screenshots).toBe(false);
    expect(config.anthropic_api_key).toBeUndefined();
  });

  it("parses every variable in the PLAN.md 4.8 table", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const config = load({
      ANTHROPIC_API_KEY: "a",
      BRAVE_API_KEY: "b",
      EXA_API_KEY: "e",
      TAVILY_API_KEY: "t",
      PERPLEXITY_API_KEY: "p",
      FIRECRAWL_API_KEY: "f",
      JINA_API_KEY: "j",
      DUFFEL_API_KEY: "d",
      BROWSER_CDP_URL: "http://127.0.0.1:9222",
      BROWSER_HEADLESS: "true",
      RESEARCH_MAX_COST_USD: "1.25",
      WEBRUNNER_CACHE_DIR: "~/somewhere",
      WEBRUNNER_LOG_LEVEL: "DEBUG",
    });
    expect(config).toMatchObject({
      anthropic_api_key: "a",
      brave_api_key: "b",
      exa_api_key: "e",
      tavily_api_key: "t",
      perplexity_api_key: "p",
      firecrawl_api_key: "f",
      jina_api_key: "j",
      duffel_api_key: "d",
      research_max_cost_usd: 1.25,
      cache_dir: join(home, "somewhere"),
      log_level: "debug",
      browser: { cdp_url: "http://127.0.0.1:9222", headless: true },
    });
  });

  it("accepts false-like values for BROWSER_HEADLESS", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(load({ BROWSER_HEADLESS: "0" }).browser.headless).toBe(false);
    expect(load({ BROWSER_HEADLESS: "no" }).browser.headless).toBe(false);
  });

  it("treats empty environment variables as unset", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const config = load({ BRAVE_API_KEY: "", RESEARCH_MAX_COST_USD: "  " });
    expect(config.brave_api_key).toBeUndefined();
    expect(config.research_max_cost_usd).toBe(3);
  });

  it("fails with a readable message on a non-numeric cost cap", () => {
    expect(() => load({ RESEARCH_MAX_COST_USD: "abc" })).toThrow(ConfigError);
    expect(() => load({ RESEARCH_MAX_COST_USD: "abc" })).toThrow(/RESEARCH_MAX_COST_USD.*must be a number/s);
  });

  it("fails on a non-positive cost cap", () => {
    expect(() => load({ RESEARCH_MAX_COST_USD: "0" })).toThrow(/greater than 0/);
    expect(() => load({ RESEARCH_MAX_COST_USD: "-2" })).toThrow(/greater than 0/);
  });

  it("fails on an invalid boolean, URL and log level", () => {
    expect(() => load({ BROWSER_HEADLESS: "maybe" })).toThrow(/BROWSER_HEADLESS/);
    expect(() => load({ BROWSER_CDP_URL: "not a url" })).toThrow(/BROWSER_CDP_URL/);
    expect(() => load({ WEBRUNNER_LOG_LEVEL: "loud" })).toThrow(/WEBRUNNER_LOG_LEVEL.*one of: debug, info, warn, error/s);
  });

  it("reports every invalid value at once", () => {
    let message = "";
    try {
      load({ RESEARCH_MAX_COST_USD: "abc", BROWSER_HEADLESS: "maybe" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("RESEARCH_MAX_COST_USD");
    expect(message).toContain("BROWSER_HEADLESS");
  });

  it("warns, and does not fail, when optional provider keys are missing", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(() => load({})).not.toThrow();
    const messages = warn.mock.calls.map((c) => c[0]);
    for (const name of ["BRAVE_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect(messages.some((m) => m.includes(name))).toBe(true);
    }
    expect(messages.some((m) => m.includes("No search provider key"))).toBe(true);
  });

  it("does not warn about a provider whose key is set", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    load({ BRAVE_API_KEY: "b", ANTHROPIC_API_KEY: "a" });
    const messages = warn.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => m.includes("BRAVE_API_KEY"))).toBe(false);
    expect(messages.some((m) => m.includes("ANTHROPIC_API_KEY"))).toBe(false);
    expect(messages.some((m) => m.includes("No search provider key"))).toBe(false);
    expect(messages.some((m) => m.includes("EXA_API_KEY"))).toBe(true);
  });

  it("applies defaults for currency and model roles", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const config = load({});
    expect(config.currency).toBe("USD");
    expect(config.models).toEqual({
      planner: "claude-opus-5-5",
      scorer: "claude-haiku-5-5",
      extractor: "claude-sonnet-5-5",
      writer: "claude-opus-5-5",
    });
  });

  it("parses the browser profile, screenshot, currency and model variables", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const config = load({
      WEBRUNNER_BROWSER_PROFILE_DIR: "~/profiles/wr",
      WEBRUNNER_SAVE_SCREENSHOTS: "yes",
      WEBRUNNER_CURRENCY: " eur ",
      WEBRUNNER_MODEL_PLANNER: "claude-fable-5-1",
      WEBRUNNER_MODEL_SCORER: "s",
      WEBRUNNER_MODEL_EXTRACTOR: "e",
      WEBRUNNER_MODEL_WRITER: "w",
    });
    expect(config.browser.profile_dir).toBe(join(home, "profiles", "wr"));
    expect(config.save_screenshots).toBe(true);
    expect(config.currency).toBe("EUR");
    expect(config.models).toEqual({ planner: "claude-fable-5-1", scorer: "s", extractor: "e", writer: "w" });
  });

  it("rejects a malformed currency code", () => {
    expect(() => load({ WEBRUNNER_CURRENCY: "dollars" })).toThrow(ConfigError);
    expect(() => load({ WEBRUNNER_CURRENCY: "dollars" })).toThrow(/WEBRUNNER_CURRENCY/);
  });

  describe("config file", () => {
    it("is used when the environment does not set a value", () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      writeConfigFile({ brave_api_key: "from-file", research_max_cost_usd: 5, save_screenshots: true });
      const config = load({});
      expect(config.brave_api_key).toBe("from-file");
      expect(config.research_max_cost_usd).toBe(5);
      expect(config.save_screenshots).toBe(true);
    });

    it("is overridden by the environment", () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      writeConfigFile({ brave_api_key: "from-file", research_max_cost_usd: 5 });
      const config = load({ BRAVE_API_KEY: "from-env" });
      expect(config.brave_api_key).toBe("from-env");
      expect(config.research_max_cost_usd).toBe(5);
    });

    it("rejects malformed JSON and unknown keys with a readable message", () => {
      mkdirSync(join(home, ".config", "webrunner"), { recursive: true });
      writeFileSync(join(home, ".config", "webrunner", "config.json"), "{ nope");
      expect(() => load({})).toThrow(/not valid JSON/);
      writeConfigFile({ brave_key: "typo" });
      expect(() => load({})).toThrow(/config\.json is invalid/);
    });

    it("names the file as the source of an invalid value", () => {
      writeConfigFile({ research_max_cost_usd: "lots" });
      expect(() => load({})).toThrow(/config\.json key "research_max_cost_usd"/);
    });
  });
});
