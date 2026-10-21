import { describe, expect, it, vi } from "vitest";
import { RateLimitedMarketError } from "../../../src/core/markets/http.js";
import { createMarketService, MARKET_CAVEAT, MARKET_TTL_MS, MarketQuoteError, type MarketServiceDeps } from "../../../src/core/markets/index.js";
import { MarketProviderError, type MarketProvider } from "../../../src/core/markets/types.js";
import type { MarketSource, SymbolMatch } from "../../../src/schemas/markets.js";
import { fakeProvider, makeLogger, memoryCache, quoteFor, signal, type FakeProvider } from "./helpers.js";

const fail = (source: MarketSource, code: MarketProviderError["code"], retryable = false, message = `${source} ${code}`): FakeProvider =>
  fakeProvider(source, async () => {
    throw new MarketProviderError(message, { provider: source, code, retryable });
  });
const ok = (source: MarketSource, configured = true): FakeProvider => fakeProvider(source, async (symbol) => quoteFor(source, symbol), { configured });
const rateLimited = (source: MarketSource): FakeProvider =>
  fakeProvider(source, async () => {
    throw new RateLimitedMarketError(`${source} returned HTTP 429`, source, 30_000);
  });

function service(providers: MarketProvider[], over: Partial<MarketServiceDeps> = {}) {
  return createMarketService({ providers, log: makeLogger(), ...over });
}
const req = (symbols: string[], extra: Partial<Parameters<ReturnType<typeof service>["quote"]>[0]> = {}) => ({ symbols, currency: "USD", ...extra });

describe("market service: routing", () => {
  it("crypto goes to CoinGecko first, as BASE-CUR, and falls through to Yahoo on a retryable failure", async () => {
    const cg = fail("coingecko", "provider", true);
    const yahoo = ok("yahoo");
    const out = await service([yahoo, cg, ok("finnhub"), ok("google_finance")]).quote(req(["BTC"]), signal());
    expect(cg.quote).toHaveBeenCalledWith("BTC-USD", expect.objectContaining({ currency: "USD" }), expect.anything(), expect.anything());
    expect(yahoo.quote).toHaveBeenCalledWith("BTC-USD", expect.anything(), expect.anything(), expect.anything());
    expect(out.quotes[0]).toMatchObject({ requested: "BTC", source: "yahoo" });
    expect(out.sources_used).toEqual(["yahoo"]);
    expect(out.sources_failed).toEqual([{ source: "coingecko", error: "coingecko provider" }]);
    expect(out.caveats[0]).toBe(MARKET_CAVEAT);
  });

  it("a crypto pair keeps its own quote currency and the default currency applies otherwise", async () => {
    const cg = ok("coingecko");
    await service([cg]).quote(req(["ETH-EUR", "eth"], { currency: "GBP" }), signal());
    const symbols = cg.quote.mock.calls.map((c) => c[0]).sort();
    expect(symbols).toEqual(["ETH-EUR", "ETH-GBP"]);
  });

  it("equities go Yahoo, then Finnhub, then Google Finance; a Yahoo 429 hands the symbol on", async () => {
    const yahoo = rateLimited("yahoo");
    const finnhub = fail("finnhub", "not_found");
    const google = ok("google_finance");
    const out = await service([yahoo, finnhub, ok("coingecko"), google]).quote(req(["AAPL"]), signal());
    expect(yahoo.quote.mock.calls[0]?.[0]).toBe("AAPL");
    expect(finnhub.quote).toHaveBeenCalledTimes(1);
    expect(google.quote).toHaveBeenCalledTimes(1);
    expect(out.quotes[0]?.source).toBe("google_finance");
    // The 429 is recorded; the not_found is not a failure of the source.
    expect(out.sources_failed).toEqual([{ source: "yahoo", error: "yahoo returned HTTP 429" }]);
    expect(out.sources_used).toEqual(["google_finance"]);
  });

  it("not_found from every source leaves the input unresolved with the last error and the tool still succeeds when another input quoted", async () => {
    const out = await service([fail("yahoo", "not_found"), ok("coingecko")]).quote(req(["ZZZQ", "BTC"]), signal());
    expect(out.quotes.map((q) => q.requested)).toEqual(["BTC"]);
    expect(out.unresolved).toEqual([{ requested: "ZZZQ", error: "yahoo: yahoo not_found" }]);
    expect(out.sources_failed).toEqual([]);
  });

  it("restricts to requested sources and reports an unconfigured requested source", async () => {
    const yahoo = ok("yahoo");
    const finnhub = ok("finnhub", false);
    const google = ok("google_finance");
    const out = await service([yahoo, finnhub, google]).quote(req(["AAPL"], { sources: ["finnhub", "google_finance"] }), signal());
    expect(yahoo.quote).not.toHaveBeenCalled();
    expect(finnhub.quote).not.toHaveBeenCalled();
    expect(out.quotes[0]?.source).toBe("google_finance");
    expect(out.sources_failed).toEqual([{ source: "finnhub", error: "not configured: set FINNHUB_API_KEY" }]);
  });

  it("unconfigured providers are skipped", async () => {
    const google = ok("google_finance", false);
    const yahoo = fail("yahoo", "provider");
    const err = await service([yahoo, google]).quote(req(["AAPL"]), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketQuoteError);
    expect(google.quote).not.toHaveBeenCalled();
  });
});

