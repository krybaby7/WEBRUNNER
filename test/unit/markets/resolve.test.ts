import { describe, expect, it } from "vitest";
import {
  fallbackTicker,
  isPlausibleTicker,
  looksLikeCrypto,
  lookupCaveat,
  providerOrder,
  ROUTES,
  splitCryptoPair,
  symbolForSource,
} from "../../../src/core/markets/resolve.js";

describe("resolve: ticker versus name", () => {
  it.each(["AAPL", "VOD.L", "^GSPC", "BTC-USD", "BRK-B", "EURUSD=X", "0700.HK"])("%s is a plausible ticker", (s) => {
    expect(isPlausibleTicker(s)).toBe(true);
  });
  it.each(["Apple", "bitcoin cash", "Vodafone Group", "AVERYLONGSYMBOL", "a b", "aapl"])("%s is a name (looked up first)", (s) => {
    expect(isPlausibleTicker(s)).toBe(false);
  });
  it("offers the upper-cased ticker as a fallback for ticker-shaped names only", () => {
    expect(fallbackTicker("aapl")).toBe("AAPL");
    expect(fallbackTicker("Apple")).toBe("APPLE");
    expect(fallbackTicker("Vodafone Group")).toBeUndefined();
  });
});

describe("resolve: crypto detection", () => {
  it.each(["BTC", "btc", "ETH", "bitcoin", "Ethereum", "BTC-USD", "ETH-EUR", "sol", "dogecoin"])("%s looks like crypto", (s) => {
    expect(looksLikeCrypto(s)).toBe(true);
  });
  it.each(["AAPL", "Apple", "BRK-B", "VOD.L", "^GSPC", "GOLD-USD"])("%s does not", (s) => {
    expect(looksLikeCrypto(s)).toBe(false);
  });
  it("splits known-coin pairs only", () => {
    expect(splitCryptoPair("btc-usd")).toEqual({ base: "BTC", quote: "USD" });
    expect(splitCryptoPair("BRK-B")).toBeUndefined();
  });
});

describe("resolve: routing", () => {
  it("documents the routes", () => {
    expect(ROUTES).toEqual({ crypto: ["coingecko", "yahoo"], other: ["yahoo", "finnhub", "google_finance"] });
  });
  it.each([
    ["crypto", ["yahoo", "finnhub", "coingecko", "google_finance"], undefined, ["coingecko", "yahoo"]],
    ["other", ["yahoo", "finnhub", "coingecko", "google_finance"], undefined, ["yahoo", "finnhub", "google_finance"]],
    ["other", ["yahoo", "coingecko"], undefined, ["yahoo"]],
    ["other", ["yahoo", "finnhub", "google_finance"], ["google_finance", "finnhub"], ["finnhub", "google_finance"]],
    ["crypto", ["yahoo", "finnhub"], ["finnhub"], []],
  ] as const)("%s with configured %j and requested %j gives %j", (kind, configured, requested, expected) => {
    expect(providerOrder(kind, configured, requested === undefined ? undefined : [...requested])).toEqual(expected);
  });
  it("names crypto as BASE-CUR for every source and passes other symbols through", () => {
    expect(symbolForSource("yahoo", "BTC", "crypto", "usd")).toBe("BTC-USD");
    expect(symbolForSource("coingecko", "btc-eur", "crypto", "USD")).toBe("BTC-EUR");
    expect(symbolForSource("yahoo", "VOD.L", "other", "USD")).toBe("VOD.L");
  });
});

describe("resolve: lookup caveat", () => {
  it("names up to three other matches", () => {
    const m = (symbol: string, name?: string, exchange?: string) => ({ symbol, asset_type: "stock" as const, source: "yahoo" as const, ...(name && { name }), ...(exchange && { exchange }) });
    expect(lookupCaveat("apple", [m("AAPL")])).toBeUndefined();
    expect(lookupCaveat("apple", [m("AAPL", "Apple Inc.", "NASDAQ"), m("APC.DE", "Apple Inc.", "XETRA"), m("AAPL.MX", undefined, "Mexico"), m("AAPU", "Direxion"), m("X")])).toBe(
      '"apple" matched several symbols; quoting AAPL (Apple Inc., NASDAQ). Other matches: APC.DE (Apple Inc., XETRA); AAPL.MX (Mexico); AAPU (Direxion). Pass the ticker to pick one.',
    );
  });
});
