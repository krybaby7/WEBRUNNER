import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, type Config } from "../../../src/config.js";
import { buildProviders } from "../../../src/core/search/providers/index.js";
import { ProviderError } from "../../../src/core/search/types.js";
import { fakeFetch, jsonResponse, loadFixture } from "./helpers.js";

function config(keys: Partial<Config> = {}): Config {
  return {
    browser: { profile_dir: "/tmp/profile" },
    research_max_cost_usd: 3,
    research_max_ms: 900_000,
    cache_dir: "/tmp/cache",
    log_level: "info",
    save_screenshots: false,
    currency: "USD",
    models: { ...DEFAULT_MODELS },
    ...keys,
  };
}

describe("buildProviders", () => {
  it("returns nothing when no search key is configured", () => {
    expect(buildProviders(config())).toEqual([]);
  });

  it("returns only configured providers", () => {
    const names = buildProviders(config({ exa_api_key: "e", perplexity_api_key: "p" })).map((p) => p.name);
    expect(names).toEqual(["exa", "perplexity"]);
  });

  it("returns all four in the order brave, exa, tavily, perplexity", () => {
    const providers = buildProviders(
      config({ perplexity_api_key: "p", tavily_api_key: "t", exa_api_key: "e", brave_api_key: "b" }),
    );
    expect(providers.map((p) => p.name)).toEqual(["brave", "exa", "tavily", "perplexity"]);
    expect(providers.every((p) => p.isConfigured())).toBe(true);
  });

  it("ignores keys of non-search services and blank search keys", () => {
    const names = buildProviders(
      config({ anthropic_api_key: "a", firecrawl_api_key: "f", brave_api_key: "  ", tavily_api_key: "t" }),
    ).map((p) => p.name);
    expect(names).toEqual(["tavily"]);
  });

  it("wires each provider's own key and the injected fetch", async () => {
    const f = fakeFetch((call) =>
      call.url.includes("brave") ? jsonResponse(loadFixture("brave")) : jsonResponse(loadFixture("tavily")),
    );
    const providers = buildProviders(config({ brave_api_key: "bkey", tavily_api_key: "tkey" }), {
      fetchImpl: f.fetchImpl,
    });
    const signal = new AbortController().signal;
    for (const p of providers) await p.search({ query: "q", maxResults: 3 }, signal);
    expect(f.calls[0]?.headers["x-subscription-token"]).toBe("bkey");
    expect(f.calls[1]?.headers["authorization"]).toBe("Bearer tkey");
  });
});

describe("ProviderError", () => {
  it("always carries code 'provider' and exposes provider, status and retryable", () => {
    const e = new ProviderError({ provider: "exa", message: "boom", status: 503, retryable: true });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("provider");
    expect(e.name).toBe("ProviderError");
    expect(e.provider).toBe("exa");
    expect(e.status).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.aborted).toBe(false);
  });

  it("leaves status undefined when there is no HTTP response", () => {
    const e = new ProviderError({ provider: "brave", message: "network", retryable: true });
    expect(e.status).toBeUndefined();
  });
});
