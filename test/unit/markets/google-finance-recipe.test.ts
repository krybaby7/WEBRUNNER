import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGoogleFinanceUrl,
  candidateListings,
  cleanLine,
  createGoogleFinanceRecipe,
  GoogleFinanceNotFoundError,
  GoogleFinanceQuoteSchema,
  googleFinanceRecipe,
  LlmExtractionSchema,
  parseAsOf,
  parseCompact,
  parseMoney,
  parseQuoteText,
  parseStatusLine,
  toQuote,
  type GoogleFinanceQuote,
} from "../../../src/core/browser/recipes/google-finance.js";
import { RecipeError, type RecipeContext } from "../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { LlmError, type LlmClient } from "../../../src/core/llm/types.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../browser/helpers.js";
import { scriptedLlm } from "../flights/gf-helpers.js";
import { makeLogger, startMarketsServer, type MarketsServer } from "./helpers.js";

const probe = await probeChromium();
const NOW = Date.parse("2026-10-18T12:00:00Z");

/** The header lines of the live AAPL:NASDAQ page, as `innerText` split them on 2026-10-18. */
const AAPL_LINES = [
  "insights_auto", "Outlook:", "24.3% bullish", "·", "67.7% neutral", "·", "8.0% bearish", "Go to analysis", "chevron_right",
  "AAPL:NASDAQ", "check_indeterminate_small", "Add to list", "Apple Inc", "$343.46", "arrow_upward", "+0.43%", "(+1.46) Today",
  "Closed: Oct 16, 4:00:01 PM GMT-4  ·   USD", "$342.62", "arrow_downward", "-0.24%", "(-0.84)", "bedtime", "After hours  ·  7:59 PM",
  "area_chart", "Area", "1D", "5D", "Overview", "Open", "$346.08", "High", "$347.82", "Low", "$340.46", "Mkt. cap", "5.01T", "Avg. vol.", "40.30M",
  "Volume", "59.95M", "Dividend", "0.31%", "52-wk high", "$348.15", "52-wk low", "$243.42",
];
const VOD_LINES = [
  "VOD:LON", "check_indeterminate_small", "Add to list", "Vodafone Group plc", "GBX 120.79", "arrow_upward", "+0.49%", "(+0.59) Today",
  "Oct 16, 5:00:13 PM GMT+1  ·   GBX", "area_chart", "Open", "GBX 119.50", "High", "GBX 122.10", "Low", "GBX 119.40", "Mkt. cap", "37.57B",
  "Volume", "84.40M", "52-wk high", "GBX 132.07", "52-wk low", "GBX 85.06",
];

describe("google finance: listings and URLs (AAPL:NASDAQ and VOD:LON verified live 2026-10-18)", () => {
  it("builds the verified URL form", () => {
    expect(buildGoogleFinanceUrl({ symbol: "AAPL", exchange: "NASDAQ" })).toBe("https://www.google.com/finance/quote/AAPL:NASDAQ?hl=en");
    expect(googleFinanceRecipe.buildUrl?.({ symbol: "AAPL" })).toBe("https://www.google.com/finance/quote/AAPL:NASDAQ?hl=en");
    expect(buildGoogleFinanceUrl({ symbol: ".INX", exchange: "INDEXSP" }, "http://127.0.0.1:9/quote")).toBe("http://127.0.0.1:9/quote/.INX:INDEXSP?hl=en");
  });

  it.each([
    [{ symbol: "AAPL:NASDAQ" }, [["AAPL", "NASDAQ"]]],
    [{ symbol: "aapl", exchange: "nyse" }, [["AAPL", "NYSE"]]],
    [{ symbol: "VOD.L" }, [["VOD", "LON"]]],
    [{ symbol: "SAP.DE" }, [["SAP", "ETR"]]],
    [{ symbol: "0700.HK" }, [["0700", "HKG"]]],
    [{ symbol: "^GSPC" }, [[".INX", "INDEXSP"]]],
    [{ symbol: "^FTSE" }, [["UKX", "INDEXFTSE"]]],
    [{ symbol: "MSFT" }, [["MSFT", "NASDAQ"], ["MSFT", "NYSE"], ["MSFT", "NYSEARCA"]]],
    // Share classes, as checked live on 2026-10-21: a dot in the US and London, the hyphen kept in Stockholm and Copenhagen.
    [{ symbol: "BRK-B" }, [["BRK.B", "NASDAQ"], ["BRK.B", "NYSE"], ["BRK.B", "NYSEARCA"]]],
    [{ symbol: "BT-A.L" }, [["BT.A", "LON"]]],
    [{ symbol: "VOLV-B.ST" }, [["VOLV-B", "STO"]]],
    [{ symbol: "NOVO-B.CO" }, [["NOVO-B", "CPH"]]],
  ])("candidateListings(%j)", (params, expected) => {
    expect(candidateListings(params).map((l) => [l.symbol, l.exchange])).toEqual(expected);
  });

  it("index listings name the currency the page does not print", () => {
    expect(candidateListings({ symbol: "^GSPC" })[0]?.currency).toBe("USD");
    expect(candidateListings({ symbol: "^FTSE" })[0]?.currency).toBe("GBP");
    expect(candidateListings({ symbol: "^N225" })[0]?.currency).toBe("JPY");
    expect(candidateListings({ symbol: "AAPL" })[0]?.currency).toBeUndefined();
  });
});

