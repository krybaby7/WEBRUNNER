import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchOpts } from "../../../src/core/fetch/types.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/fetch/", import.meta.url));

export function fixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

export function jsonFixture<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** An injectable fetch that records every call and answers from `handler`. */
export function mockFetch(handler: Handler): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that never answers, and rejects with the abort reason when aborted. */
export function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

export function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const OPTS: FetchOpts = { maxChars: 40_000, timeoutMs: 5_000 };

export function neverAborted(): AbortSignal {
  return new AbortController().signal;
}
