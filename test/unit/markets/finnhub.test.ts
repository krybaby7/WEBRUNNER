import { describe, expect, it } from "vitest";
import { FinnhubProvider, finnhubAssetType } from "../../../src/core/markets/providers/finnhub.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import { MarketQuoteSchema } from "../../../src/schemas/markets.js";
import { BASE_OPTS, fakeFetch, jsonResponse, loadFixture, signal } from "./helpers.js";

const quote = loadFixture("finnhub-quote-aapl");
const unknown = loadFixture("finnhub-quote-unknown");
const search = loadFixture("finnhub-search-apple");
const KEY = "finnhub-test-token-123456";

describe("finnhub (fixtures from docs, unverified live: no key in the dev environment)", () => {
  it("isConfigured reflects the key and refuses without one", async () => {
    expect(new FinnhubProvider({ apiKey: KEY }).isConfigured()).toBe(true);
    expect(new FinnhubProvider().isConfigured()).toBe(false);
    expect(new FinnhubProvider({ apiKey: "  " }).isConfigured()).toBe(false);
    const f = fakeFetch(() => jsonResponse(quote));
    const err = await new FinnhubProvider({ fetchImpl: f.fetchImpl }).quote("AAPL", BASE_OPTS, signal()).catch((e: unknown) => e);
    expect((err as MarketProviderError).code).toBe("config");
    expect(f.calls).toHaveLength(0);
  });

  it("maps /quote to a USD stock quote without history and puts the token in the query string", async () => {
    const f = fakeFetch(() => jsonResponse(quote));
    const q = await new FinnhubProvider({ apiKey: KEY, fetchImpl: f.fetchImpl }).quote("aapl", { currency: "EUR", history: { range: "1mo" } }, signal());
    expect(MarketQuoteSchema.safeParse(q).success).toBe(true);
    expect(q).toEqual({
      requested: "aapl",
      symbol: "AAPL",
      asset_type: "stock",
      currency: "USD",
      price: 343.46,
      previous_close: 342,
      change: 1.46,
      change_pct: 0.4269,
      open: 346.08,
      day_high: 347.82,
      day_low: 340.46,
      as_of: "2026-10-16T20:00:01.000Z",
      source: "finnhub",
    });
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://finnhub.io/api/v1/quote");
    expect(url.searchParams.get("symbol")).toBe("aapl");
    expect(url.searchParams.get("token")).toBe(KEY);
  });

  it("an all-zero quote is not_found", async () => {
    const f = fakeFetch(() => jsonResponse(unknown));
    const err = await new FinnhubProvider({ apiKey: KEY, fetchImpl: f.fetchImpl }).quote("ZZZQ", BASE_OPTS, signal()).catch((e: unknown) => e);
    expect((err as MarketProviderError).code).toBe("not_found");
  });

  it("never leaks the token in error messages (HTTP error bodies echoing the URL, network errors)", async () => {
    const f1 = fakeFetch((call) => new Response(`bad request for ${call.url}`, { status: 400 }));
    const e1 = (await new FinnhubProvider({ apiKey: KEY, fetchImpl: f1.fetchImpl }).quote("AAPL", BASE_OPTS, signal()).catch((e: unknown) => e)) as Error;
    expect(e1.message).toContain("400");
    expect(e1.message).not.toContain(KEY);
    const f2 = fakeFetch((call) => Promise.reject(new TypeError(`fetch failed: ${call.url}`)));
    const e2 = (await new FinnhubProvider({ apiKey: KEY, fetchImpl: f2.fetchImpl }).quote("AAPL", BASE_OPTS, signal()).catch((e: unknown) => e)) as Error;
    expect(e2.message).not.toContain(KEY);
    const f3 = fakeFetch(() => jsonResponse({ error: "Invalid API key" }, 401));
    const e3 = (await new FinnhubProvider({ apiKey: KEY, fetchImpl: f3.fetchImpl }).quote("AAPL", BASE_OPTS, signal()).catch((e: unknown) => e)) as MarketProviderError;
    expect(e3.code).toBe("config");
    expect(e3.message).not.toContain(KEY);
  });

  it("maps /search to SymbolMatch[] with types", async () => {
    const f = fakeFetch(() => jsonResponse(search));
    const out = await new FinnhubProvider({ apiKey: KEY, fetchImpl: f.fetchImpl }).lookup("apple", signal());
    expect(out[0]).toEqual({ symbol: "AAPL", name: "APPLE INC", asset_type: "stock", source: "finnhub" });
    expect(out[2]?.asset_type).toBe("stock");
    expect(out[3]?.asset_type).toBe("etf");
    expect(new URL(f.calls[0]?.url ?? "").pathname).toBe("/api/v1/search");
    expect(finnhubAssetType("Index")).toBe("index");
    expect(finnhubAssetType("Mutual Fund")).toBe("fund");
    expect(finnhubAssetType("Warrant")).toBe("other");
  });
});