describe("google finance: text parsing", () => {
  it("parseMoney reads signs, codes and plain numbers", () => {
    expect(parseMoney("$343.46")).toEqual({ amount: 343.46, currency: "USD" });
    expect(parseMoney("GBX 120.79")).toEqual({ amount: 120.79, currency: "GBX" });
    expect(parseMoney("€1,234.50")).toEqual({ amount: 1234.5, currency: "EUR" });
    expect(parseMoney("1,082.08")).toEqual({ amount: 1082.08 });
    expect(parseMoney("₹2,500.00")).toEqual({ amount: 2500, currency: "INR" });
    expect(parseMoney("+0.43%")).toBeUndefined();
    expect(parseMoney("Apple Inc")).toBeUndefined();
    // The live index page's name line: not an amount in a currency called "S&P".
    expect(parseMoney("S&P 500")).toBeUndefined();
    expect(parseMoney("R$ 58.03")).toEqual({ amount: 58.03, currency: "BRL" });
    expect(parseMoney("£12.10")).toEqual({ amount: 12.1, currency: "GBP" });
  });

  it("parseCompact expands K, M, B and T", () => {
    expect(parseCompact("5.01T")).toBe(5.01e12);
    expect(parseCompact("59.95M")).toBe(59_950_000);
    expect(parseCompact("166K")).toBe(166_000);
    expect(parseCompact("37.57B")).toBe(37.57e9);
    expect(parseCompact("1,234")).toBe(1234);
    expect(parseCompact("$1.2B")).toBe(1.2e9);
    expect(parseCompact("n/a")).toBeUndefined();
  });

  it("parseStatusLine reads state, time text and currency", () => {
    expect(parseStatusLine("Closed: Oct 16, 4:00:01 PM GMT-4  ·   USD")).toEqual({ market_state: "closed", currency: "USD", as_of_text: "Oct 16, 4:00:01 PM GMT-4" });
    expect(parseStatusLine("Oct 16, 5:00:13 PM GMT+1 · GBX")).toEqual({ currency: "GBX", as_of_text: "Oct 16, 5:00:13 PM GMT+1" });
    expect(parseStatusLine("Pre-market: Oct 19, 7:12 AM GMT-4 · USD")?.market_state).toBe("pre");
    expect(parseStatusLine("After hours: Oct 16, 7:59 PM GMT-4 · USD")?.market_state).toBe("post");
    expect(parseStatusLine("Open: Oct 19, 10:12 AM GMT-4 · USD")?.market_state).toBe("regular");
    expect(parseStatusLine("Add to list")).toBeUndefined();
    expect(parseStatusLine("After hours · 7:59 PM")).toBeUndefined();
    // Index pages print the time alone (live .INX:INDEXSP, 2026-10-21).
    expect(parseStatusLine("Oct 21, 1:40:21\u202fPM GMT-4")).toEqual({ as_of_text: "Oct 21, 1:40:21 PM GMT-4" });
    expect(parseStatusLine("Closed: Oct 21, 4:00:01 PM GMT-4")).toEqual({ market_state: "closed", as_of_text: "Oct 21, 4:00:01 PM GMT-4" });
    expect(parseStatusLine("S&P 500")).toBeUndefined();
    expect(parseStatusLine("7,766.42")).toBeUndefined();
  });

  it("parseAsOf converts the page time to UTC and infers the year", () => {
    expect(parseAsOf("Oct 16, 4:00:01 PM GMT-4", NOW)).toBe("2026-10-16T20:00:01.000Z");
    expect(parseAsOf("Oct 16, 5:00:13 PM GMT+1", NOW)).toBe("2026-10-16T16:00:13.000Z");
    expect(parseAsOf("Oct 16, 2025, 4:00 PM GMT-4", NOW)).toBe("2025-10-16T20:00:00.000Z");
    // A date later in the year than "now" belongs to the previous year.
    expect(parseAsOf("Dec 30, 4:00 PM GMT-4", NOW)).toBe("2025-12-30T20:00:00.000Z");
    expect(parseAsOf("Jan 5, 9:30 AM GMT+5:30", NOW)).toBe("2026-01-05T04:00:00.000Z");
    expect(parseAsOf("yesterday", NOW)).toBeUndefined();
    expect(cleanLine("a b  c")).toBe("a b c");
  });

  it("parseQuoteText reads the live AAPL header, stats and status", () => {
    const h = parseQuoteText(AAPL_LINES, NOW);
    expect(h).toMatchObject({
      symbol: "AAPL",
      exchange: "NASDAQ",
      name: "Apple Inc",
      currency: "USD",
      price: 343.46,
      change: 1.46,
      change_pct: 0.43,
      market_state: "closed",
      as_of: "2026-10-16T20:00:01.000Z",
      stats: { open: 346.08, day_high: 347.82, day_low: 340.46, market_cap: 5.01e12, volume: 59_950_000, week52_high: 348.15, week52_low: 243.42 },
    });
    expect(h?.delayed_min).toBeUndefined();
    const q = toQuote(h!, "https://x/AAPL:NASDAQ", "dom");
    expect(GoogleFinanceQuoteSchema.safeParse(q).success).toBe(true);
    expect(q?.previous_close).toBe(342);
    expect(q?.extracted_by).toBe("dom");
  });

  it("parseQuoteText reads the live VOD header (GBX, no status prefix) and a delayed note", () => {
    const h = parseQuoteText(VOD_LINES, NOW);
    expect(h).toMatchObject({ symbol: "VOD", exchange: "LON", name: "Vodafone Group plc", currency: "GBX", price: 120.79, change: 0.59, change_pct: 0.49, as_of: "2026-10-16T16:00:13.000Z" });
    expect(h?.market_state).toBeUndefined();
    expect(h?.stats).toEqual({ open: 119.5, day_high: 122.1, day_low: 119.4, market_cap: 37.57e9, volume: 84_400_000, week52_high: 132.07, week52_low: 85.06 });
    expect(parseQuoteText([...VOD_LINES, "Quotes delayed by 15 min"], NOW)?.delayed_min).toBe(15);
    expect(parseQuoteText(["Page Not Found", "We couldn't find any match for your search."], NOW)).toBeUndefined();
    expect(toQuote({ symbol: "X", exchange: "Y", stats: {} }, "u", "dom")).toBeUndefined();
  });
});