describe("market service: name lookup", () => {
  const matches: SymbolMatch[] = [
    { symbol: "AAPL", name: "Apple Inc.", asset_type: "stock", exchange: "NASDAQ", source: "yahoo" },
    { symbol: "APC.DE", name: "Apple Inc.", asset_type: "stock", exchange: "XETRA", source: "yahoo" },
    { symbol: "AAPL.MX", name: "Apple Inc.", asset_type: "stock", exchange: "Mexico", source: "yahoo" },
    { symbol: "AAPU", name: "Direxion Daily AAPL Bull 2X Shares", asset_type: "etf", exchange: "NYSEArca", source: "yahoo" },
    { symbol: "X", asset_type: "other", source: "yahoo" },
  ];

  it("quotes the first match and names up to three others in a caveat", async () => {
    const yahoo = fakeProvider("yahoo", async (s) => quoteFor("yahoo", s), { lookup: async () => matches });
    const out = await service([yahoo]).quote(req(["Apple"]), signal());
    expect(yahoo.lookup).toHaveBeenCalledWith("Apple", expect.anything());
    expect(yahoo.quote.mock.calls[0]?.[0]).toBe("AAPL");
    expect(out.quotes[0]).toMatchObject({ requested: "Apple", symbol: "AAPL" });
    expect(out.caveats).toContain(
      '"Apple" matched several symbols; quoting AAPL (Apple Inc., NASDAQ). Other matches: APC.DE (Apple Inc., XETRA); AAPL.MX (Apple Inc., Mexico); AAPU (Direxion Daily AAPL Bull 2X Shares, NYSEArca). Pass the ticker to pick one.',
    );
  });

  it("a ticker-shaped lower-case input with no lookup hit is tried as the upper-cased ticker", async () => {
    const yahoo = fakeProvider("yahoo", async (s) => quoteFor("yahoo", s), { lookup: async () => [] });
    const out = await service([yahoo]).quote(req(["aapl"]), signal());
    expect(yahoo.quote.mock.calls[0]?.[0]).toBe("AAPL");
    expect(out.quotes[0]?.requested).toBe("aapl");
  });

  it("a well-ranked exact CoinGecko name hit routes a name to crypto; a junk token does not", async () => {
    const coins = (rank: number | null) => [{ id: "fartcoin", symbol: "FARTCOIN", name: "Fartcoin", market_cap_rank: rank }];
    const mk = (rank: number | null) => {
      const cg = fakeProvider("coingecko", async (s) => quoteFor("coingecko", s), {
        lookup: async () => [{ symbol: "FARTCOIN", name: "Fartcoin", asset_type: "crypto", source: "coingecko" }],
      });
      (cg as unknown as { rankedSearch: unknown }).rankedSearch = vi.fn(async () => coins(rank));
      const yahoo = fakeProvider("yahoo", async (s) => quoteFor("yahoo", s), { lookup: async () => [{ symbol: "FRT", name: "Federal Realty", asset_type: "stock", source: "yahoo" }] });
      return { cg, yahoo };
    };
    const a = mk(50);
    const outA = await service([a.yahoo, a.cg]).quote(req(["Fartcoin"]), signal());
    expect(outA.quotes[0]?.source).toBe("coingecko");
    expect(a.cg.quote.mock.calls[0]?.[0]).toBe("FARTCOIN-USD");
    const b = mk(5000);
    const outB = await service([b.yahoo, b.cg]).quote(req(["Fartcoin"]), signal());
    expect(outB.quotes[0]?.source).toBe("yahoo");
    expect(b.yahoo.quote.mock.calls[0]?.[0]).toBe("FRT");
  });

  it("a known coin name needs no lookup at all and is routed as its ticker", async () => {
    const cg = fakeProvider("coingecko", async (s) => quoteFor("coingecko", s), { lookup: async () => [] });
    await service([cg]).quote(req(["bitcoin", "Bitcoin Cash", "ethereum"]), signal());
    expect(cg.lookup).not.toHaveBeenCalled();
    // Not "BITCOIN-USD": live, CoinGecko has an unrelated token whose ticker is BITCOIN, and Yahoo has no such pair.
    expect(cg.quote.mock.calls.map((c) => c[0])).toEqual(["BTC-USD", "BCH-USD", "ETH-USD"]);
  });

  it("a coin name falls back to Yahoo as the Yahoo pair", async () => {
    const cg = fakeProvider("coingecko", async () => {
      throw new MarketProviderError("coingecko returned HTTP 503", { provider: "coingecko", code: "provider", retryable: true });
    });
    const yahoo = fakeProvider("yahoo", async (s) => quoteFor("yahoo", s));
    const out = await service([cg, yahoo]).quote(req(["solana"]), signal());
    expect(yahoo.quote.mock.calls[0]?.[0]).toBe("SOL-USD");
    expect(out.quotes[0]?.source).toBe("yahoo");
  });

  it("a name no source can resolve is unresolved", async () => {
    const yahoo = fakeProvider("yahoo", async (s) => quoteFor("yahoo", s), { lookup: async () => [] });
    const err = (await service([yahoo]).quote(req(["Some Unknown Company"]), signal()).catch((e: unknown) => e)) as MarketQuoteError;
    expect(err.code).toBe("provider");
    expect(err.message).toContain("Some Unknown Company");
    expect(yahoo.quote).not.toHaveBeenCalled();
  });
});

