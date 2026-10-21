import { describe, expect, it } from "vitest";
import { parseMarketBody, RateLimitedMarketError, redactSecrets, requestMarketJson, round } from "../../../src/core/markets/http.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import { z } from "zod";
import { fakeFetch, jsonResponse, signal } from "./helpers.js";

const req = (f: ReturnType<typeof fakeFetch>, extra: Partial<Parameters<typeof requestMarketJson>[0]> = {}) =>
  requestMarketJson({ provider: "yahoo", url: "https://x.test/a?token=abc123secret", fetchImpl: f.fetchImpl, signal: signal(), ...extra });

async function failure(p: Promise<unknown>): Promise<MarketProviderError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MarketProviderError);
  return err as MarketProviderError;
}

describe("requestMarketJson", () => {
  it("returns status and parsed body on 2xx and sends Accept plus extra headers with the signal", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = ((_u: string, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(jsonResponse({ ok: 1 }));
    }) as typeof fetch;
    const ac = new AbortController();
    const out = await requestMarketJson({ provider: "finnhub", url: "https://x.test", fetchImpl, signal: ac.signal, headers: { "User-Agent": "ua" } });
    expect(out).toEqual({ status: 200, body: { ok: 1 } });
    expect(seen?.signal).toBe(ac.signal);
    expect(new Headers(seen?.headers).get("user-agent")).toBe("ua");
    expect(new Headers(seen?.headers).get("accept")).toBe("application/json");
  });

  it("maps 429 to a retryable RateLimitedMarketError carrying Retry-After", async () => {
    const f = fakeFetch(() => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "7" } }));
    const err = await failure(req(f));
    expect(err).toBeInstanceOf(RateLimitedMarketError);
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
    expect((err as RateLimitedMarketError).retryAfterMs).toBe(7000);
  });

  it("a 429 without Retry-After carries 0", async () => {
    const f = fakeFetch(() => new Response("Too Many Requests", { status: 429 }));
    const err = (await failure(req(f))) as RateLimitedMarketError;
    expect(err.retryAfterMs).toBe(0);
  });

  it.each([
    [500, "provider", true],
    [503, "provider", true],
    [404, "provider", false],
    [400, "provider", false],
    [401, "config", false],
    [403, "config", false],
  ] as const)("HTTP %i is code %s retryable=%s", async (status, code, retryable) => {
    const f = fakeFetch(() => jsonResponse({ error: "nope token=abc123secret" }, status));
    const err = await failure(req(f));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
    expect(err.message).toContain(String(status));
    expect(err.message).not.toContain("abc123secret");
  });

  it("returns accepted non-2xx statuses with their body", async () => {
    const f = fakeFetch(() => jsonResponse({ chart: { error: { code: "Not Found" } } }, 404));
    const out = await req(f, { acceptStatuses: [404] });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ chart: { error: { code: "Not Found" } } });
  });

  it("network failures are retryable provider errors", async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const err = await failure(req(f));
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(true);
  });

  it("an aborted signal is a timeout, before and during the request", async () => {
    const pre = new AbortController();
    pre.abort();
    const f1 = fakeFetch(() => jsonResponse({}));
    const e1 = await failure(requestMarketJson({ provider: "coingecko", url: "https://x.test", fetchImpl: f1.fetchImpl, signal: pre.signal }));
    expect(e1.code).toBe("timeout");
    expect(f1.calls).toHaveLength(0);

    const f2 = fakeFetch(() => new Promise<Response>(() => undefined));
    const ac = new AbortController();
    const pending = failure(requestMarketJson({ provider: "coingecko", url: "https://x.test", fetchImpl: f2.fetchImpl, signal: ac.signal }));
    setTimeout(() => ac.abort(), 10);
    const e2 = await pending;
    expect(e2.code).toBe("timeout");
    expect(e2.retryable).toBe(true);
  });

  it("a non-JSON body is a non-retryable provider error", async () => {
    const f = fakeFetch(() => new Response("<html>", { status: 200 }));
    const err = await failure(req(f));
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(false);
  });
});

describe("parseMarketBody, redactSecrets, round", () => {
  it("rejects a shape mismatch with a non-retryable provider error naming the path", async () => {
    const err = await failure(Promise.resolve().then(() => parseMarketBody("yahoo", z.object({ a: z.number() }), { a: "x" })));
    expect(err.code).toBe("provider");
    expect(err.message).toContain("a:");
  });

  it("redacts token query values, bearer tokens and exact secrets", () => {
    expect(redactSecrets("GET /quote?symbol=AAPL&token=abc123secret failed")).toBe("GET /quote?symbol=AAPL&token=[redacted] failed");
    expect(redactSecrets("Authorization: Bearer xyz.123")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets("saw s3cr3tvalue here", ["s3cr3tvalue"])).toBe("saw [redacted] here");
  });

  it("round removes float noise", () => {
    expect(round(343.46 - 342, 6)).toBe(1.46);
  });
});
