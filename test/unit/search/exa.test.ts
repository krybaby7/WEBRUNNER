import { describe, expect, it } from "vitest";
import { ExaProvider } from "../../../src/core/search/providers/exa.js";
import type { RawResult } from "../../../src/core/search/types.js";
import {
  BASE_QUERY,
  describeProviderContract,
  fakeFetch,
  jsonResponse,
  loadFixture,
} from "./helpers.js";

const fixture = loadFixture("exa");
const signal = (): AbortSignal => new AbortController().signal;
const NOW = Date.parse("2025-06-15T12:00:00.000Z");
const make = (fetchImpl: typeof fetch, apiKey?: string): ExaProvider =>
  new ExaProvider({ fetchImpl, now: () => NOW, ...(apiKey !== undefined && { apiKey }) });

describeProviderContract({ name: "exa", make, validBody: fixture });

describe("exa: mapping", () => {
  it("maps the recorded fixture to RawResult[]", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    const out = await make(f.fetchImpl, "k").search(BASE_QUERY, signal());
    const expected: RawResult[] = [
      {
        url: "https://blog.example.dev/rust-async-runtimes",
        title: "Tokio vs async-std vs smol: choosing a Rust async runtime",
        snippet:
          "Tokio remains the default choice for network services, while smol keeps the dependency tree small. In our benchmark Tokio's multi-thread scheduler led on throughput by roughly 18 percent.",
        publishedAt: "2025-03-11T17:00:00.000Z",
        rank: 1,
      },
      {
        url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
        title: "Async runtimes - Asynchronous Programming in Rust",
        snippet: "The Rust standard library does not ship an executor, so applications pick a runtime from the ecosystem.",
        rank: 2,
      },
      {
        url: "https://github.com/smol-rs/smol",
        title: "smol-rs/smol: A small and fast async runtime",
        snippet: "A small and fast async runtime.",
        publishedAt: "2024-11-02T00:00:00.000Z",
        rank: 3,
      },
      {
        // null title becomes "", empty highlights fall back to text, junk date is omitted
        url: "https://news.example.org/runtime-roundup",
        title: "",
        snippet: "A monthly digest of Rust runtime news. Issue 42 covers smol 3.0 and Tokio 2.0 plans.",
        rank: 4,
      },
    ];
    expect(out).toEqual(expected);
  });

  it("posts the documented request body and x-api-key header", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "secret-key").search(
      {
        query: "q",
        maxResults: 5,
        recency: "week",
        includeDomains: ["github.com"],
        excludeDomains: ["reddit.com"],
      },
      signal(),
    );
    const call = f.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.exa.ai/search");
    expect(call?.headers["x-api-key"]).toBe("secret-key");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual({
      query: "q",
      type: "auto",
      numResults: 5,
      contents: { highlights: { maxCharacters: 1000 } },
      startPublishedDate: "2025-06-08T12:00:00.000Z",
      includeDomains: ["github.com"],
      excludeDomains: ["reddit.com"],
    });
  });

  it.each([
    ["day", "2025-06-14T12:00:00.000Z"],
    ["week", "2025-06-08T12:00:00.000Z"],
    ["month", "2025-05-15T12:00:00.000Z"],
    ["year", "2024-06-15T12:00:00.000Z"],
  ] as const)("maps recency %s to startPublishedDate %s", async (recency, start) => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search({ ...BASE_QUERY, recency }, signal());
    expect((f.calls[0]?.body as Record<string, unknown>)["startPublishedDate"]).toBe(start);
  });

  it("omits optional fields when not requested", async () => {
    const f = fakeFetch(() => jsonResponse(fixture));
    await make(f.fetchImpl, "k").search(BASE_QUERY, signal());
    const body = f.calls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["contents", "numResults", "query", "type"]);
  });
});
