import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../src/config.js";
import { FlightProviderError, type FlightProvider } from "../../../src/core/flights/types.js";
import { LlmError, type LlmClient } from "../../../src/core/llm/types.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import {
  SearchFlightsOutputSchema,
  type FlightOffer,
  type FlightSource,
  type NormalizedFlightsQuery,
} from "../../../src/schemas/flights.js";
import { registerSearchFlightsTool, type SearchFlightsToolOptions } from "../../../src/tools/search_flights.js";
import { registerTools } from "../../../src/tools/index.js";
import { makeLogger, scriptedLlm } from "./gf-helpers.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const config = { currency: "USD" } as Config;

function offer(
  source: FlightSource,
  id: string,
  amount: number,
  extra: Partial<FlightOffer> & { flightNumber?: string } = {},
): FlightOffer {
  const { flightNumber, ...rest } = extra;
  return {
    id,
    source,
    price: { amount, currency: "USD" },
    total_duration_min: 500,
    stops: 0,
    slices: [
      {
        segments: [
          {
            airline: "BA",
            airline_name: "British Airways",
            ...(flightNumber !== undefined && { flight_number: flightNumber }),
            depart_airport: "LHR",
            depart_at: "2026-12-01T10:00:00",
            arrive_airport: "JFK",
            arrive_at: "2026-12-01T13:00:00",
            duration_min: 500,
          },
        ],
        layovers: [],
      },
    ],
    ...rest,
  };
}

type FakeProvider = FlightProvider & { search: ReturnType<typeof vi.fn> };

function provider(
  name: FlightSource,
  impl: (q: NormalizedFlightsQuery, signal: AbortSignal, hooks?: { caveats?: string[] }) => Promise<FlightOffer[]>,
  configured = true,
): FakeProvider {
  return { name, isConfigured: () => configured, search: vi.fn(impl) } as FakeProvider;
}

const fail = (source: FlightSource, code: FlightProviderError["code"], message = `${source} ${code}`, retryable = false) =>
  provider(source, async () => {
    throw new FlightProviderError(message, { provider: source, code, retryable });
  });