describe.skipIf(!probe.available)(`google-finance recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: MarketsServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startMarketsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  const failingLlm: LlmClient = {
    complete: () => Promise.reject(new LlmError("config", "not_configured", "no LLM in this test", { retryable: false })),
  };

  async function runRecipe(symbol: string, llm: LlmClient = failingLlm, over: Partial<RecipeContext> = {}, nowMs: number = NOW) {
    const recipe = createGoogleFinanceRecipe({ baseUrl: `${server.url}/quote`, pollMs: 50, maxWaitMs: 4000, now: () => nowMs });
    const log = makeLogger();
    const caveats: string[] = [];
    const page = await session.acquire();
    try {
      const ctx: RecipeContext = { llm, log, deadline: Date.now() + 20_000, caveats, ...over };
      const settled: { quote?: GoogleFinanceQuote; error?: unknown } = await recipe.run(page, { symbol }, ctx).then(
        (quote) => ({ quote }),
        (error: unknown) => ({ error }),
      );
      return { ...settled, caveats, log };
    } finally {
      await session.release(page);
    }
  }

  it("extracts price, change and currency from the sanitized live AAPL page without an LLM", async () => {
    const r = await runRecipe("AAPL:NASDAQ");
    expect(r.error).toBeUndefined();
    expect(r.quote).toMatchObject({
      symbol: "AAPL",
      exchange: "NASDAQ",
      name: "Apple Inc",
      currency: "USD",
      price: 343.46,
      change: 1.46,
      change_pct: 0.43,
      previous_close: 342,
      open: 346.08,
      day_high: 347.82,
      day_low: 340.46,
      volume: 59_950_000,
      market_cap: 5.01e12,
      week52_high: 348.15,
      week52_low: 243.42,
      market_state: "closed",
      as_of: "2026-10-16T20:00:01.000Z",
      extracted_by: "dom",
    });
    expect(r.quote?.url).toContain("/quote/AAPL:NASDAQ");
    expect(r.caveats).toEqual([]);
  }, 30_000);

  it("reads the London page in GBX and resolves a Yahoo-style suffix", async () => {
    const r = await runRecipe("VOD.L");
    expect(r.error).toBeUndefined();
    expect(r.quote).toMatchObject({ symbol: "VOD", exchange: "LON", currency: "GBX", price: 120.79, change: 0.59, change_pct: 0.49 });
    expect(r.quote?.market_state).toBeUndefined();
  }, 30_000);

  it("reads the live index page: no currency printed, so the listing's; the name is not a price", async () => {
    const r = await runRecipe("^GSPC", failingLlm, {}, Date.parse("2026-10-21T18:00:00Z"));
    expect(r.error).toBeUndefined();
    expect(r.quote).toMatchObject({
      symbol: ".INX", exchange: "INDEXSP", name: "S&P 500", currency: "USD", price: 7766.42, change: 53.85, change_pct: 0.7,
      open: 7736.43, day_high: 7768.25, day_low: 7709.34, as_of: "2026-10-21T17:55:07.000Z", extracted_by: "dom",
    });
  }, 30_000);

  it("resolves a Yahoo-style share class to Google's dotted form and reads the live page", async () => {
    server.hits.length = 0;
    const r = await runRecipe("BRK-B");
    expect(r.error).toBeUndefined();
    expect(server.hits).toEqual(["/quote/BRK.B:NASDAQ", "/quote/BRK.B:NYSE"]);
    expect(r.quote).toMatchObject({ symbol: "BRK.B", exchange: "NYSE", name: "Berkshire Hathaway Inc Class B", currency: "USD", price: 542.2, change: 1.73, change_pct: 0.32 });
  }, 30_000);

  it("tries NASDAQ then NYSE then NYSEARCA for a bare ticker and reports not found", async () => {
    server.hits.length = 0;
    const r = await runRecipe("ZZZQQQ");
    expect(r.error).toBeInstanceOf(GoogleFinanceNotFoundError);
    expect((r.error as RecipeError).code).toBe("provider");
    expect((r.error as RecipeError).retryable).toBe(false);
    expect(server.hits).toEqual(["/quote/ZZZQQQ:NASDAQ", "/quote/ZZZQQQ:NYSE", "/quote/ZZZQQQ:NYSEARCA"]);
  }, 30_000);

  it("maps the unusual-traffic interstitial to blocked", async () => {
    const r = await runRecipe("BLOCK:NASDAQ");
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("blocked");
  }, 30_000);

  it("falls back to schema-driven LLM extraction when the header has no readable price", async () => {
    const llm = scriptedLlm(() => ({
      symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc", currency: "USD", price: 343.46, change: 1.46, change_pct: 0.43,
      previous_close: null, open: 346.08, day_high: null, day_low: null, volume: 59950000, market_cap: null, week52_high: null, week52_low: null,
      market_state: "closed", delayed_min: null,
    }));
    const r = await runRecipe("NOPRICE:NASDAQ", llm);
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.role).toBe("extractor");
    expect(llm.calls[0]?.schema).toBe(LlmExtractionSchema);
    expect(String(llm.calls[0]?.messages[0]?.content)).toContain("Apple Inc");
    expect(r.quote).toMatchObject({ price: 343.46, currency: "USD", extracted_by: "llm", previous_close: 342 });
    expect(r.caveats.some((c) => /read by the LLM/.test(c))).toBe(true);
  }, 30_000);

  it("without an LLM the unreadable page fails with the LLM client's own error", async () => {
    const r = await runRecipe("NOPRICE:NASDAQ");
    expect(r.error).toBeInstanceOf(LlmError);
  }, 30_000);

  it("times out when no header appears", async () => {
    const r = await runRecipe("STALL:NASDAQ", failingLlm, { deadline: Date.now() + 2500 });
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toMatch(/timeout|provider/);
  }, 30_000);
});
