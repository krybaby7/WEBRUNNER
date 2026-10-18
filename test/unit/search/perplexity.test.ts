import { describe, expect, it } from "vitest";
import { PerplexityProvider } from "../../../src/core/search/providers/perplexity.js";
import type { RawResult } from "../../../src/core/search/types.js";
import {
  BASE_QUERY,
  describeProviderContract,
  fakeFetch,
  jsonResponse,
  loadFixture,
} from "./helpers.js";

const fixture = loadFixture("perplexity");
const signal = (): AbortSignal => new AbortController().signal;
const make = (fetchImpl: typeof fetch, apiKey?: string): PerplexityProvider =>
  new PerplexityProvider({ fetchImpl, ...(apiKey !== undefined && { apiKey }) });

describeProviderContract({ name: "perplexity", make, validBody: fixture });

describe("perplexity: mapping", () => {
  it("maps the recorded fixture to RawResult[]", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search(BASE_QUERY, signal());
    const expected: RawResult[] = [
      {
        url: "https://blog.example.dev/rust-async-runtimes",
        title: "Tokio vs async-std vs smol: choosing a Rust async runtime",
        snippet: "Tokio remains the default choice for network services, while smol keeps the dependency tree small.",
        publishedAt: "2025-03-11T00:00:00.000Z", // date-only
        rank: 1,
      },
      {
        url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
        title: "Async runtimes - Asynchronous Programming in Rust",
        snippet: "The Rust standard library does not ship an executor, so applications pick a runtime from the ecosystem.",
        rank: 2, // date null
      },
      {
        url: "https://github.com/smol-rs/smol",
        title: "smol-rs/smol: A small and fast async runtime",
        snippet: "A small and fast async runtime.",
        publishedAt: "2025-09-25T15:00:00.000Z", // -05:00 offset converted to UTC
        rank: 3,
      },
      {
        url: "https://news.example.org/runtime-roundup",
        title: "Runtime roundup",
        snippet: "A monthly digest of Rust runtime news.",
        rank: 4, // "n/a"
      },
    ];
    expect(out).toEqual(expected);
  });

  it("posts the search body with a bearer token to /search (not the chat API)", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "secret-key").search({ query: "q", maxResults: 5, recency: "day" }, signal());
    const call = f.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.perplexity.ai/search");
    expect(call?.headers["authorization"]).toBe("Bearer secret-key");
    expect(call?.body).toEqual({ query: "q", max_results: 5, search_recency_filter: "day" });
  });

  it.each(["day", "week", "month", "year"] as const)("maps recency %s to search_recency_filter", async (recency) => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, recency }, signal());
    expect((f.calls[0]?.body as Record<string, unknown>)["search_recency_filter"]).toBe(recency);
  });

  it("caps max_results at 20", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, maxResults: 30 }, signal());
    expect((f.calls[0]?.body as Record<string, unknown>)["max_results"]).toBe(20);
  });
});

describe("perplexity: domain filters", () => {
  it("sends an allowlist natively", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, includeDomains: ["https://www.GitHub.com/x", "*.rust-lang.org"] }, signal());
    expect((f.calls[0]?.body as Record<string, unknown>)["search_domain_filter"]).toEqual(["github.com", "rust-lang.org"]);
  });

  it("sends a denylist natively with a - prefix and does not filter client-side", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search({ ...BASE_QUERY, excludeDomains: ["reddit.com", "quora.com"] }, signal());
    expect((f.calls[0]?.body as Record<string, unknown>)["search_domain_filter"]).toEqual(["-reddit.com", "-quora.com"]);
    expect(out).toHaveLength(4);
  });

  it("with both include and exclude, sends the allowlist and removes excluded hosts client-side", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search(
      { ...BASE_QUERY, includeDomains: ["github.com", "github.io", "example.dev"], excludeDomains: ["github.io"] },
      signal(),
    );
    expect((f.calls[0]?.body as Record<string, unknown>)["search_domain_filter"]).toEqual([
      "github.com",
      "github.io",
      "example.dev",
    ]);
    expect(out.map((r) => new URL(r.url).hostname)).toEqual(["blog.example.dev", "github.com"]);
    expect(out.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("caps the native list at 20 entries but enforces the full allowlist client-side", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const include = [...Array.from({ length: 20 }, (_v, i) => `filler${i}.example`), "github.com"];
    const out = await make(f.fetchImpl, "k").search({ ...BASE_QUERY, includeDomains: include }, signal());
    expect(((f.calls[0]?.body as Record<string, unknown>)["search_domain_filter"] as string[]).length).toBe(20);
    expect(out.map((r) => new URL(r.url).hostname)).toEqual(["github.com"]);
  });
});
