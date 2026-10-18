import { describe, expect, it } from "vitest";
import { DirectFetcher, decodeBody } from "../../../src/core/fetch/fast/direct.js";
import { FetchError } from "../../../src/core/fetch/types.js";
import { OPTS, fixture, hangingFetch, htmlResponse, jsonFixture, mockFetch, neverAborted } from "./helpers.js";

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchError);
    return err as FetchError;
  }
  throw new Error("expected the fetch to reject");
}

describe("DirectFetcher", () => {
  it("is always configured and named direct", () => {
    const fetcher = new DirectFetcher();
    expect(fetcher.name).toBe("direct");
    expect(fetcher.isConfigured()).toBe(true);
  });

  it("maps the article fixture to a FetchResult", async () => {
    const { fetchImpl, calls } = mockFetch(() => htmlResponse(fixture("article.html")));
    const before = Date.now();
    const result = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/blog/caching", OPTS, neverAborted());

    expect(result.method).toBe("direct");
    expect(result.url).toBe("https://example.com/blog/caching");
    expect(result.final_url).toBe("https://example.com/blog/caching");
    expect(result.title).toBe("Caching Strategies for Web Services");
    expect(result.markdown).toContain("## Choosing a strategy");
    expect(result.markdown).toContain("| Cache-aside | Low | High |");
    expect(result.markdown).not.toContain("Copyright 2026");
    expect(result.truncated).toBe(false);
    expect(result.botWall).toBe(false);
    expect(new Date(result.fetched_at).toISOString()).toBe(result.fetched_at);
    expect(Date.parse(result.fetched_at)).toBeGreaterThanOrEqual(before);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla\/5\.0 .*Chrome\/\d+/);
    expect(headers["Accept"]).toContain("text/html");
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("follows the recorded redirect chain and reports final_url", async () => {
    const chain = jsonFixture<{ responses: Array<{ url: string; status: number; headers: Record<string, string>; body: string }> }>(
      "redirect-chain.json",
    );
    const byUrl = new Map(chain.responses.map((r) => [r.url, r]));
    const { fetchImpl, calls } = mockFetch((url) => {
      const recorded = byUrl.get(url);
      if (!recorded) throw new Error(`unexpected request to ${url}`);
      return new Response(recorded.body === "" ? null : recorded.body, { status: recorded.status, headers: recorded.headers });
    });

    const result = await new DirectFetcher({ fetchImpl }).fetch("http://example.com/old-path", OPTS, neverAborted());

    expect(calls.map((c) => c.url)).toEqual(["http://example.com/old-path", "https://www.example.com/new/final-path"]);
    expect(result.url).toBe("http://example.com/old-path");
    expect(result.final_url).toBe("https://www.example.com/new/final-path");
    expect(result.title).toBe("Final Destination");
    // Relative links resolve against the final URL, not the original.
    expect(result.markdown).toContain("[the docs](https://www.example.com/docs)");
  });

  it("resolves relative Location headers and gives up after too many redirects", async () => {
    const hops: string[] = [];
    const { fetchImpl } = mockFetch((url) => {
      hops.push(url);
      return new Response(null, { status: 302, headers: { location: "/loop" } });
    });
    const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/start", OPTS, neverAborted()));
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/too many redirects/i);
    expect(hops[1]).toBe("https://example.com/loop");
    expect(hops.length).toBe(11);
  });

  it("returns text/plain as-is inside a code fence", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(fixture("plain.txt"), { headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
    const result = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/RELEASES.txt", OPTS, neverAborted());
    // The text contains a literal ``` fence, so the wrapper must use a longer one.
    expect(result.markdown.startsWith("````\nrelease-notes 2.4.0")).toBe(true);
    expect(result.markdown.endsWith("Thanks to everyone who reported issues.\n````")).toBe(true);
    expect(result.markdown).toContain("This line contains a literal fence");
    expect(result.botWall).toBe(false);
  });

  it("rejects a PDF that cannot be parsed with invalid_input (extraction itself is in pdf.test.ts)", async () => {
    const { fetchImpl } = mockFetch(() => new Response("%PDF-1.7 ...", { headers: { "content-type": "application/pdf" } }));
    const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/paper.pdf", OPTS, neverAborted()));
    expect(err.code).toBe("invalid_input");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/Could not read the PDF/);
    expect(err.fetcher).toBe("direct");
  });

  it("detects PDFs by their magic bytes when the content type is generic", async () => {
    const { fetchImpl } = mockFetch(() => new Response("%PDF-1.7 binary", { headers: { "content-type": "application/octet-stream" } }));
    const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/download", OPTS, neverAborted()));
    expect(err.code).toBe("invalid_input");
    expect(err.message).toMatch(/Could not read the PDF/);
  });

  it("rejects other binary types with invalid_input", async () => {
    const { fetchImpl } = mockFetch(() => new Response("GIF89a", { headers: { "content-type": "image/gif" } }));
    const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/a.gif", OPTS, neverAborted()));
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("image/gif");
  });

  it("rejects non-http URLs and malformed URLs with invalid_input", async () => {
    const { fetchImpl, calls } = mockFetch(() => htmlResponse("x"));
    const fetcher = new DirectFetcher({ fetchImpl });
    expect((await failure(fetcher.fetch("file:///etc/passwd", OPTS, neverAborted()))).code).toBe("invalid_input");
    expect((await failure(fetcher.fetch("not a url", OPTS, neverAborted()))).code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  describe("maxChars", () => {
    it("flags truncation and cuts on a line boundary", async () => {
      const { fetchImpl } = mockFetch(() => htmlResponse(fixture("article.html")));
      const full = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/a", OPTS, neverAborted());
      const maxChars = 700;
      const cut = await new DirectFetcher({ fetchImpl }).fetch(
        "https://example.com/a",
        { ...OPTS, maxChars },
        neverAborted(),
      );
      expect(cut.truncated).toBe(true);
      expect(cut.markdown.length).toBeLessThanOrEqual(maxChars);
      expect(full.markdown.startsWith(cut.markdown)).toBe(true);
      // The cut text ends where a line ended in the full text.
      expect(full.markdown.charAt(cut.markdown.length)).toBe("\n");
    });

    it("does not flag truncation when the page fits", async () => {
      const { fetchImpl } = mockFetch(() => htmlResponse(fixture("article.html")));
      const result = await new DirectFetcher({ fetchImpl }).fetch(
        "https://example.com/a",
        { ...OPTS, maxChars: 100_000 },
        neverAborted(),
      );
      expect(result.truncated).toBe(false);
    });

    it("keeps the closing fence when truncating plain text", async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
      const { fetchImpl } = mockFetch(() => new Response(lines, { headers: { "content-type": "text/plain" } }));
      const result = await new DirectFetcher({ fetchImpl }).fetch(
        "https://example.com/big.txt",
        { ...OPTS, maxChars: 100 },
        neverAborted(),
      );
      expect(result.truncated).toBe(true);
      expect(result.markdown.length).toBeLessThanOrEqual(100);
      expect(result.markdown.endsWith("\n```")).toBe(true);
    });
  });

  describe("failures", () => {
    it("maps a timeout to code timeout", async () => {
      const fetcher = new DirectFetcher({ fetchImpl: hangingFetch() });
      const err = await failure(fetcher.fetch("https://example.com/slow", { ...OPTS, timeoutMs: 30 }, neverAborted()));
      expect(err.code).toBe("timeout");
      expect(err.retryable).toBe(true);
      expect(err.fetcher).toBe("direct");
    });

    it("honors the caller's AbortSignal", async () => {
      const controller = new AbortController();
      const fetcher = new DirectFetcher({ fetchImpl: hangingFetch() });
      const pending = failure(fetcher.fetch("https://example.com/slow", { ...OPTS, timeoutMs: 10_000 }, controller.signal));
      controller.abort();
      const err = await pending;
      expect(err.code).toBe("timeout");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/aborted/);
    });

    it("maps a network error to a retryable provider error", async () => {
      const { fetchImpl } = mockFetch(() => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.invalid") });
      });
      const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.invalid/", OPTS, neverAborted()));
      expect(err.code).toBe("provider");
      expect(err.retryable).toBe(true);
      expect(err.message).toContain("ENOTFOUND");
    });

    it.each([
      [404, false],
      [410, false],
      [500, true],
      [502, true],
      [503, true],
    ])("maps HTTP %i to a provider error (retryable: %s)", async (status, retryable) => {
      const { fetchImpl } = mockFetch(() => htmlResponse("<html><body><p>Something went wrong on our side. Please try again later or contact support if the problem persists for a long time and you need help.</p></body></html>", { status }));
      const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/x", OPTS, neverAborted()));
      expect(err.code).toBe("provider");
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBe(status);
    });

    it("maps a 429 with a long normal body to a retryable provider error", async () => {
      const { fetchImpl } = mockFetch(() => htmlResponse(fixture("article.html"), { status: 429 }));
      const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/x", OPTS, neverAborted()));
      expect(err.code).toBe("provider");
      expect(err.retryable).toBe(true);
    });

    it.each([
      ["akamai 403", 403, "akamai-403.html", {}],
      ["cloudflare 403", 403, "cloudflare-challenge.html", { "cf-mitigated": "challenge" }],
      ["perimeterx 403", 403, "perimeterx.html", {}],
    ])("maps a bot wall (%s) to a non-retryable blocked error", async (_name, status, file, headers) => {
      const { fetchImpl } = mockFetch(() => htmlResponse(fixture(file), { status, headers }));
      const err = await failure(new DirectFetcher({ fetchImpl }).fetch("https://example.com/x", OPTS, neverAborted()));
      expect(err.code).toBe("blocked");
      expect(err.retryable).toBe(false);
      expect(err.status).toBe(status);
    });
  });

  describe("bot walls served with HTTP 200", () => {
    it.each(["cloudflare-challenge.html", "enable-javascript.html"])("%s returns a result with botWall true", async (file) => {
      const { fetchImpl } = mockFetch(() => htmlResponse(fixture(file)));
      const result = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/x", OPTS, neverAborted());
      expect(result.botWall).toBe(true);
    });
  });

  describe("charset decoding", () => {
    const text = "Café crème et à la carte: " + "mots accentués. ".repeat(40);

    it("uses the charset from the Content-Type header", async () => {
      const body = Buffer.from(`<html><head><title>Café</title></head><body><main><p>${text}</p></main></body></html>`, "latin1");
      const { fetchImpl } = mockFetch(
        () => new Response(body, { headers: { "content-type": "text/html; charset=ISO-8859-1" } }),
      );
      const result = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/fr", OPTS, neverAborted());
      expect(result.title).toBe("Café");
      expect(result.markdown).toContain("Café crème et à la carte");
    });

    it("falls back to the meta charset when the header has none", async () => {
      const body = Buffer.from(
        `<html><head><meta charset="windows-1252"><title>Café</title></head><body><main><p>${text}</p></main></body></html>`,
        "latin1",
      );
      const { fetchImpl } = mockFetch(() => new Response(body, { headers: { "content-type": "text/html" } }));
      const result = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/fr", OPTS, neverAborted());
      expect(result.title).toBe("Café");
      expect(result.markdown).toContain("mots accentués");
    });

    it("decodeBody understands http-equiv meta tags and defaults to UTF-8", () => {
      const latin = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">café', "latin1");
      expect(decodeBody(latin, "text/html")).toContain("café");
      expect(decodeBody(Buffer.from("café", "utf8"), "")).toBe("café");
      expect(decodeBody(Buffer.from("café", "utf8"), "text/html; charset=bogus-charset")).toBe("café");
    });
  });
});
