import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/config.js";
import { MarketQuoteError, type MarketService } from "../../../src/core/markets/index.js";
import { MarketProviderError } from "../../../src/core/markets/types.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { MarketQuoteOutputSchema } from "../../../src/schemas/markets.js";
import { registerMarketQuoteTool, type MarketQuoteToolOptions } from "../../../src/tools/market_quote.js";
import { callTool, connectServer, type Connected } from "../tools/helpers.js";
import { fakeProvider, makeLogger, quoteFor } from "./helpers.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const config = { currency: "EUR" } as Config;

async function connect(options: MarketQuoteToolOptions): Promise<Connected> {
  const deps: Deps = { config, log: makeLogger() };
  const c = await connectServer((server) => registerMarketQuoteTool(server, deps, options));
  open.push(() => c.close());
  return c;
}


/** The MCP SDK rejects arguments that fail the input schema before the handler runs; the handler's own check covers the rest. */
function expectInvalidInput(result: Awaited<ReturnType<typeof callTool>>): void {
  expect(result.isError).toBe(true);
  if (result.structuredContent !== undefined) {
    expect(ErrorEnvelopeSchema.parse(result.structuredContent).error.code).toBe("invalid_input");
  } else {
    expect(result.content[0]?.text ?? "").toMatch(/invalid|validation/i);
  }
}

function envelope(result: Awaited<ReturnType<typeof callTool>>) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

describe("market_quote tool", () => {
  it("describes itself and declares read-only, idempotent, open-world", async () => {
    const { client } = await connect({ providers: () => [] });
    const tool = (await client.listTools()).tools.find((t) => t.name === "market_quote");
    expect(tool?.description).toMatch(/Yahoo Finance/);
    expect(tool?.description).toMatch(/FINNHUB_API_KEY/);
    expect(tool?.description).toMatch(/CoinGecko/);
    expect(tool?.description).toMatch(/Google Finance/);
    expect(tool?.description).toMatch(/30 seconds/);
    expect(tool?.description).toMatch(/15 minutes/);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
    expect(tool?.outputSchema).toBeDefined();
  });

  it("returns invalid_input for a bad request", async () => {
    const { client } = await connect({ providers: () => [fakeProvider("yahoo", async (s) => quoteFor("yahoo", s))] });
    expectInvalidInput(await callTool(client, "market_quote", { symbols: [] }));
    expectInvalidInput(await callTool(client, "market_quote", { symbols: ["AAPL"], currency: "euros" }));
    expectInvalidInput(await callTool(client, "market_quote", { symbols: ["AAPL"], history: { range: "2y" } }));
    expectInvalidInput(await callTool(client, "market_quote", {}));
  });

  it("returns config when nothing is configured, and when none of the requested sources is", async () => {
    const { client } = await connect({ providers: () => [fakeProvider("finnhub", async (s) => quoteFor("finnhub", s), { configured: false })] });
    const e1 = envelope(await callTool(client, "market_quote", { symbols: ["AAPL"] }));
    expect(e1.code).toBe("config");
    expect(e1.message).toMatch(/FINNHUB_API_KEY/);
    const { client: c2 } = await connect({ providers: () => [fakeProvider("yahoo", async (s) => quoteFor("yahoo", s))] });
    const e2 = envelope(await callTool(c2, "market_quote", { symbols: ["AAPL"], sources: ["finnhub"] }));
    expect(e2.code).toBe("config");
  });

  it("quotes through the real service with the config currency as the crypto default", async () => {
    const cg = fakeProvider("coingecko", async (s) => quoteFor("coingecko", s, { currency: "EUR" }));
    const { client } = await connect({ providers: () => [cg] });
    const result = await callTool(client, "market_quote", { symbols: ["BTC"] });
    expect(result.isError).toBeUndefined();
    const out = MarketQuoteOutputSchema.parse(result.structuredContent);
    expect(out.quotes[0]).toMatchObject({ requested: "BTC", source: "coingecko" });
    expect(cg.quote.mock.calls[0]?.[0]).toBe("BTC-EUR");
    expect(out.caveats).toContain("Quotes may be delayed; not investment advice.");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(out);
  });

  it("maps a MarketQuoteError to its envelope code", async () => {
    const blocked = fakeProvider("google_finance", async () => {
      throw new MarketProviderError("wall", { provider: "google_finance", code: "blocked", retryable: false });
    });
    const { client } = await connect({ providers: () => [blocked] });
    const e = envelope(await callTool(client, "market_quote", { symbols: ["AAPL"] }));
    expect(e.code).toBe("blocked");
    expect(e.retryable).toBe(false);
    expect(e.details).toMatchObject({ sources_failed: [{ source: "google_finance", error: "wall" }] });
  });

  it("returns the timeout envelope when the wall clock expires", async () => {
    const service: MarketService = { quote: () => new Promise(() => undefined) };
    const { client } = await connect({ providers: () => [fakeProvider("yahoo", async (s) => quoteFor("yahoo", s))], service: () => service, wallClockMs: 100 });
    const e = envelope(await callTool(client, "market_quote", { symbols: ["AAPL"] }));
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
  });

  it("returns internal for an unexpected failure and a service error of its own type passes through", async () => {
    const { client } = await connect({
      providers: () => [fakeProvider("yahoo", async (s) => quoteFor("yahoo", s))],
      service: () => ({ quote: () => Promise.reject(new Error("boom\n    at secret")) }),
    });
    const e = envelope(await callTool(client, "market_quote", { symbols: ["AAPL"] }));
    expect(e.code).toBe("internal");
    expect(e.message).toBe("market_quote failed: boom");
    const { client: c2 } = await connect({
      providers: () => [fakeProvider("yahoo", async (s) => quoteFor("yahoo", s))],
      service: () => ({ quote: () => Promise.reject(new MarketQuoteError("timeout", "all slow", true)) }),
    });
    expect(envelope(await callTool(c2, "market_quote", { symbols: ["AAPL"] })).code).toBe("timeout");
  });
});
