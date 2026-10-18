import { describe, expect, it } from "vitest";
import { redactSecrets, requestJson, requestText, statusError } from "../../../src/core/reviews/http.js";
import { ReviewSourceError } from "../../../src/core/reviews/types.js";
import { fakeFetch, forever, jsonResponse } from "./helpers.js";

const signal = (): AbortSignal => new AbortController().signal;

async function rejection(p: Promise<unknown>): Promise<ReviewSourceError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReviewSourceError);
  return err as ReviewSourceError;
}

describe("statusError", () => {
  it.each<[number, string, boolean]>([
    [404, "not_found", false],
    [401, "blocked", false],
    [403, "blocked", false],
    [429, "provider", true],
    [500, "provider", true],
    [503, "provider", true],
    [400, "provider", false],
    [418, "provider", false],
  ])("HTTP %d is %s (retryable %s)", (status, code, retryable) => {
    const err = statusError("app_store", status, "<html>oops</html>");
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
    expect(err.source).toBe("app_store");
  });

  it("uses the not-found message and redacts the body preview", () => {
    expect(statusError("app_store", 404, "", { notFoundMessage: "no such app" }).message).toBe("no such app");
    const err = statusError("trustpilot", 500, '{"error":"bad","api_key":"sk-live-123456"}');
    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain("sk-live-123456");
  });
});

describe("redactSecrets", () => {
  it("masks bearer tokens and key=value credentials", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(redactSecrets("https://x/?api_key=SECRET&q=1")).toBe("https://x/?api_key=[redacted]&q=1");
    expect(redactSecrets("token: tok_123, next")).toBe("token: [redacted], next");
    expect(redactSecrets("nothing here")).toBe("nothing here");
  });
});

describe("requestJson / requestText", () => {
  it("returns the parsed body and sends an Accept header", async () => {
    const f = fakeFetch(() => jsonResponse({ ok: 1 }));
    expect(await requestJson({ source: "app_store", url: "https://example.org/x", fetchImpl: f.fetchImpl, signal: signal() })).toEqual({ ok: 1 });
    expect(f.calls[0]?.headers["accept"]).toBe("application/json");
  });

  it("maps non-2xx statuses and non-JSON bodies to provider-side errors", async () => {
    const f500 = fakeFetch(() => jsonResponse({ error: "down" }, 500));
    const err500 = await rejection(requestJson({ source: "app_store", url: "u", fetchImpl: f500.fetchImpl, signal: signal() }));
    expect(err500).toMatchObject({ code: "provider", retryable: true, status: 500 });

    const fHtml = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const errHtml = await rejection(requestJson({ source: "app_store", url: "u", fetchImpl: fHtml.fetchImpl, signal: signal() }));
    expect(errHtml).toMatchObject({ code: "provider", retryable: false });
    expect(errHtml.message).toContain("not valid JSON");
  });

  it("turns a network failure into a retryable provider error with the cause redacted", async () => {
    const f = fakeFetch(() => Promise.reject(new Error("ECONNRESET token=abc")));
    const err = await rejection(requestText({ source: "trustpilot", url: "u", fetchImpl: f.fetchImpl, signal: signal() }));
    expect(err).toMatchObject({ code: "provider", retryable: true });
    expect(err.message).toContain("ECONNRESET");
    expect(err.message).not.toContain("abc");
  });

  it("fails as timeout when the signal is already aborted or aborts while the fetch hangs", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const f = fakeFetch(() => jsonResponse({}));
    const early = await rejection(requestJson({ source: "app_store", url: "u", fetchImpl: f.fetchImpl, signal: aborted.signal }));
    expect(early.code).toBe("timeout");
    expect(f.calls).toHaveLength(0);

    const hanging = fakeFetch(() => forever<Response>());
    const late = await rejection(requestJson({ source: "app_store", url: "u", fetchImpl: hanging.fetchImpl, signal: AbortSignal.timeout(20) }));
    expect(late).toMatchObject({ code: "timeout", retryable: true });
    expect(late.message).toContain("timed out");
  });

  it("returns non-2xx bodies through requestText so the caller can classify them", async () => {
    const f = fakeFetch(() => new Response("<title>Verifying Connection</title>", { status: 403, headers: { server: "CloudFront" } }));
    const res = await requestText({ source: "trustpilot", url: "u", fetchImpl: f.fetchImpl, signal: signal() });
    expect(res.status).toBe(403);
    expect(res.headers.get("server")).toBe("CloudFront");
    expect(res.text).toContain("Verifying Connection");
  });
});
