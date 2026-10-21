import { describe, expect, it } from "vitest";
import {
  CoinGeckoProvider,
  coingeckoBarMinutes,
  COINGECKO_DAYS,
  nearestInterval,
  rankCoins,
  splitPair,
} from "../../../src/core/markets/providers/coingecko.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import { MarketQuoteSchema } from "../../../src/schemas/markets.js";
import { BASE_OPTS, fakeFetch, jsonResponse, loadFixture, signal, type RecordedCall } from "./helpers.js";

const search = loadFixture("coingecko-search-bitcoin");
const price = loadFixture("coingecko-price-bitcoin");
const ohlc = loadFixture("coingecko-ohlc-bitcoin-7d");

function respond(call: RecordedCall): Response {
  const url = new URL(call.url);
  if (url.pathname === "/api/v3/search") return jsonResponse(search);
  if (url.pathname === "/api/v3/simple/price") return jsonResponse(price);
  if (url.pathname.endsWith("/ohlc")) return jsonResponse(ohlc);
  return new Response("not found", { status: 404 });
}

describe("coingecko (fixtures recorded live 2026-10-18)", () => {
  it("quotes BTC without a lookup request and maps price, market cap, volume and 24 h change", async () => {
    const f = fakeFetch(respond);
    const q = await new CoinGeckoProvider({ fetchImpl: f.fetchImpl }).quote("BTC", BASE_OPTS, signal());
    expect(MarketQuoteSchema.safeParse(q).success).toBe(true);
    expect(q).toMatchObject({
      requested: "BTC",
      symbol: "BTC",
      asset_type: "crypto",
      currency: "USD",
      price: 81878,
      change_pct: 0.6068,
      market_cap: 1645653017614.5466,
      volume: 15841712569.912165,
      as_of: "2026-10-18T12:53:57.000Z",
      source: "coingecko",
    });
    expect(q.change).toBeCloseTo(493.9, 0);
    expect(q.market_state).toBeUndefined();
    expect(q.delayed_min).toBeUndefined();
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v3/simple/price");
    expect(url.searchParams.get("ids")).toBe("bitcoin");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
    for (const p of ["include_market_cap", "include_24hr_vol", "include_24hr_change", "include_last_updated_at"]) expect(url.searchParams.get(p)).toBe("true");
  });

  it("a BTC-EUR pair overrides the quote currency and a name goes through /search", async () => {
    const f = fakeFetch((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/api/v3/simple/price") return jsonResponse({ bitcoin: { eur: 70000, last_updated_at: 1792328037 } });
      return respond(call);
    });
    const p = new CoinGeckoProvider({ fetchImpl: f.fetchImpl });
    const q = await p.quote("BTC-EUR", BASE_OPTS, signal());
    expect(q.currency).toBe("EUR");
    expect(q.price).toBe(70000);
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("vs_currencies")).toBe("eur");

    const byName = await p.quote("bitcoin", { currency: "eur" }, signal());
    expect(byName.symbol).toBe("BTC");
    expect(byName.name).toBe("Bitcoin");
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v3/simple/price", "/api/v3/search", "/api/v3/simple/price"]);
  });

  it("unknown coins are not_found and a missing vs-currency price is invalid_input", async () => {
    const f = fakeFetch((call) => (new URL(call.url).pathname === "/api/v3/search" ? jsonResponse({ coins: [] }) : respond(call)));
    const e1 = await new CoinGeckoProvider({ fetchImpl: f.fetchImpl }).quote("NOPECOIN", BASE_OPTS, signal()).catch((e: unknown) => e);
    expect((e1 as MarketProviderError).code).toBe("not_found");
    const f2 = fakeFetch(() => jsonResponse({ bitcoin: {} }));
    const e2 = await new CoinGeckoProvider({ fetchImpl: f2.fetchImpl }).quote("BTC", { currency: "XXX" }, signal()).catch((e: unknown) => e);
    expect((e2 as MarketProviderError).code).toBe("invalid_input");
  });

  it("history maps OHLC rows, the range to days and the interval to the nearest supported value", async () => {
    const f = fakeFetch(respond);
    const q = await new CoinGeckoProvider({ fetchImpl: f.fetchImpl }).quote("BTC", { currency: "USD", history: { range: "5d" } }, signal());
    const ohlcUrl = new URL(f.calls[1]?.url ?? "");
    expect(ohlcUrl.pathname).toBe("/api/v3/coins/bitcoin/ohlc");
    expect(ohlcUrl.searchParams.get("days")).toBe("7");
    expect(ohlcUrl.searchParams.get("vs_currency")).toBe("usd");
    expect(q.history?.range).toBe("5d");
    expect(q.history?.interval).toBe("1h");
    expect(q.history?.bars).toHaveLength(12);
    expect(q.history?.bars[0]).toEqual({ t: "2026-10-11T16:00:00.000Z", o: 83094, h: 83818, l: 82957, c: 83783 });
  });

  it("table: ranges to days, days to bar minutes, minutes to the nearest interval", () => {
    expect(COINGECKO_DAYS).toEqual({ "1d": "1", "5d": "7", "1mo": "30", "3mo": "90", "6mo": "180", "1y": "365", "5y": "max", max: "max" });
    expect(coingeckoBarMinutes("1")).toBe(30);
    expect(coingeckoBarMinutes("7")).toBe(240);
    expect(coingeckoBarMinutes("90")).toBe(4 * 1440);
    expect(coingeckoBarMinutes("max")).toBe(4 * 1440);
    expect(nearestInterval(30)).toBe("15m");
    expect(nearestInterval(240)).toBe("1h");
    expect(nearestInterval(4 * 1440)).toBe("1wk");
  });

  it("lookup ranks exact matches (id, symbol, name) by market-cap rank, then the rest by rank", async () => {
    const coins = [
      { id: "a", symbol: "ZZZ", name: "Bitcoin Thing", market_cap_rank: 5 },
      { id: "bitcoin", symbol: "BTC", name: "Bitcoin", market_cap_rank: 1 },
      { id: "b", symbol: "BITCOIN", name: "Fake", market_cap_rank: null },
      { id: "c", symbol: "QQQ", name: "Other", market_cap_rank: 3 },
    ];
    // A ticker is not unique: the unranked "BITCOIN" token must not beat Bitcoin itself.
    expect(rankCoins(coins, "bitcoin").map((c) => c.id)).toEqual(["bitcoin", "b", "c", "a"]);
    const same = [
      { id: "x-name", symbol: "XN", name: "pepe", market_cap_rank: 7 },
      { id: "pepe", symbol: "P", name: "P", market_cap_rank: 7 },
      { id: "x-sym", symbol: "PEPE", name: "S", market_cap_rank: 7 },
    ];
    expect(rankCoins(same, "pepe").map((c) => c.id)).toEqual(["pepe", "x-sym", "x-name"]);
    const f = fakeFetch(respond);
    const out = await new CoinGeckoProvider({ fetchImpl: f.fetchImpl }).lookup("bitcoin", signal());
    expect(out[0]).toEqual({ symbol: "BTC", name: "Bitcoin", asset_type: "crypto", source: "coingecko" });
    expect(out).toHaveLength(6);
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("query")).toBe("bitcoin");
  });

  it("resolves BITCOIN to Bitcoin, not the unrelated token whose ticker is BITCOIN (live search, 2026-10-21)", async () => {
    const live = loadFixture("coingecko-search-BITCOIN-live");
    const f = fakeFetch((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/api/v3/search") return jsonResponse(live);
      if (url.pathname === "/api/v3/simple/price") return jsonResponse({ bitcoin: { usd: 84583, last_updated_at: 1792604370 } });
      return new Response("nope", { status: 404 });
    });
    const p = new CoinGeckoProvider({ fetchImpl: f.fetchImpl });
    expect(await p.resolveId("BITCOIN", signal())).toEqual({ id: "bitcoin", symbol: "BTC", name: "Bitcoin" });
    const q = await p.quote("BITCOIN-USD", BASE_OPTS, signal());
    expect(q).toMatchObject({ symbol: "BTC", name: "Bitcoin", price: 84583 });
  });

  it("splitPair and 429 handling", async () => {
    expect(splitPair("BTC-USD")).toEqual({ base: "BTC", quote: "USD" });
    expect(splitPair("eth-eur")).toEqual({ base: "eth", quote: "EUR" });
    expect(splitPair("BTC")).toEqual({ base: "BTC" });
    const f = fakeFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
    const err = (await new CoinGeckoProvider({ fetchImpl: f.fetchImpl }).quote("BTC", BASE_OPTS, signal()).catch((e: unknown) => e)) as MarketProviderError & { retryAfterMs?: number };
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });
});