describe("market service: caching with an injected clock", () => {
  function rig() {
    const clock = { now: Date.parse("2026-10-18T12:00:00Z") };
    const cache = memoryCache(clock);
    const yahoo = fakeProvider("yahoo", async (s, opts) => quoteFor("yahoo", s, opts.history ? { history: { range: opts.history.range, interval: "1d", bars: [] } } : {}), {
      lookup: async () => [{ symbol: "AAPL", asset_type: "stock", source: "yahoo" }],
    });
    const svc = service([yahoo], { cache, now: () => clock.now });
    return { clock, cache, yahoo, svc };
  }

  it("quotes are cached 60 s per source and symbol", async () => {
    const { clock, yahoo, svc } = rig();
    await svc.quote(req(["AAPL"]), signal());
    await svc.quote(req(["AAPL"]), signal());
    expect(yahoo.quote).toHaveBeenCalledTimes(1);
    clock.now += MARKET_TTL_MS.quote - 1;
    await svc.quote(req(["AAPL"]), signal());
    expect(yahoo.quote).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await svc.quote(req(["AAPL"]), signal());
    expect(yahoo.quote).toHaveBeenCalledTimes(2);
  });

  it("history is cached 10 min under its own key", async () => {
    const { clock, yahoo, svc } = rig();
    await svc.quote(req(["AAPL"]), signal());
    await svc.quote(req(["AAPL"], { history: { range: "1mo" } }), signal());
    expect(yahoo.quote).toHaveBeenCalledTimes(2);
    clock.now += MARKET_TTL_MS.quote + 1;
    await svc.quote(req(["AAPL"], { history: { range: "1mo" } }), signal());
    expect(yahoo.quote).toHaveBeenCalledTimes(2);
    clock.now += MARKET_TTL_MS.history - MARKET_TTL_MS.quote;
    await svc.quote(req(["AAPL"], { history: { range: "1mo" } }), signal());
    expect(yahoo.quote).toHaveBeenCalledTimes(3);
  });

  it("lookups are cached 24 h", async () => {
    const { clock, yahoo, svc } = rig();
    await svc.quote(req(["Apple"]), signal());
    clock.now += MARKET_TTL_MS.lookup - 1;
    await svc.quote(req(["Apple"]), signal());
    expect(yahoo.lookup).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await svc.quote(req(["Apple"]), signal());
    expect(yahoo.lookup).toHaveBeenCalledTimes(2);
  });

  it("cache keys are per source", async () => {
    const clock = { now: 0 };
    const cache = memoryCache(clock);
    const yahoo = ok("yahoo");
    const finnhub = ok("finnhub");
    await service([yahoo], { cache, now: () => clock.now }).quote(req(["AAPL"]), signal());
    await service([finnhub], { cache, now: () => clock.now }).quote(req(["AAPL"]), signal());
    expect(finnhub.quote).toHaveBeenCalledTimes(1);
  });
});

