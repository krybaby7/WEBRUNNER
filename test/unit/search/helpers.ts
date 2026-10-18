import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProviderError, type SearchProvider, type SearchQuery } from "../../../src/core/search/types.js";

export function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/search/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch stand-in that records requests and answers with `respond`. */
export function fakeFetch(respond: Responder): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: rawBody !== undefined ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const BASE_QUERY: SearchQuery = { query: "rust async runtime comparison", maxResults: 10 };

export interface ProviderCase {
  name: string;
  /** Build the provider with an injected fetch. */
  make: (fetchImpl: typeof fetch, apiKey?: string) => SearchProvider;
  /** A valid body (at least two results) the provider accepts. */
  validBody: unknown;
}

/** Error-path expectations shared by all four providers. */
export async function expectProviderError(
  p: Promise<unknown>,
  expected: { provider: string; retryable: boolean; status?: number; aborted?: boolean },
): Promise<ProviderError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  const pe = err as ProviderError;
  expect(pe.code).toBe("provider");
  expect(pe.provider).toBe(expected.provider);
  expect(pe.retryable).toBe(expected.retryable);
  if (expected.status !== undefined) expect(pe.status).toBe(expected.status);
  if (expected.aborted !== undefined) expect(pe.aborted).toBe(expected.aborted);
  return pe;
}

/** Copy of a valid body with the second result's url removed. */
function withBrokenSecondItem(body: unknown): unknown {
  const copy = structuredClone(body) as {
    results?: Record<string, unknown>[];
    web?: { results: Record<string, unknown>[] };
  };
  const list = copy.web?.results ?? copy.results;
  if (list === undefined || list[1] === undefined) throw new Error("fixture needs at least two results");
  delete list[1]["url"];
  return copy;
}

/** Registers the error-handling and cross-cutting tests every provider must pass. */
export function describeProviderContract(c: ProviderCase): void {
  const signal = (): AbortSignal => new AbortController().signal;
  const key = "test-key";

  describe(`${c.name}: contract`, () => {
    it("isConfigured reflects the api key", () => {
      const f = fakeFetch(() => jsonResponse(c.validBody));
      expect(c.make(f.fetchImpl, key).isConfigured()).toBe(true);
      expect(c.make(f.fetchImpl, undefined).isConfigured()).toBe(false);
      expect(c.make(f.fetchImpl, "").isConfigured()).toBe(false);
      expect(c.make(f.fetchImpl, "   ").isConfigured()).toBe(false);
    });

    it("refuses to search without a key and never calls the network", async () => {
      const f = fakeFetch(() => jsonResponse(c.validBody));
      await expectProviderError(c.make(f.fetchImpl, undefined).search(BASE_QUERY, signal()), {
        provider: c.name,
        retryable: false,
      });
      expect(f.calls).toHaveLength(0);
    });

    it.each([
      [429, true],
      [500, true],
      [503, true],
      [401, false],
      [400, false],
    ])("HTTP %i gives a ProviderError with retryable=%s", async (status, retryable) => {
      const f = fakeFetch(() => jsonResponse({ error: "nope" }, status));
      const err = await expectProviderError(c.make(f.fetchImpl, key).search(BASE_QUERY, signal()), {
        provider: c.name,
        retryable,
        status,
        aborted: false,
      });
      expect(err.message).toContain(String(status));
      expect(err.message).not.toContain(key);
    });

    it("turns a network failure into a retryable ProviderError", async () => {
      const f = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
      await expectProviderError(c.make(f.fetchImpl, key).search(BASE_QUERY, signal()), {
        provider: c.name,
        retryable: true,
        aborted: false,
      });
    });

    it("rejects promptly when the signal aborts mid-flight, even if fetch ignores the signal", async () => {
      const f = fakeFetch(() => new Promise<Response>(() => undefined));
      const ac = new AbortController();
      const started = Date.now();
      const pending = expectProviderError(c.make(f.fetchImpl, key).search(BASE_QUERY, ac.signal), {
        provider: c.name,
        retryable: true,
        aborted: true,
      });
      setTimeout(() => ac.abort(), 20);
      await pending;
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("rejects without calling fetch when the signal is already aborted", async () => {
      const f = fakeFetch(() => jsonResponse(c.validBody));
      const ac = new AbortController();
      ac.abort();
      await expectProviderError(c.make(f.fetchImpl, key).search(BASE_QUERY, ac.signal), {
        provider: c.name,
        retryable: true,
        aborted: true,
      });
      expect(f.calls).toHaveLength(0);
    });

    it("passes the signal through to fetch", async () => {
      let seen: AbortSignal | undefined;
      const fetchImpl = ((_u: string | URL | Request, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return Promise.resolve(jsonResponse(c.validBody));
      }) as typeof fetch;
      const ac = new AbortController();
      await c.make(fetchImpl, key).search(BASE_QUERY, ac.signal);
      expect(seen).toBe(ac.signal);
    });

    it.each([
      ["a body that is not JSON", () => new Response("<html>oops</html>", { status: 200 })],
      ["an empty body", () => new Response("", { status: 200 })],
      ["JSON of the wrong type", () => jsonResponse([1, 2, 3])],
      ["JSON of the wrong shape", () => jsonResponse({ unexpected: true })],
      ["results that is not an array", () => jsonResponse({ results: "none", web: { results: "none" }, query: {} })],
      [
        "a result without a url",
        () => jsonResponse({ results: [{ title: "x" }], web: { results: [{ title: "x" }] }, query: {} }),
      ],
    ])("throws a non-retryable ProviderError for %s", async (_label, respond) => {
      const f = fakeFetch(respond);
      await expectProviderError(c.make(f.fetchImpl, key).search(BASE_QUERY, signal()), {
        provider: c.name,
        retryable: false,
      });
    });

    it("fails the whole response when any single item is malformed", async () => {
      const f = fakeFetch(() => jsonResponse(withBrokenSecondItem(c.validBody)));
      await expectProviderError(c.make(f.fetchImpl, key).search(BASE_QUERY, signal()), {
        provider: c.name,
        retryable: false,
      });
    });

    it("applies maxResults and keeps ranks 1-based and contiguous", async () => {
      const f = fakeFetch(() => jsonResponse(c.validBody));
      const out = await c.make(f.fetchImpl, key).search({ ...BASE_QUERY, maxResults: 2 }, signal());
      expect(out.map((r) => r.rank)).toEqual([1, 2]);
    });
  });
}
