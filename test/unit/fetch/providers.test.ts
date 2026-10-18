import { describe, expect, it } from "vitest";
import { FirecrawlFetcher } from "../../../src/core/fetch/fast/firecrawl.js";
import { JinaFetcher } from "../../../src/core/fetch/fast/jina.js";
import { FetchError } from "../../../src/core/fetch/types.js";
import { OPTS, hangingFetch, jsonFixture, jsonResponse, mockFetch, neverAborted } from "./helpers.js";

type Json = Record<string, unknown>;

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchError);
    return err as FetchError;
  }
  throw new Error("expected the fetch to reject");
}

function withMetadata(base: Json, metadata: Json, markdown?: string): Json {
  const data = base["data"] as Json;
  return {
    ...base,
    data: { ...data, ...(markdown !== undefined && { markdown }), metadata: { ...(data["metadata"] as Json), ...metadata } },
  };
}

describe("FirecrawlFetcher", () => {
  const scrape = jsonFixture<Json>("firecrawl-scrape.json");

  it("is configured only when it has a key", () => {
    expect(new FirecrawlFetcher().isConfigured()).toBe(false);
    expect(new FirecrawlFetcher({ apiKey: "" }).isConfigured()).toBe(false);
    expect(new FirecrawlFetcher({ apiKey: "fc-test" }).isConfigured()).toBe(true);
    expect(new FirecrawlFetcher({ apiKey: "fc-test" }).name).toBe("firecrawl");
  });

  it("refuses to run without a key", async () => {
    const err = await failure(new FirecrawlFetcher().fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe("config");
  });

  it("posts to the v2 scrape endpoint with markdown format and a bearer key", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(scrape));
    await new FirecrawlFetcher({ apiKey: "fc-test", fetchImpl }).fetch("https://example.com/blog/caching", OPTS, neverAborted());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer fc-test");
    const body = JSON.parse(String(calls[0]?.init.body)) as Json;
    expect(body["url"]).toBe("https://example.com/blog/caching");
    expect(body["formats"]).toEqual(["markdown"]);
    expect(typeof body["timeout"]).toBe("number");
  });

  it("honors a custom baseUrl", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(scrape));
    await new FirecrawlFetcher({ apiKey: "k", fetchImpl, baseUrl: "http://localhost:3002/" }).fetch(
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(calls[0]?.url).toBe("http://localhost:3002/v2/scrape");
  });

  it("maps the fixture to a FetchResult with the redirected URL as final_url", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(scrape));
    const result = await new FirecrawlFetcher({ apiKey: "k", fetchImpl }).fetch(
      "https://example.com/blog/caching",
      OPTS,
      neverAborted(),
    );
    expect(result.method).toBe("firecrawl");
    expect(result.url).toBe("https://example.com/blog/caching");
    expect(result.final_url).toBe("https://www.example.com/blog/caching/");
    expect(result.title).toBe("Caching Strategies for Web Services");
    expect(result.markdown).toContain("## Choosing a strategy");
    expect(result.markdown).toContain("[full caching guide](https://example.com/docs/caching-guide)");
    expect(result.truncated).toBe(false);
    expect(result.botWall).toBe(false);
    expect(new Date(result.fetched_at).toISOString()).toBe(result.fetched_at);
  });

  it("accepts a title array and flags truncation", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(withMetadata(scrape, { title: ["First title", "Second"] })));
    const result = await new FirecrawlFetcher({ apiKey: "k", fetchImpl }).fetch(
      "https://example.com/",
      { ...OPTS, maxChars: 300 },
      neverAborted(),
    );
    expect(result.title).toBe("First title");
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(300);
  });

  it("sets botWall when the scraped markdown is a challenge page", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(withMetadata(scrape, {}, "# Just a moment...\n\nChecking if the site connection is secure")),
    );
    const result = await new FirecrawlFetcher({ apiKey: "k", fetchImpl }).fetch("https://example.com/", OPTS, neverAborted());
    expect(result.botWall).toBe(true);
  });

  it("maps a target 403 bot wall to blocked and a target 404 to provider", async () => {
    const blocked = mockFetch(() =>
      jsonResponse(withMetadata(scrape, { statusCode: 403 }, "Access Denied\n\nYou don't have permission to access this page.")),
    );
    const err403 = await failure(
      new FirecrawlFetcher({ apiKey: "k", fetchImpl: blocked.fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()),
    );
    expect(err403.code).toBe("blocked");
    expect(err403.retryable).toBe(false);

    const missing = mockFetch(() => jsonResponse(withMetadata(scrape, { statusCode: 404 }, "Page not found.")));
    const err404 = await failure(
      new FirecrawlFetcher({ apiKey: "k", fetchImpl: missing.fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()),
    );
    expect(err404.code).toBe("provider");
    expect(err404.retryable).toBe(false);
  });

  it.each([
    [401, "config", false],
    [402, "config", false],
    [429, "provider", true],
    [500, "provider", true],
    [503, "provider", true],
    [400, "provider", false],
  ])("maps API status %i to %s (retryable: %s)", async (status, code, retryable) => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ success: false, error: "nope" }, status));
    const err = await failure(new FirecrawlFetcher({ apiKey: "k", fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.message).toContain("nope");
  });

  it("rejects a malformed response with a typed error", async () => {
    const { fetchImpl } = mockFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const err = await failure(new FirecrawlFetcher({ apiKey: "k", fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe("provider");
  });

  it("maps a timeout to code timeout", async () => {
    const err = await failure(
      new FirecrawlFetcher({ apiKey: "k", fetchImpl: hangingFetch() }).fetch(
        "https://example.com/",
        { ...OPTS, timeoutMs: 30 },
        neverAborted(),
      ),
    );
    expect(err.code).toBe("timeout");
    expect(err.fetcher).toBe("firecrawl");
  });
});

describe("JinaFetcher", () => {
  const reader = jsonFixture<Json>("jina-reader.json");

  it("is always configured and named jina", () => {
    expect(new JinaFetcher().isConfigured()).toBe(true);
    expect(new JinaFetcher({ apiKey: "jina_x" }).isConfigured()).toBe(true);
    expect(new JinaFetcher().name).toBe("jina");
  });

  it("requests JSON from r.jina.ai without X-Return-Format, unauthenticated by default", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(reader));
    await new JinaFetcher({ fetchImpl }).fetch("https://example.com/blog/caching", OPTS, neverAborted());
    expect(calls[0]?.url).toBe("https://r.jina.ai/https://example.com/blog/caching");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["X-Return-Format"]).toBeUndefined();
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends a bearer token when a key is set", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(reader));
    await new JinaFetcher({ apiKey: "jina_secret", fetchImpl }).fetch("https://example.com/", OPTS, neverAborted());
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jina_secret");
  });

  it("maps the fixture to a FetchResult", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(reader));
    const result = await new JinaFetcher({ fetchImpl }).fetch("https://example.com/blog/caching", OPTS, neverAborted());
    expect(result.method).toBe("jina");
    expect(result.url).toBe("https://example.com/blog/caching");
    expect(result.final_url).toBe("https://www.example.com/blog/caching/");
    expect(result.title).toBe("Caching Strategies for Web Services");
    expect(result.markdown).toContain("## Choosing a strategy");
    expect(result.truncated).toBe(false);
    expect(result.botWall).toBe(false);
    expect(new Date(result.fetched_at).toISOString()).toBe(result.fetched_at);
  });

  it("flags truncation at maxChars on a line boundary", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(reader));
    const result = await new JinaFetcher({ fetchImpl }).fetch("https://example.com/", { ...OPTS, maxChars: 400 }, neverAborted());
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(400);
    const content = (reader["data"] as Json)["content"] as string;
    expect(content.startsWith(result.markdown)).toBe(true);
    expect(content.charAt(result.markdown.length)).toBe("\n");
  });

  it("sets botWall for a challenge page returned as content", async () => {
    const challenge = { code: 200, status: 20000, data: { title: "Just a moment...", url: "https://example.com/", content: "Just a moment...\n\nEnable JavaScript and cookies to continue", httpStatus: 200 } };
    const { fetchImpl } = mockFetch(() => jsonResponse(challenge));
    const result = await new JinaFetcher({ fetchImpl }).fetch("https://example.com/", OPTS, neverAborted());
    expect(result.botWall).toBe(true);
  });

  it("maps a target 403 reported in the envelope to blocked", async () => {
    const envelope = { code: 200, data: { title: "Access Denied", url: "https://example.com/", content: "Access Denied", httpStatus: 403 } };
    const { fetchImpl } = mockFetch(() => jsonResponse(envelope));
    const err = await failure(new JinaFetcher({ fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe("blocked");
    expect(err.retryable).toBe(false);
  });

  it("maps the anonymous-access refusal to a config error that names JINA_API_KEY", async () => {
    const refusal = { data: null, code: 401, name: "AuthenticationRequiredError", status: 40103, message: "Please authenticate." };
    const { fetchImpl } = mockFetch(() => jsonResponse(refusal, 401));
    const err = await failure(new JinaFetcher({ fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe("config");
    expect(err.message).toContain("JINA_API_KEY");
    expect(err.retryable).toBe(false);
  });

  it.each([
    [429, true],
    [500, true],
    [502, true],
    [422, false],
    [403, false],
  ])("maps API status %i to a provider error (retryable: %s)", async (status, retryable) => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ data: null, code: status, message: "upstream trouble" }, status));
    const err = await failure(new JinaFetcher({ fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(retryable);
    expect(err.message).toContain("upstream trouble");
  });

  it("rejects a malformed response with a typed error", async () => {
    const { fetchImpl } = mockFetch(() => new Response("plain text, not json", { status: 200 }));
    const err = await failure(new JinaFetcher({ fetchImpl }).fetch("https://example.com/", OPTS, neverAborted()));
    expect(err.code).toBe("provider");
  });

  it("maps a timeout to code timeout", async () => {
    const err = await failure(
      new JinaFetcher({ fetchImpl: hangingFetch() }).fetch("https://example.com/", { ...OPTS, timeoutMs: 30 }, neverAborted()),
    );
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.fetcher).toBe("jina");
  });
});
