import { describe, expect, it } from "vitest";
import { TavilyProvider } from "../../../src/core/search/providers/tavily.js";
import type { RawResult } from "../../../src/core/search/types.js";
import {
  BASE_QUERY,
  describeProviderContract,
  fakeFetch,
  jsonResponse,
  loadFixture,
} from "./helpers.js";

const fixture = loadFixture("tavily");
const signal = (): AbortSignal => new AbortController().signal;
const make = (fetchImpl: typeof fetch, apiKey?: string): TavilyProvider =>
  new TavilyProvider({ fetchImpl, ...(apiKey !== undefined && { apiKey }) });

describeProviderContract({ name: "tavily", make, validBody: fixture });

describe("tavily: mapping", () => {
  it("maps the recorded fixture to RawResult[]", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search(BASE_QUERY, signal());
    const expected: RawResult[] = [
      {
        url: "https://blog.example.dev/rust-async-runtimes",
        title: "Tokio vs async-std vs smol: choosing a Rust async runtime",
        snippet: "Tokio remains the default choice for network services [...] smol keeps the dependency tree small.",
        publishedAt: "2025-03-11T17:00:00.000Z", // RFC 2822
        rank: 1,
      },
      {
        url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
        title: "Async runtimes - Asynchronous Programming in Rust",
        snippet: "The Rust standard library does not ship an executor, so applications pick a runtime from the ecosystem.",
        rank: 2, // published_date null
      },
      {
        url: "https://github.com/smol-rs/smol",
        title: "smol-rs/smol: A small and fast async runtime",
        snippet: "A small and fast async runtime.",
        publishedAt: "2025-03-04T08:30:00.000Z", // zone-less, read as UTC
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

  it("posts the documented request body with a bearer token", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "secret-key").search(
      {
        query: "q",
        maxResults: 5,
        recency: "month",
        includeDomains: ["github.com"],
        excludeDomains: ["reddit.com"],
      },
      signal(),
    );
    const call = f.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.tavily.com/search");
    expect(call?.headers["authorization"]).toBe("Bearer secret-key");
    expect(call?.body).toEqual({
      query: "q",
      search_depth: "basic",
      topic: "general",
      max_results: 5,
      include_published_date: true,
      time_range: "month",
      include_domains: ["github.com"],
      exclude_domains: ["reddit.com"],
    });
  });

  it.each(["day", "week", "month", "year"] as const)("maps recency %s to time_range", async (recency) => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, recency }, signal());
    expect((f.calls[0]?.body as Record<string, unknown>)["time_range"]).toBe(recency);
  });

  it("caps max_results at 20 and omits unused filters", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, maxResults: 30 }, signal());
    const body = f.calls[0]?.body as Record<string, unknown>;
    expect(body["max_results"]).toBe(20);
    expect("time_range" in body).toBe(false);
    expect("include_domains" in body).toBe(false);
    expect("exclude_domains" in body).toBe(false);
  });
});
