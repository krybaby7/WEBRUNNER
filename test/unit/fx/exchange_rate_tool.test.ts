import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../../src/config.js";
import { FxError, type FxService } from "../../../src/core/fx/index.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { ExchangeRateOutputSchema, type ExchangeRateOutput } from "../../../src/schemas/fx.js";
import { registerExchangeRateTool, type ExchangeRateToolOptions } from "../../../src/tools/exchange_rate.js";
import { makeLogger } from "../markets/helpers.js";
import { callTool, connectServer, type Connected } from "../tools/helpers.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const OUTPUT: ExchangeRateOutput = {
  base: "USD",
  date: "2026-10-16",
  amount: 1,
  rates: [{ currency: "EUR", rate: 0.88865, converted: 0.88865 }],
  source: "frankfurter",
  fetched_at: "2026-10-18T12:00:00.000Z",
  caveats: ["ECB reference rates"],
};

async function connect(options: ExchangeRateToolOptions): Promise<Connected> {
  const deps: Deps = { config: { currency: "USD" } as Config, log: makeLogger() };
  const c = await connectServer((server) => registerExchangeRateTool(server, deps, options));
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

describe("exchange_rate tool", () => {
  it("describes itself with source, cap and annotations", async () => {
    const { client } = await connect({});
    const tool = (await client.listTools()).tools.find((t) => t.name === "exchange_rate");
    expect(tool?.description).toMatch(/Frankfurter/);
    expect(tool?.description).toMatch(/European Central Bank/);
    expect(tool?.description).toMatch(/no API key/);
    expect(tool?.description).toMatch(/20 seconds/);
    expect(tool?.description).toMatch(/1999-01-04/);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
  });

  it("upper-cases codes, defaults the amount and returns the conversion", async () => {
    let seen: unknown;
    const service: FxService = {
      convert: async (q) => {
        seen = q;
        return OUTPUT;
      },
      currencies: async () => ({}),
    };
    const { client } = await connect({ service: () => service });
    const result = await callTool(client, "exchange_rate", { from: " usd ", to: ["eur"] });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ from: "USD", to: ["EUR"], amount: 1 });
    expect(ExchangeRateOutputSchema.parse(result.structuredContent)).toEqual(OUTPUT);
  });

  it("returns invalid_input for bad arguments and for an unsupported currency, listing the supported ones", async () => {
    const service: FxService = {
      convert: () => Promise.reject(new FxError("invalid_input", "unsupported currency code XYZ; Frankfurter covers AUD, EUR, USD", { details: { supported: ["AUD", "EUR", "USD"] } })),
      currencies: async () => ({}),
    };
    const { client } = await connect({ service: () => service });
    expectInvalidInput(await callTool(client, "exchange_rate", { from: "USD" }));
    expectInvalidInput(await callTool(client, "exchange_rate", { from: "USD", to: ["EUR"], amount: 0 }));
    expectInvalidInput(await callTool(client, "exchange_rate", { from: "USD", to: ["EUR"], date: "2024-02-30" }));
    expectInvalidInput(await callTool(client, "exchange_rate", { from: "US", to: ["EUR"] }));
    const e = envelope(await callTool(client, "exchange_rate", { from: "USD", to: ["XYZ"] }));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toContain("AUD, EUR, USD");
    expect(e.details).toEqual({ supported: ["AUD", "EUR", "USD"] });
  });

  it("maps provider errors, the wall clock and unexpected failures", async () => {
    const { client } = await connect({ service: () => ({ convert: () => Promise.reject(new FxError("provider", "HTTP 503", { retryable: true })), currencies: async () => ({}) }) });
    expect(envelope(await callTool(client, "exchange_rate", { from: "USD", to: ["EUR"] }))).toMatchObject({ code: "provider", retryable: true });
    const { client: c2 } = await connect({ service: () => ({ convert: () => new Promise(() => undefined), currencies: async () => ({}) }), wallClockMs: 100 });
    expect(envelope(await callTool(c2, "exchange_rate", { from: "USD", to: ["EUR"] }))).toMatchObject({ code: "timeout", retryable: true });
    const { client: c3 } = await connect({ service: () => ({ convert: () => Promise.reject(new Error("boom\n at x")), currencies: async () => ({}) }) });
    const e = envelope(await callTool(c3, "exchange_rate", { from: "USD", to: ["EUR"] }));
    expect(e.code).toBe("internal");
    expect(e.message).toBe("exchange_rate failed: boom");
  });
});
