import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Logger } from "../../../src/log.js";
import type { Cache } from "../../../src/core/cache/index.js";
import type { MarketProvider, QuoteOptions } from "../../../src/core/markets/types.js";
import type { MarketQuote, MarketSource, SymbolMatch } from "../../../src/schemas/markets.js";

export { fakeFetch, jsonResponse, type FakeFetch, type RecordedCall } from "../search/helpers.js";

export function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/markets/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

export function readHtmlFixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/markets/${name}`, import.meta.url), "utf8");
}

export const signal = (): AbortSignal => new AbortController().signal;

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

export const BASE_OPTS: QuoteOptions = { currency: "USD" };

/** An in-memory cache with an injectable clock, so TTLs can be asserted. */
export function memoryCache(clock: { now: number }): Cache & { entries: Map<string, { value: unknown; expires: number }> } {
  const entries = new Map<string, { value: unknown; expires: number }>();
  return {
    entries,
    async get<T>(key: unknown): Promise<T | undefined> {
      const e = entries.get(JSON.stringify(key));
      if (e === undefined || clock.now >= e.expires) return undefined;
      return e.value as T;
    },
    async set<T>(key: unknown, value: T, ttlMs: number): Promise<void> {
      entries.set(JSON.stringify(key), { value, expires: clock.now + ttlMs });
    },
  };
}

export function quoteFor(source: MarketSource, symbol: string, over: Partial<MarketQuote> = {}): MarketQuote {
  return {
    requested: symbol,
    symbol,
    asset_type: source === "coingecko" ? "crypto" : "stock",
    currency: "USD",
    price: 100,
    as_of: "2026-10-16T20:00:01.000Z",
    source,
    ...over,
  };
}

export type FakeProvider = MarketProvider & { quote: ReturnType<typeof vi.fn>; lookup?: ReturnType<typeof vi.fn> };

/** A provider whose quote (and optional lookup) are vitest mocks. */
export function fakeProvider(
  name: MarketSource,
  quote: (symbol: string, opts: QuoteOptions, signal: AbortSignal, hooks?: { caveats?: string[] }) => Promise<MarketQuote>,
  options: { configured?: boolean; lookup?: (q: string, signal: AbortSignal) => Promise<SymbolMatch[]> } = {},
): FakeProvider {
  const p: FakeProvider = {
    name,
    assetTypes: name === "coingecko" ? ["crypto"] : ["stock", "etf", "index"],
    isConfigured: () => options.configured ?? true,
    quote: vi.fn(quote),
  };
  if (options.lookup !== undefined) p.lookup = vi.fn(options.lookup);
  return p;
}

// ---------------------------------------------------------------------------
// Local stand-in for Google Finance quote pages
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MarketsServer {
  /** Base URL without trailing slash; the recipe's `baseUrl` is `${url}/quote`. */
  url: string;
  hits: string[];
  close(): Promise<void>;
}

/**
 *   /quote/AAPL:NASDAQ   sanitized live page (USD, closed)
 *   /quote/VOD:LON       sanitized live page (GBX, no status prefix)
 *   /quote/NOPRICE:NASDAQ the AAPL page with the price line blanked (forces the LLM fallback)
 *   /quote/BLOCK:NASDAQ  the unusual-traffic interstitial
 *   /quote/STALL:NASDAQ  a page whose header never renders
 *   anything else        the live "Page Not Found" text
 */
export async function startMarketsServer(): Promise<MarketsServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    hits.push(path);
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    if (path === "/quote/AAPL:NASDAQ") html(readHtmlFixture("google-finance-aapl.html"));
    else if (path === "/quote/VOD:LON") html(readHtmlFixture("google-finance-vod.html"));
    else if (path === "/quote/.INX:INDEXSP") html(readHtmlFixture("google-finance-inx-live.html"));
    else if (path === "/quote/BRK.B:NYSE") html(readHtmlFixture("google-finance-brkb-live.html"));
    else if (path === "/quote/NOPRICE:NASDAQ") html(readHtmlFixture("google-finance-aapl.html").replace(">$343.46<", ">—<"));
    else if (path === "/quote/BLOCK:NASDAQ") html(readHtmlFixture("google-finance-blocked.html"));
    else if (path === "/quote/STALL:NASDAQ") html("<!doctype html><title>Google Finance</title><body><p>Loading</p></body>");
    else if (path.startsWith("/quote/")) html(readHtmlFixture("google-finance-notfound.html"));
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