async function connect(
  providers: FlightProvider[],
  opts: { llm?: LlmClient; timeoutsMs?: SearchFlightsToolOptions["timeoutsMs"] } = {},
): Promise<Client> {
  const deps: Deps = { config, log: makeLogger(), ...(opts.llm !== undefined && { llm: opts.llm }) };
  const server = new McpServer({ name: "test", version: "0" });
  registerSearchFlightsTool(server, deps, {
    providers: () => providers,
    ...(opts.timeoutsMs !== undefined && { timeoutsMs: opts.timeoutsMs }),
  });
  const client = new Client({ name: "test-client", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const ARGS = { origin: "LHR", destination: "JFK", depart_date: "2026-12-01" };

async function call(client: Client, args: Record<string, unknown> = ARGS) {
  return client.callTool({ name: "search_flights", arguments: args });
}

function ok(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).not.toBe(true);
  return SearchFlightsOutputSchema.parse(result.structuredContent);
}

function err(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

describe("search_flights tool", () => {
  it("is registered with the other tools and describes itself", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerTools(server, { config, log: makeLogger() });
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    const tool = (await client.listTools()).tools.find((t) => t.name === "search_flights");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/Google Flights/);
    expect(tool?.description).toMatch(/Duffel/);
    expect(tool?.description).toMatch(/personal use/i);
    expect(tool?.description).toMatch(/quotes at fetch time/i);
    expect(tool?.outputSchema).toBeDefined();
  });

  it("merges two sources by price and reports what was used", async () => {
    const google = provider("google_flights", async () => [offer("google_flights", "g1", 300), offer("google_flights", "g2", 500)]);
    const duffel = provider("duffel", async () => [offer("duffel", "d1", 400, { flightNumber: "BA117" })]);
    const out = ok(await call(await connect([duffel, google])));
    expect(out.offers.map((o) => o.id)).toEqual(["g1", "d1", "g2"]);
    expect(out.sources_used).toEqual(["duffel", "google_flights"]);
    expect(out.sources_failed).toEqual([]);
    expect(out.query).toMatchObject({
      origin: "LHR",
      destination: "JFK",
      currency: "USD",
      cabin: "economy",
      passengers: { adults: 1, children: 0, infants: 0 },
      sources: ["duffel", "google_flights"],
    });
    expect(Date.parse(out.fetched_at)).not.toBeNaN();
    expect(out.caveats.at(-1)).toMatch(/quotes at fetch time/i);
    // Both sources were asked, and max_stops was not set: the caveat says the sources differ.
    expect(out.caveats.some((c) => /max_stops was not set/.test(c))).toBe(true);
    expect(duffel.search).toHaveBeenCalledTimes(1);
    expect(google.search).toHaveBeenCalledTimes(1);
  });

  it("runs the providers in parallel", async () => {
    let started = 0;
    const slow = (name: FlightSource) =>
      provider(name, async () => {
        started++;
        await new Promise((r) => setTimeout(r, 300));
        expect(started).toBe(2);
        return [offer(name, name, 100)];
      });
    const t0 = Date.now();
    ok(await call(await connect([slow("duffel"), slow("google_flights")])));
    expect(Date.now() - t0).toBeLessThan(560);
  });

  it("does not add the max_stops caveat when it is set or only one source answered", async () => {
    const g = provider("google_flights", async () => [offer("google_flights", "g", 1)]);
    const d = provider("duffel", async () => [offer("duffel", "d", 2)]);
    const set = ok(await call(await connect([g, d]), { ...ARGS, max_stops: 1 }));
    expect(set.caveats.some((c) => /max_stops was not set/.test(c))).toBe(false);
    const single = ok(await call(await connect([g, d]), { ...ARGS, sources: ["google_flights"] }));
    expect(single.caveats.some((c) => /max_stops was not set/.test(c))).toBe(false);
  });

  it("groups mixed currencies, requested currency first, and says so", async () => {
    const eur = (id: string, amount: number) => offer("duffel", id, amount, { price: { amount, currency: "EUR" } });
    const gbp = (id: string, amount: number) => offer("duffel", id, amount, { price: { amount, currency: "GBP" } });
    const d = provider("duffel", async () => [eur("e1", 90), gbp("p1", 80), eur("e2", 50), offer("duffel", "u2", 700), offer("duffel", "u1", 600)]);
    const out = ok(await call(await connect([d]), { ...ARGS, sources: ["duffel"] }));
    expect(out.offers.map((o) => `${o.price.currency}:${o.id}`)).toEqual(["USD:u1", "USD:u2", "EUR:e2", "EUR:e1", "GBP:p1"]);
    const caveat = out.caveats.find((c) => /more than one currency/.test(c));
    expect(caveat).toMatch(/EUR/);
    expect(caveat).toMatch(/GBP/);
    expect(caveat).toMatch(/No conversion/);
  });

  it("puts the requested non-default currency first", async () => {
    const d = provider("duffel", async () => [offer("duffel", "u", 10), offer("duffel", "e", 99, { price: { amount: 99, currency: "EUR" } })]);
    const out = ok(await call(await connect([d]), { ...ARGS, sources: ["duffel"], currency: "eur" }));
    expect(out.query.currency).toBe("EUR");
    expect(out.offers.map((o) => o.id)).toEqual(["e", "u"]);
  });

  it("adds no currency caveat when everything is in the requested currency", async () => {
    const d = provider("duffel", async () => [offer("duffel", "u", 10)]);
    const out = ok(await call(await connect([d]), { ...ARGS, sources: ["duffel"] }));
    expect(out.caveats.some((c) => /currency/.test(c))).toBe(false);
  });

  it("reports an unconfigured requested source in sources_failed and still answers from the other", async () => {
    const g = provider("google_flights", async () => [offer("google_flights", "g", 1)]);
    const d = provider("duffel", async () => [], false);
    const out = ok(await call(await connect([d, g]), { ...ARGS, sources: ["duffel", "google_flights"] }));
    expect(out.sources_used).toEqual(["google_flights"]);
    expect(out.sources_failed).toEqual([{ source: "duffel", error: expect.stringContaining("not configured") }]);
    expect(d.search).not.toHaveBeenCalled();
  });

  it("treats a source that is not offered at all as not configured", async () => {
    const d = provider("duffel", async () => [offer("duffel", "d", 5)]);
    const out = ok(await call(await connect([d]), { ...ARGS, sources: ["google_flights", "duffel"] }));
    expect(out.sources_failed).toEqual([{ source: "google_flights", error: expect.stringContaining("not configured") }]);
    expect(out.sources_used).toEqual(["duffel"]);
  });

  it("defaults to the configured sources only", async () => {
    const g = provider("google_flights", async () => [offer("google_flights", "g", 1)]);
    const d = provider("duffel", async () => [], false);
    const out = ok(await call(await connect([d, g])));
    expect(out.query.sources).toEqual(["google_flights"]);
    expect(out.sources_failed).toEqual([]);
  });

  it("answers config when nothing is configured and no source was requested", async () => {
    const e = err(await call(await connect([provider("duffel", async () => [], false)])));
    expect(e.code).toBe("config");
    expect(e.retryable).toBe(false);
  });

  it("answers config when the only requested source is not configured", async () => {
    const e = err(await call(await connect([provider("duffel", async () => [], false)]), { ...ARGS, sources: ["duffel"] }));
    expect(e.code).toBe("config");
    expect(e.message).toMatch(/not configured/);
  });

  it("keeps partial results when one source fails", async () => {
    const out = ok(await call(await connect([fail("duffel", "provider", "duffel exploded"), provider("google_flights", async () => [offer("google_flights", "g", 1)])])));
    expect(out.sources_failed).toEqual([{ source: "duffel", error: "duffel exploded" }]);
    expect(out.offers).toHaveLength(1);
  });

  it("returns an empty result, not an error, when a source finds nothing", async () => {
    const out = ok(await call(await connect([provider("google_flights", async () => [])])));
    expect(out.offers).toEqual([]);
    expect(out.sources_used).toEqual(["google_flights"]);
    expect(out.caveats.some((c) => /No offers were found/.test(c))).toBe(true);
  });

  describe("error mapping when every source fails", () => {
    it("blocked beats timeout and provider", async () => {
      const e = err(await call(await connect([fail("google_flights", "blocked", "bot wall"), fail("duffel", "timeout")])));
      expect(e.code).toBe("blocked");
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/bot wall/);
      expect(e.details).toMatchObject({ sources_failed: expect.arrayContaining([{ source: "google_flights", error: "bot wall" }]) });
      const e2 = err(await call(await connect([fail("google_flights", "blocked"), fail("duffel", "provider")])));
      expect(e2.code).toBe("blocked");
    });

    it("timeout when all timed out, with the retryable flag", async () => {
      const e = err(await call(await connect([fail("google_flights", "timeout", "slow", true), fail("duffel", "timeout", "slow", true)])));
      expect(e.code).toBe("timeout");
      expect(e.retryable).toBe(true);
    });

    it("provider when the failures differ without a block", async () => {
      const e = err(await call(await connect([fail("google_flights", "timeout"), fail("duffel", "provider")])));
      expect(e.code).toBe("provider");
    });

    it("a real failure decides the code over an unconfigured source", async () => {
      const e = err(
        await call(await connect([fail("google_flights", "blocked"), provider("duffel", async () => [], false)]), {
          ...ARGS,
          sources: ["google_flights", "duffel"],
        }),
      );
      expect(e.code).toBe("blocked");
      expect((e.details as { sources_failed: unknown[] }).sources_failed).toHaveLength(2);
    });

    it("passes an LlmError through by its code", async () => {
      const g = provider("google_flights", async () => {
        throw new LlmError("budget_exceeded", "api", "cost cap reached", { retryable: false });
      });
      expect(err(await call(await connect([g]))).code).toBe("budget_exceeded");
      const g2 = provider("google_flights", async () => {
        throw new LlmError("config", "not_configured", "ANTHROPIC_API_KEY is not set", { retryable: false });
      });
      const e = err(await call(await connect([g2])));
      expect(e.code).toBe("config");
      expect(e.message).toMatch(/ANTHROPIC_API_KEY/);
    });

    it("maps an unexpected throw to provider", async () => {
      const g = provider("google_flights", async () => {
        throw new TypeError("kaput");
      });
      expect(err(await call(await connect([g]))).code).toBe("provider");
    });
  });

  it("times a source out even when it ignores its signal", async () => {
    const hang = provider("google_flights", () => new Promise(() => {}));
    const e = err(await call(await connect([hang], { timeoutsMs: { google_flights: 150 } })));
    expect(e.code).toBe("timeout");
    expect(e.message).toMatch(/google_flights/);
    const signal = hang.search.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it("keeps the fast source's offers when the slow one times out", async () => {
    const hang = provider("google_flights", () => new Promise(() => {}));
    const fast = provider("duffel", async () => [offer("duffel", "d", 5)]);
    const out = ok(await call(await connect([hang, fast], { timeoutsMs: { google_flights: 100 } })));
    expect(out.offers).toHaveLength(1);
    expect(out.sources_failed).toEqual([{ source: "google_flights", error: expect.stringContaining("did not answer") }]);
  });

  describe("input", () => {
    it("resolves city names through the table", async () => {
      const g = provider("google_flights", async (q) => {
        expect(q.origin).toBe("LON");
        expect(q.destination).toBe("NYC");
        return [];
      });
      ok(await call(await connect([g]), { ...ARGS, origin: "London", destination: "new york" }));
      expect(g.search).toHaveBeenCalledTimes(1);
    });

    it("asks the model for a place the table does not know, once per place", async () => {
      const llm = scriptedLlm(() => ({ iata: "TLL", confidence: "high" }));
      const g = provider("google_flights", async (q) => {
        expect(q.destination).toBe("TLL");
        return [];
      });
      ok(await call(await connect([g], { llm }), { ...ARGS, destination: "the capital of Estonia" }));
      expect(llm.calls).toHaveLength(1);
    });

    it("answers invalid_input for a place nobody can resolve, without running any provider", async () => {
      const llm = scriptedLlm(() => ({ iata: null, confidence: "low", note: "not a place" }));
      const g = provider("google_flights", async () => []);
      const e = err(await call(await connect([g], { llm }), { ...ARGS, origin: "Atlantis" }));
      expect(e.code).toBe("invalid_input");
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/Atlantis/);
      expect(e.message).toMatch(/built-in airport table/);
      expect(g.search).not.toHaveBeenCalled();
    });

    it("answers invalid_input without a model too", async () => {
      const e = err(await call(await connect([provider("google_flights", async () => [])]), { ...ARGS, destination: "Atlantis" }));
      expect(e.code).toBe("invalid_input");
    });

    it("maps a model failure while resolving to its own code", async () => {
      const llm: LlmClient = {
        complete: vi.fn().mockRejectedValue(new LlmError("budget_exceeded", "api", "cap", { retryable: false })),
      };
      const e = err(await call(await connect([provider("google_flights", async () => [])], { llm }), { ...ARGS, origin: "Atlantis" }));
      expect(e.code).toBe("budget_exceeded");
    });

    it("hands providers the fully normalized query", async () => {
      const g = provider("google_flights", async (q) => {
        expect(q).toEqual({
          origin: "LHR",
          destination: "JFK",
          depart_date: "2026-12-01",
          return_date: "2026-12-08",
          passengers: { adults: 2, children: 1, infants: 0 },
          cabin: "business",
          max_stops: 1,
          sources: ["google_flights"],
          currency: "EUR",
        });
        return [];
      });
      ok(
        await call(await connect([g]), {
          ...ARGS,
          return_date: "2026-12-08",
          passengers: { adults: 2, children: 1 },
          cabin: "business",
          max_stops: 1,
          currency: "eur",
        }),
      );
      expect(g.search).toHaveBeenCalledTimes(1);
    });

    it("lets the SDK reject malformed input", async () => {
      const client = await connect([provider("google_flights", async () => [])]);
      const r = await call(client, { ...ARGS, depart_date: "tomorrow" });
      expect(r.isError).toBe(true);
    });
  });

  describe("Google Flights specifics", () => {
    const outbound = (id: string, amount: number) =>
      offer("google_flights", id, amount, {
        itinerary: "outbound_only",
        fare_notes: ["flight numbers not shown by source"],
      });

    it("adds one caveat for outbound-only round trips and one for missing flight numbers", async () => {
      const g = provider("google_flights", async () => [outbound("a", 1), outbound("b", 2)]);
      const out = ok(await call(await connect([g]), { ...ARGS, return_date: "2026-12-08" }));
      expect(out.offers.every((o) => o.itinerary === "outbound_only")).toBe(true);
      expect(out.caveats.filter((c) => /outbound_only/.test(c))).toHaveLength(1);
      expect(out.caveats.filter((c) => /Flight numbers are not shown/.test(c))).toHaveLength(1);
    });

    it("does not add those caveats when offers are complete and numbered", async () => {
      const d = provider("duffel", async () => [offer("duffel", "d", 1, { flightNumber: "BA117" })]);
      const out = ok(await call(await connect([d]), { ...ARGS, sources: ["duffel"] }));
      expect(out.caveats.some((c) => /outbound_only|Flight numbers/.test(c))).toBe(false);
    });

    it("surfaces the provider's notes (consent, more flights, cabin) as caveats, once", async () => {
      const g = provider("google_flights", async (_q, _s, hooks) => {
        hooks?.caveats?.push("A cookie consent dialog was shown and dismissed (reject preferred) before reading results.");
        hooks?.caveats?.push('Google Flights has more itineraries behind its "more flights" button that were not expanded; cheaper or other options may exist.');
        hooks?.caveats?.push("Cabin class was not applied on Google Flights (wanted Business, page shows Economy); prices may be for another cabin.");
        return [offer("google_flights", "g", 1)];
      });
      const out = ok(await call(await connect([g])));
      expect(out.caveats.filter((c) => /cookie consent/.test(c))).toHaveLength(1);
      expect(out.caveats.some((c) => /more flights/.test(c))).toBe(true);
      expect(out.caveats.some((c) => /Cabin class was not applied/.test(c))).toBe(true);
    });
  });

  it("caps the merged list at 30 and says how many were left out", async () => {
    const many = (name: FlightSource) => provider(name, async () => Array.from({ length: 30 }, (_, i) => offer(name, `${name}${i}`, i + (name === "duffel" ? 0.5 : 0))));
    const out = ok(await call(await connect([many("duffel"), many("google_flights")])));
    expect(out.offers).toHaveLength(30);
    expect(out.offers[0]?.price.amount).toBe(0);
    expect(out.caveats.some((c) => /30 further offer/.test(c))).toBe(true);
  });
});