describe("market service: timeouts, concurrency and caveats", () => {
  it("a source that never answers times out per source and the next one answers", async () => {
    const stuck = fakeProvider("yahoo", () => new Promise(() => undefined));
    const finnhub = ok("finnhub");
    const out = await service([stuck, finnhub], { timeoutsMs: { yahoo: 30 } }).quote(req(["AAPL"]), signal());
    expect(out.quotes[0]?.source).toBe("finnhub");
    expect(out.sources_failed[0]).toMatchObject({ source: "yahoo", error: expect.stringMatching(/did not answer within/) });
  });

  it("runs at most 4 inputs at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const p = fakeProvider("yahoo", async (s) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return quoteFor("yahoo", s);
    });
    const out = await service([p]).quote(req(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]), signal());
    expect(out.quotes).toHaveLength(10);
    expect(peak).toBe(4);
    expect(out.quotes.map((q) => q.requested)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  });

  it("adds caveats for missing history, a changed interval, delays and provider hooks", async () => {
    const finnhub = fakeProvider("finnhub", async (s) => quoteFor("finnhub", s));
    const yahoo = fakeProvider("yahoo", async (s, opts, _sig, hooks) => {
      hooks?.caveats?.push("A note from the source.");
      return quoteFor("yahoo", s, { delayed_min: 15, history: { range: opts.history!.range, interval: "1wk", bars: [] } });
    });
    const out = await service([yahoo, finnhub]).quote(req(["AAPL"], { history: { range: "1y", interval: "1d" }, sources: ["yahoo"] }), signal());
    expect(out.caveats).toContain("yahoo returned AAPL history at interval 1wk, not the requested 1d.");
    expect(out.caveats).toContain("Equity quotes from yahoo are delayed by 15 minutes.");
    expect(out.caveats).toContain("A note from the source.");
    const out2 = await service([finnhub]).quote(req(["AAPL"], { history: { range: "1y" } }), signal());
    expect(out2.caveats).toContain("finnhub has no price history, so AAPL is quoted without history.");
  });

  it("redacts configured secrets from failure text", async () => {
    const p = fail("finnhub", "provider", false, "HTTP 500 for /quote?token=supersecret99");
    const out = await service([p, ok("google_finance")], { secrets: ["supersecret99"] }).quote(req(["AAPL"]), signal());
    expect(out.sources_failed[0]?.error).toBe("HTTP 500 for /quote?token=[redacted]");
  });
});

describe("market service: error codes when nothing is quoted", () => {
  const codeOf = async (providers: MarketProvider[], symbols = ["AAPL"]) => {
    const err = await service(providers).quote(req(symbols), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketQuoteError);
    return err as MarketQuoteError;
  };

  it("blocked wins", async () => {
    const e = await codeOf([fail("yahoo", "timeout", true), fail("google_finance", "blocked")]);
    expect(e.code).toBe("blocked");
    expect(e.retryable).toBe(false);
  });
  it("a code shared by every failure is kept", async () => {
    const e = await codeOf([fail("yahoo", "timeout", true), fail("finnhub", "timeout", true)]);
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
  });
  it("mixed codes are provider", async () => {
    const e = await codeOf([fail("yahoo", "timeout", true), fail("finnhub", "provider")]);
    expect(e.code).toBe("provider");
    expect(e.retryable).toBe(true);
    expect(e.details).toMatchObject({ sources_failed: [{ source: "yahoo" }, { source: "finnhub" }] });
  });
  it("only not_found everywhere is provider with the unresolved list", async () => {
    const e = await codeOf([fail("yahoo", "not_found")], ["ZZZQ"]);
    expect(e.code).toBe("provider");
    expect(e.message).toContain("ZZZQ");
    expect(e.details).toMatchObject({ unresolved: [{ requested: "ZZZQ" }] });
  });
  it("only config failures give config", async () => {
    const e = await codeOf([fail("finnhub", "config")]);
    expect(e.code).toBe("config");
  });
});
