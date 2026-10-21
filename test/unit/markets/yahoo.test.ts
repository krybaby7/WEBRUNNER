import { describe, expect, it } from "vitest";
import {
  YahooProvider,
  yahooAssetType,
  yahooBars,
  yahooCurrency,
  yahooMarketState,
  yahooPreviousClose,
  yahooStateFromPeriods,
} from "../../../src/core/markets/providers/yahoo.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import { MarketQuoteSchema } from "../../../src/schemas/markets.js";
import { BASE_OPTS, fakeFetch, jsonResponse, loadFixture, signal } from "./helpers.js";

const chart = loadFixture("yahoo-chart-aapl-1d");
const notFound = loadFixture("yahoo-chart-notfound");
const search = loadFixture("yahoo-search-apple");

describe("yahoo: chart mapping (fixture from docs; the live shape is tested below)", () => {
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

type ChartBody = { chart: { result: Array<{ meta: { regularMarketTime: number } & Record<string, unknown> }> } };
const live = (name: string): ChartBody => loadFixture(`yahoo-chart-${name}-live`) as ChartBody;

/** A provider over one recorded body, with the clock at that quote's own timestamp. */
function liveProvider(body: ChartBody) {
  const f = fakeFetch(() => jsonResponse(body));
  const at = (body.chart.result[0]?.meta.regularMarketTime ?? 0) * 1000;
  return { f, p: new YahooProvider({ fetchImpl: f.fetchImpl, now: () => at }) };
}

describe("yahoo: chart mapping against live responses (recorded 2026-10-21)", () => {
  it("AAPL 1d: previous close and change are Yahoo's own daily change; the state comes from the trading periods", async () => {
    const { p } = liveProvider(live("aapl-1d"));
    const q = await p.quote("AAPL", BASE_OPTS, signal());
    expect(MarketQuoteSchema.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({
      symbol: "AAPL", name: "Apple Inc.", asset_type: "stock", exchange: "NasdaqGS", currency: "USD",
      price: 344.17, previous_close: 339.5, change: 4.67, change_pct: 1.376, day_high: 345.22, day_low: 338.83,
      volume: 16901581, week52_high: 348.15, week52_low: 243.42, market_state: "regular", delayed_min: 15,
      as_of: "2026-10-21T17:39:30.000Z",
    });
    expect(q.open).toBeCloseTo(339.205, 3);
  });

  it("VOD.L 1mo: the daily change is not the month's change, pence are GBX with a caveat, the open is today's bar", async () => {
    const body = live("vod-1mo");
    // The trap: chartPreviousClose is the close before the month's first bar.
    expect(body.chart.result[0]?.meta["chartPreviousClose"]).toBe(127.9);
    const { p } = liveProvider(body);
    const caveats: string[] = [];
    const q = await p.quote("VOD.L", { currency: "USD", history: { range: "1mo" } }, signal(), { caveats });
    expect(q).toMatchObject({ symbol: "VOD.L", currency: "GBX", price: 118.6, previous_close: 119.4, change: -0.8, change_pct: -0.67, open: 119, market_state: "post" });
    expect(q.history?.bars).toHaveLength(23);
    expect(q.history?.interval).toBe("1d");
    expect(caveats).toEqual(["GBX is pence sterling (1/100 GBP): Yahoo quotes VOD.L in the minor unit."]);
  });

  it("^GSPC 1mo: an index, change exact from fulldayChange", async () => {
    const { p } = liveProvider(live("gspc-1mo"));
    const q = await p.quote("^GSPC", { currency: "USD", history: { range: "1mo" } }, signal());
    expect(q).toMatchObject({ symbol: "^GSPC", name: "S&P 500", asset_type: "index", currency: "USD", price: 7762.4, previous_close: 7712.57, change: 49.83, change_pct: 0.646 });
    expect(q.open).toBeCloseTo(7736.43, 2);
  });

  it("BTC-USD: crypto keeps Yahoo's rolling 24 h change, no delay, no market state", async () => {
    const { p } = liveProvider(live("btc-1d"));
    const q = await p.quote("BTC-USD", BASE_OPTS, signal());
    expect(q).toMatchObject({ asset_type: "crypto", currency: "USD", price: 84583.43, previous_close: 82734.6, change_pct: 2.235 });
    expect(q.delayed_min).toBeUndefined();
    expect(q.market_state).toBeUndefined();
  });

  it("an unknown symbol is the recorded 404 Not Found body", async () => {
    const f = fakeFetch(() => jsonResponse(loadFixture("yahoo-chart-notfound-live"), 404));
    const err = (await new YahooProvider({ fetchImpl: f.fetchImpl }).quote("ZZZZQQ", BASE_OPTS, signal()).catch((e: unknown) => e)) as MarketProviderError;
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("No data found, symbol may be delisted");
  });

  it("helpers: previous close precedence, minor-unit currencies, state from periods", () => {
    const m = { regularMarketPrice: 100, priceHint: 2 };
    expect(yahooPreviousClose({ ...m, previousClose: 98, regularMarketChangePercent: 5 }, "1mo")).toBe(98);
    expect(yahooPreviousClose({ ...m, fulldayPrice: 100, fulldayChange: 2, regularMarketChangePercent: 5 }, "1mo")).toBe(98);
    expect(yahooPreviousClose({ ...m, fulldayPrice: 101, fulldayChange: 3, regularMarketChangePercent: 2 }, "1mo")).toBe(98.04);
    expect(yahooPreviousClose({ ...m, chartPreviousClose: 90 }, "1mo")).toBeUndefined();
    expect(yahooPreviousClose({ ...m, chartPreviousClose: 99 }, "1d")).toBe(99);
    expect(yahooCurrency("GBp")).toBe("GBX");
    expect(yahooCurrency("ZAc")).toBe("ZAC");
    expect(yahooCurrency("usd")).toBe("USD");
    const periods = { pre: { start: 10, end: 20 }, regular: { start: 20, end: 30 }, post: { start: 30, end: 40 } };
    expect(yahooStateFromPeriods(periods, 15)).toBe("pre");
    expect(yahooStateFromPeriods(periods, 20)).toBe("regular");
    expect(yahooStateFromPeriods(periods, 35)).toBe("post");
    expect(yahooStateFromPeriods(periods, 45)).toBe("closed");
    expect(yahooStateFromPeriods(undefined, 15)).toBeUndefined();
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

  it("maps the live search response (recorded 2026-10-21): the equity first, futures and ETFs typed", async () => {
    const f = fakeFetch(() => jsonResponse(loadFixture("yahoo-search-nvidia-live")));
    const out = await new YahooProvider({ fetchImpl: f.fetchImpl }).lookup("Nvidia", signal());
    expect(out[0]).toEqual({ symbol: "NVDA", name: "NVIDIA Corporation", asset_type: "stock", exchange: "NASDAQ", source: "yahoo" });
    expect(out.map((m) => m.asset_type)).toEqual(["stock", "other", "other", "etf", "stock", "stock"]);
  });

  it("is always configured", () => {
    expect(new YahooProvider().isConfigured()).toBe(true);
  });
});
