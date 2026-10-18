import { describe, expect, it } from "vitest";
import { BraveProvider } from "../../src/core/search/providers/brave.js";
import { ExaProvider } from "../../src/core/search/providers/exa.js";
import { PerplexityProvider } from "../../src/core/search/providers/perplexity.js";
import { TavilyProvider } from "../../src/core/search/providers/tavily.js";
import type { SearchProvider } from "../../src/core/search/types.js";

/**
 * Real calls against the live APIs. Skipped unless RUN_INTEGRATION=1 and the
 * provider's key is set in the environment. Run with:
 *   RUN_INTEGRATION=1 BRAVE_API_KEY=... npx vitest run test/integration/search.test.ts
 */

const enabled = process.env["RUN_INTEGRATION"] === "1";

const providers: Array<{ name: string; key: string | undefined; make: (key: string) => SearchProvider }> = [
  { name: "brave", key: process.env["BRAVE_API_KEY"], make: (apiKey) => new BraveProvider({ apiKey }) },
  { name: "exa", key: process.env["EXA_API_KEY"], make: (apiKey) => new ExaProvider({ apiKey }) },
  { name: "tavily", key: process.env["TAVILY_API_KEY"], make: (apiKey) => new TavilyProvider({ apiKey }) },
  { name: "perplexity", key: process.env["PERPLEXITY_API_KEY"], make: (apiKey) => new PerplexityProvider({ apiKey }) },
];

for (const p of providers) {
  const run = enabled && p.key !== undefined && p.key.trim() !== "";
  describe.skipIf(!run)(`${p.name} (live)`, () => {
    it("returns ranked results with valid urls and ISO dates", async () => {
      const provider = p.make(p.key as string);
      const results = await provider.search(
        { query: "Node.js release schedule", maxResults: 5 },
        AbortSignal.timeout(20_000),
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
      results.forEach((r, i) => {
        expect(r.rank).toBe(i + 1);
        expect(URL.canParse(r.url)).toBe(true);
        expect(typeof r.title).toBe("string");
        expect(typeof r.snippet).toBe("string");
        if (r.publishedAt !== undefined) expect(r.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    }, 30_000);

    it("honors recency and an include-domain filter", async () => {
      const provider = p.make(p.key as string);
      const results = await provider.search(
        { query: "release notes", maxResults: 5, recency: "year", includeDomains: ["github.com"] },
        AbortSignal.timeout(20_000),
      );
      for (const r of results) expect(new URL(r.url).hostname.endsWith("github.com")).toBe(true);
    }, 30_000);

    it("rejects promptly when aborted", async () => {
      const provider = p.make(p.key as string);
      const ac = new AbortController();
      const pending = provider.search({ query: "anything", maxResults: 3 }, ac.signal);
      ac.abort();
      await expect(pending).rejects.toMatchObject({ code: "provider", aborted: true });
    });
  });
}

// Keeps the file valid for vitest when every provider block is skipped.
describe("integration gate", () => {
  it("is opt-in via RUN_INTEGRATION=1", () => {
    expect(typeof enabled).toBe("boolean");
  });
});
