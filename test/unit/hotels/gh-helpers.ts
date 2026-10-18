import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { ExtractedHotel } from "../../../src/core/browser/recipes/google-hotels.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../../src/core/llm/types.js";
import type { Logger } from "../../../src/log.js";
import type { NormalizedHotelsQuery } from "../../../src/schemas/hotels.js";

export const HOTEL_FIXTURES = fileURLToPath(new URL("../../fixtures/hotels/", import.meta.url));

export function readFixture(name: string): string {
  return readFileSync(join(HOTEL_FIXTURES, name), "utf8");
}

/** The extractor's canned answer for the unstructured page. */
export function cannedExtraction(): { hotels: ExtractedHotel[] } {
  const { hotels } = JSON.parse(readFixture("google-hotels-extraction.json")) as { hotels: ExtractedHotel[] };
  return { hotels };
}

export interface HotelsServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Local stand-in for Google Hotels.
 *   /results       the results fixture built from the live DOM (consent dialog, 3 pages behind "Next")
 *   /unstructured  the same hotels without the card structure (forces the LLM path)
 *   /blocked       the unusual-traffic interstitial
 *   /empty         a destination with no results
 *   /stalled       a page where results never arrive
 *   /status/N      a bare HTTP status
 */
export async function startHotelsServer(): Promise<HotelsServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    if (path === "/results") html(readFixture("google-hotels-results.html"));
    else if (path === "/unstructured") html(readFixture("google-hotels-unstructured.html"));
    else if (path === "/blocked") html(readFixture("google-hotels-blocked.html"));
    else if (path === "/empty") html(readFixture("google-hotels-empty.html"));
    else if (path === "/stalled") html(readFixture("google-hotels-stalled.html"));
    else if (/^\/status\/\d+$/.test(path)) html("<title>status</title>", Number(path.split("/")[2]));
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

/** The query the fixtures were recorded for: Paris, 2026-11-20 to 2026-11-23, 2 adults, USD. */
export const PARIS: NormalizedHotelsQuery = {
  destination: "Paris",
  check_in: "2026-11-20",
  check_out: "2026-11-23",
  nights: 3,
  guests: { adults: 2, children: 0 },
  sort: "relevance",
  sources: ["google_hotels"],
  currency: "USD",
  max_results: 40,
};

export interface ScriptedLlm extends LlmClient {
  calls: LlmRequest[];
}

/** An LlmClient whose answer is computed from the request. Records every request. */
export function scriptedLlm(respond: (req: LlmRequest) => unknown): ScriptedLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      return {
        parsed: respond(req),
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.01,
        model: "claude-sonnet-5-5",
        stopReason: "end_turn",
      };
    },
  };
}

/** An LlmClient that fails the test when called: proves the deterministic path made no model call. */
export function forbiddenLlm(): ScriptedLlm {
  return scriptedLlm(() => {
    throw new Error("the LLM must not be called on the deterministic path");
  });
}

/** The user message text of a request. */
export function promptOf(req: LlmRequest): string {
  const m = req.messages[0];
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
}
