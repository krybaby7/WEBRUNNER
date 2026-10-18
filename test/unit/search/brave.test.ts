import { describe, expect, it } from "vitest";
import { BraveProvider, buildBraveQuery } from "../../../src/core/search/providers/brave.js";
import type { RawResult } from "../../../src/core/search/types.js";
import {
  BASE_QUERY,
  describeProviderContract,
  fakeFetch,
  jsonResponse,
  loadFixture,
} from "./helpers.js";

const fixture = loadFixture("brave");
const signal = (): AbortSignal => new AbortController().signal;
const make = (fetchImpl: typeof fetch, apiKey?: string): BraveProvider =>
  new BraveProvider({ fetchImpl, ...(apiKey !== undefined && { apiKey }) });

describeProviderContract({ name: "brave", make, validBody: fixture });

describe("brave: mapping", () => {
  it("maps the recorded fixture to RawResult[]", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search(BASE_QUERY, signal());
    const expected: RawResult[] = [
      {
        url: "https://blog.example.dev/rust-async-runtimes",
        title: "Tokio vs async-std vs smol: choosing a Rust async runtime",
        snippet:
          "A benchmark-driven look at Rust async runtimes: Tokio, smol and async-std compared on throughput and latency.",
        publishedAt: "2025-03-11T17:00:00.000Z",
        rank: 1,
      },
      {
        url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
        title: "Async runtimes - Asynchronous Programming in Rust",
        snippet: "The Rust standard library does not ship an executor. Here's how the ecosystem fills the gap & what to pick.",
        rank: 2,
      },
      {
        url: "https://github.com/smol-rs/smol",
        title: "smol-rs/smol: A small and fast async runtime",
        snippet: "A small and fast async runtime. Contribute to smol-rs/smol development by creating an account on GitHub.",
        publishedAt: "2025-03-03T00:00:00.000Z",
        rank: 3,
      },
      {
        url: "https://www.reddit.com/r/rust/comments/EXAMPLE/which_rust_async_runtime_should_i_use/",
        title: "Which Rust async runtime should I use? : r/rust",
        snippet: "Long thread on picking between Tokio and smol for a new service.",
        rank: 4,
      },
    ];
    expect(out).toEqual(expected);
    // missing date and unparseable date are omitted, never passed through raw
    expect("publishedAt" in (out[1] as RawResult)).toBe(false);
    expect("publishedAt" in (out[3] as RawResult)).toBe(false);
  });

  it("returns an empty list when Brave has no web results", async () => {
    const f = fakeFetch(() => jsonResponse({ type: "search", query: { original: "zzzz" } }));
    expect(await make(f.fetchImpl, "k").search(BASE_QUERY, signal())).toEqual([]);
  });

  it("sends the token header, count and freshness", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "secret-key").search({ ...BASE_QUERY, maxResults: 7, recency: "week" }, signal());
    const call = f.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.headers["x-subscription-token"]).toBe("secret-key");
    const url = new URL(call?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe(BASE_QUERY.query);
    expect(url.searchParams.get("count")).toBe("7");
    expect(url.searchParams.get("freshness")).toBe("pw");
  });

  it.each([
    ["day", "pd"],
    ["week", "pw"],
    ["month", "pm"],
    ["year", "py"],
  ] as const)("maps recency %s to freshness %s", async (recency, freshness) => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, recency }, signal());
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("freshness")).toBe(freshness);
  });

  it("omits freshness when no recency is given and caps count at 20", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, maxResults: 30 }, signal());
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.searchParams.has("freshness")).toBe(false);
    expect(url.searchParams.get("count")).toBe("20");
  });

  it("honors a custom baseUrl", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await new BraveProvider({ apiKey: "k", fetchImpl: f.fetchImpl, baseUrl: "http://localhost:9999/" }).search(
      BASE_QUERY,
      signal(),
    );
    expect(f.calls[0]?.url.startsWith("http://localhost:9999/res/v1/web/search?")).toBe(true);
  });
});

describe("brave: domain filters", () => {
  it("builds site: operators into the query", () => {
    expect(buildBraveQuery({ query: "x", maxResults: 1 })).toBe("x");
    expect(buildBraveQuery({ query: "x", maxResults: 1, includeDomains: ["https://www.GitHub.com/a"] })).toBe(
      "site:github.com x",
    );
    expect(buildBraveQuery({ query: "x", maxResults: 1, includeDomains: ["a.com", "b.org"] })).toBe(
      "(site:a.com OR site:b.org) x",
    );
    expect(buildBraveQuery({ query: "x", maxResults: 1, excludeDomains: ["reddit.com", "quora.com"] })).toBe(
      "x -site:reddit.com -site:quora.com",
    );
  });

  it("sends the operators and also filters client-side (exclude), then re-ranks", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search({ ...BASE_QUERY, excludeDomains: ["reddit.com"] }, signal());
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("q")).toBe(`${BASE_QUERY.query} -site:reddit.com`);
    expect(out.map((r) => new URL(r.url).hostname)).toEqual(["blog.example.dev", "rust-lang.github.io", "github.com"]);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("filters client-side (include), matching subdomains but not look-alikes", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search({ ...BASE_QUERY, includeDomains: ["github.io"] }, signal());
    expect(out.map((r) => new URL(r.url).hostname)).toEqual(["rust-lang.github.io"]);
    const none = await make(f.fetchImpl, "k").search({ ...BASE_QUERY, includeDomains: ["hub.io"] }, signal());
    expect(none).toEqual([]);
  });
});
