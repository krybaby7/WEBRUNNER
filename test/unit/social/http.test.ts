import { describe, expect, it } from "vitest";
import {
  allocate,
  fetchJson,
  htmlToText,
  interleave,
  makeRedactor,
  perThread,
  sinceEpochSeconds,
  SocialHttpError,
  toCount,
  toIso,
  toNumber,
} from "../../../src/core/social/http.js";
import { SocialProviderError } from "../../../src/core/social/types.js";
import { fakeFetch, jsonResponse, signal } from "./helpers.js";

const SECRET = "super-secret-token-value";

async function failing(respond: Parameters<typeof fakeFetch>[0], s: AbortSignal = signal()): Promise<unknown> {
  const f = fakeFetch(respond);
  return fetchJson({ platform: "reddit", url: "https://api.example.com/x", fetchImpl: f.fetchImpl, signal: s, secrets: [SECRET] }).catch(
    (e: unknown) => e,
  );
}

describe("fetchJson", () => {
  it("returns the parsed body on 2xx and forwards the signal", async () => {
    const f = fakeFetch(() => jsonResponse({ ok: 1 }));
    const s = signal();
    expect(await fetchJson({ platform: "bluesky", url: "https://x/y", fetchImpl: f.fetchImpl, signal: s })).toEqual({ ok: 1 });
    expect(f.calls[0]?.url).toBe("https://x/y");
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
  ])("maps HTTP %i to a SocialHttpError with retryable=%s", async (status, retryable) => {
    const err = await failing(() => jsonResponse({ error: "nope" }, status));
    expect(err).toBeInstanceOf(SocialHttpError);
    expect(err).toMatchObject({ platform: "reddit", code: "provider", status, retryable });
    expect((err as Error).message).toContain(`HTTP ${status}`);
  });

  it("reads Retry-After on a 429 as retryAfterMs (seconds and HTTP dates)", async () => {
    const a = (await failing(() => new Response("", { status: 429, headers: { "retry-after": "7" } }))) as SocialHttpError;
    expect(a.retryAfterMs).toBe(7000);
    const b = (await failing(() => new Response("", { status: 429 }))) as SocialHttpError;
    expect(b.retryAfterMs).toBeUndefined();
    const c = (await failing(() => new Response("", { status: 503, headers: { "retry-after": "7" } }))) as SocialHttpError;
    expect(c.retryAfterMs).toBeUndefined();
  });

  it("redacts secrets and credential-like pairs from the body preview", async () => {
    const err = (await failing(
      () => new Response(`denied for ${SECRET}; access_token=abc123 Authorization: Bearer xyz.123`, { status: 403 }),
    )) as SocialHttpError;
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain("abc123");
    expect(err.message).not.toContain("xyz.123");
    expect(err.bodyPreview).toContain("[redacted]");
  });

  it("turns a network failure into a retryable provider error", async () => {
    const err = await failing(() => Promise.reject(new TypeError(`fetch failed ${SECRET}`)));
    expect(err).toBeInstanceOf(SocialProviderError);
    expect(err).toMatchObject({ code: "provider", retryable: true });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("rejects with code timeout when the signal is already aborted, without calling fetch", async () => {
    const f = fakeFetch(() => jsonResponse({}));
    const controller = new AbortController();
    controller.abort();
    const err = await fetchJson({ platform: "youtube", url: "https://x/y", fetchImpl: f.fetchImpl, signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ platform: "youtube", code: "timeout", retryable: true });
    expect(f.calls).toHaveLength(0);
  });

  it("rejects with code timeout when the signal aborts mid-flight even if fetch ignores it", async () => {
    const controller = new AbortController();
    const f = fakeFetch(() => new Promise<Response>(() => undefined));
    const p = fetchJson({ platform: "hackernews", url: "https://x/y", fetchImpl: f.fetchImpl, signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects a body that is not JSON as a non-retryable provider error", async () => {
    const err = await failing(() => new Response("<html>", { status: 200 }));
    expect(err).toMatchObject({ code: "provider", retryable: false, status: 200 });
  });
});

describe("mapping helpers", () => {
  it("htmlToText flattens tags and decodes entities", () => {
    expect(htmlToText("I&#x27;m <i>sure</i>.<p>Second &quot;para&quot; &amp; more")).toBe(`I'm sure.\nSecond "para" & more`);
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("a<br>b<br/>c")).toBe("a\nb\nc");
  });

  it("toIso, toNumber and toCount", () => {
    expect(toIso(1615342615)).toBe("2021-03-10T02:16:55.000Z");
    expect(toIso("2021-03-10T02:16:55Z")).toBe("2021-03-10T02:16:55.000Z");
    expect(toIso("nope")).toBeUndefined();
    expect(toNumber("2150")).toBe(2150);
    expect(toNumber(null)).toBeUndefined();
    expect(toNumber("12abc")).toBeUndefined();
    expect(toCount(-1)).toBeUndefined();
    expect(toCount("3.7")).toBe(3);
  });

  it("sinceEpochSeconds measures from the injected clock", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(sinceEpochSeconds("day", now)).toBe(Math.floor(now / 1000) - 86_400);
    expect(sinceEpochSeconds(undefined, now)).toBeUndefined();
  });

  it("allocate splits the per-platform budget", () => {
    expect(allocate("posts", 10)).toEqual({ posts: 10, comments: 0 });
    expect(allocate("comments", 10)).toEqual({ posts: 0, comments: 10 });
    expect(allocate("both", 10)).toEqual({ posts: 5, comments: 5 });
    expect(allocate("both", 5)).toEqual({ posts: 3, comments: 2 });
    expect(allocate("both", 1)).toEqual({ posts: 1, comments: 0 });
  });

  it("perThread and interleave spread a budget over sources", () => {
    expect(perThread(6, 4)).toBe(2);
    expect(perThread(1, 3)).toBe(1);
    expect(perThread(5, 0)).toBe(0);
    expect(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]], 5)).toEqual(["a1", "b1", "c1", "a2", "c2"]);
    expect(interleave([["a1"]], 0)).toEqual([]);
  });

  it("makeRedactor scrubs exact values and patterns", () => {
    const redact = makeRedactor([SECRET, "short", undefined]);
    expect(redact(`k=${SECRET} short Basic QUJD= key: abc`)).toBe("k=[redacted] short Basic [redacted] key: [redacted]");
  });
});
