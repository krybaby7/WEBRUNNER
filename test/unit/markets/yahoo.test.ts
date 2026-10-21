import { describe, expect, it } from "vitest";
import { YahooProvider, yahooAssetType, yahooBars, yahooMarketState } from "../../../src/core/markets/providers/yahoo.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import { MarketQuoteSchema } from "../../../src/schemas/markets.js";
import { BASE_OPTS, fakeFetch, jsonResponse, loadFixture, signal } from "./helpers.js";

const chart = loadFixture("yahoo-chart-aapl-1d");
const notFound = loadFixture("yahoo-chart-notfound");
const search = loadFixture("yahoo-search-apple");

describe("yahoo: chart mapping (fixture from docs, unverified live: HTTP 429 from the dev environment)", () => {
  it("maps meta to a quote with a 15 minute delay and derived change", async () => {
    const f = fakeFetch(() => jsonResponse(chart));
    const q = await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("AAPL", BASE_OPTS, signal());
    expect(MarketQuoteSchema.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({
      requested: "AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      asset_type: "stock",
      exchange: "NasdaqGS",
      currency: "USD",
      price: 343.46,
      previous_close: 342,
      change: 1.46,
      day_high: 347.82,
      day_low: 340.46,
      volume: 59950000,
      week52_high: 348.15,
      week52_low: 243.42,
      market_state: "closed",
      as_of: "2026-10-16T20:00:01.000Z",
      delayed_min: 15,
      source: "yahoo",
      open: 346.08,
    });
    expect(q.change_pct).toBeCloseTo(0.4269, 3);
    expect(q.history).toBeUndefined();
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://query1.finance.yahoo.com/v8/finance/chart/AAPL");
    expect(url.searchParams.get("range")).toBe("1d");
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(url.searchParams.get("includePrePost")).toBe("false");
    expect(f.calls[0]?.headers["user-agent"]).toMatch(/Mozilla/);
  });

  it("sends range and interval for history, defaults the interval and skips null bars", async () => {
    const f = fakeFetch(() => jsonResponse(chart));
    const q = await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("AAPL", { currency: "USD", history: { range: "1y" } }, signal());
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.searchParams.get("range")).toBe("1y");
    expect(url.searchParams.get("interval")).toBe("1wk");
    expect(q.history?.range).toBe("1y");
    expect(q.history?.interval).toBe("1wk");
    expect(q.history?.bars).toHaveLength(4);
    expect(q.history?.bars[0]).toEqual({ t: "2026-10-16T13:30:00.000Z", o: 346.08, h: 346.5, l: 345.7, c: 345.9, v: 1203400 });
    const times = q.history?.bars.map((b) => b.t) ?? [];
    expect(times).toEqual([...times].sort());
  });

  it("honours an explicit interval", async () => {
    const f = fakeFetch(() => jsonResponse(chart));
    await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("AAPL", { currency: "USD", history: { range: "5d", interval: "1h" } }, signal());
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("interval")).toBe("1h");
  });

  it("maps chart.error Not Found (HTTP 404) to not_found", async () => {
    const f = fakeFetch(() => jsonResponse(notFound, 404));
    const err = await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("ZZZQ", BASE_OPTS, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketProviderError);
    expect((err as MarketProviderError).code).toBe("not_found");
  });

  it("a 429 is a retryable provider error with retryAfterMs", async () => {
    const f = fakeFetch(() => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "30" } }));
    const err = (await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("AAPL", BASE_OPTS, signal()).catch((e: unknown) => e)) as MarketProviderError & {
      retryAfterMs?: number;
    };
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("crypto instruments get no delayed_min; other types map", async () => {
    const body = structuredClone(chart) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    body.chart.result[0]!.meta["instrumentType"] = "CRYPTOCURRENCY";
    body.chart.result[0]!.meta["symbol"] = "BTC-USD";
    const f = fakeFetch(() => jsonResponse(body));
    const q = await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("BTC-USD", BASE_OPTS, signal());
    expect(q.asset_type).toBe("crypto");
    expect(q.delayed_min).toBeUndefined();
    expect(yahooAssetType("ETF")).toBe("etf");
    expect(yahooAssetType("INDEX")).toBe("index");
    expect(yahooAssetType("MUTUALFUND")).toBe("fund");
    expect(yahooAssetType("CURRENCY")).toBe("other");
    expect(yahooMarketState("PRE")).toBe("pre");
    expect(yahooMarketState("POST")).toBe("post");
    expect(yahooMarketState("REGULAR")).toBe("regular");
    expect(yahooMarketState("PREPRE")).toBe("closed");
    expect(yahooMarketState(undefined)).toBeUndefined();
  });

  it("yahooBars caps at 1000 latest bars", () => {
    const n = 1200;
    const ts = Array.from({ length: n }, (_, i) => 1_700_000_000 + i * 60);
    const series = Array.from({ length: n }, (_, i) => i + 1);
    const bars = yahooBars(ts, { open: series, high: series, low: series, close: series });
    expect(bars).toHaveLength(1000);
    expect(bars[0]?.c).toBe(201);
  });
});

describe("yahoo: lookup", () => {
  it("maps the search fixture to SymbolMatch[] with exchDisp and types", async () => {
    const f = fakeFetch(() => jsonResponse(search));
    const out = await new YahooProvider({ fetchImpl: f.fetchImpl }).lookup("apple", signal());
    expect(out[0]).toEqual({ symbol: "AAPL", name: "Apple Inc.", asset_type: "stock", exchange: "NASDAQ", source: "yahoo" });
    expect(out[3]?.asset_type).toBe("etf");
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://query2.finance.yahoo.com/v1/finance/search");
    expect(url.searchParams.get("q")).toBe("apple");
    expect(url.searchParams.get("quotesCount")).toBe("6");
    expect(url.searchParams.get("newsCount")).toBe("0");
  });

  it("is always configured", () => {
    expect(new YahooProvider().isConfigured()).toBe(true);
  });
});
