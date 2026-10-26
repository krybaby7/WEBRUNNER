import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../src/config.js";
import { HotelProviderError, type HotelProvider, type HotelSearchHooks } from "../../../src/core/hotels/types.js";
import { DailyCostCap } from "../../../src/core/llm/daily-cap.js";
import { LlmError } from "../../../src/core/llm/types.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { SearchHotelsOutputSchema, type HotelResult, type NormalizedHotelsQuery } from "../../../src/schemas/hotels.js";
import { registerTools } from "../../../src/tools/index.js";
import { PRICE_DISCLAIMER, registerSearchHotelsTool, type SearchHotelsToolOptions } from "../../../src/tools/search_hotels.js";
import { makeLogger } from "./gh-helpers.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const config = { currency: "USD" } as Config;

function hotel(id: string, amount: number | undefined, extra: Partial<HotelResult> = {}): HotelResult {
  return {
    id: `google_hotels:${id}`,
    source: "google_hotels",
    name: `Hotel ${id}`,
    ...(amount !== undefined && { price_per_night: { amount, currency: "USD" } }),
    amenities: [],
    tags: [],
    availability: amount !== undefined ? "available" : "unknown",
    ...extra,
  };
}

type FakeProvider = HotelProvider & { search: ReturnType<typeof vi.fn> };

function provider(
  impl: (q: NormalizedHotelsQuery, signal: AbortSignal, hooks?: HotelSearchHooks) => Promise<HotelResult[]>,
  configured = true,
): FakeProvider {
  return { name: "google_hotels", isConfigured: () => configured, search: vi.fn(impl) } as FakeProvider;
}

const fail = (code: HotelProviderError["code"], message = `google_hotels ${code}`, retryable = false) =>
  provider(async () => {
    throw new HotelProviderError(message, { provider: "google_hotels", code, retryable });
  });

async function connect(
  providers: HotelProvider[],
  opts: { deps?: Partial<Deps>; timeoutsMs?: SearchHotelsToolOptions["timeoutsMs"]; wallClockMs?: number } = {},
): Promise<Client> {
  const deps: Deps = { config, log: makeLogger(), ...opts.deps };
  const server = new McpServer({ name: "test", version: "0" });
  registerSearchHotelsTool(server, deps, {
    providers: () => providers,
    ...(opts.timeoutsMs !== undefined && { timeoutsMs: opts.timeoutsMs }),
    ...(opts.wallClockMs !== undefined && { wallClockMs: opts.wallClockMs }),
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

const ARGS = { destination: "Paris", check_in: "2026-11-20", check_out: "2026-11-23" };

async function call(client: Client, args: Record<string, unknown> = ARGS) {
  return client.callTool({ name: "search_hotels", arguments: args });
}

function ok(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).not.toBe(true);
  return SearchHotelsOutputSchema.parse(result.structuredContent);
}

function err(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

describe("search_hotels tool", () => {
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
    const tool = (await client.listTools()).tools.find((t) => t.name === "search_hotels");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/Google Hotels/);
    expect(tool?.description).toMatch(/reads and extracts only/i);
    expect(tool?.description).toMatch(/never books/i);
    expect(tool?.description).toMatch(/against Google's terms of service/i);
    expect(tool?.description).toMatch(/personal, low-volume use/i);
    expect(tool?.description).toMatch(/120 seconds/);
    expect(tool?.description).toMatch(/timeout/);
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("hands the provider the normalized query, with the shared caveat sink, and echoes it", async () => {
    const g = provider(async (q, signal, hooks) => {
      expect(signal.aborted).toBe(false);
      expect(hooks?.caveats).toEqual([]);
      expect(q).toEqual({
        destination: "Paris",
        check_in: "2026-11-20",
        check_out: "2026-11-23",
        nights: 3,
        guests: { adults: 3, children: 1 },
        max_price_per_night: 200,
        min_rating: 4,
        star_classes: [3, 4],
        sort: "price",
        sources: ["google_hotels"],
        currency: "EUR",
        max_results: 7,
      });
      return [];
    });
    const out = ok(
      await call(await connect([g]), {
        ...ARGS,
        guests: { adults: 3, children: 1 },
        max_price_per_night: 200,
        min_rating: 4,
        star_classes: [4, 3],
        sort: "price",
        currency: "eur",
        max_results: 7,
      }),
    );
    expect(g.search).toHaveBeenCalledTimes(1);
    expect(out.query.currency).toBe("EUR");
    expect(out.query.nights).toBe(3);
    expect(Date.parse(out.fetched_at)).not.toBeNaN();
  });

  it("returns the hotels in page order by default, with the price disclaimer last", async () => {
    const g = provider(async () => [hotel("a", 120), hotel("b", 80), hotel("c", 95)]);
    const out = ok(await call(await connect([g])));
    expect(out.hotels.map((h) => h.id)).toEqual(["google_hotels:a", "google_hotels:b", "google_hotels:c"]);
    expect(out.sources_used).toEqual(["google_hotels"]);
    expect(out.sources_failed).toEqual([]);
    expect(out.query.sort).toBe("relevance");
    expect(out.caveats.at(-1)).toBe(PRICE_DISCLAIMER);
    expect(out.caveats.at(-1)).toMatch(/quotes at fetch time/i);
    expect(out.caveats.at(-1)).toMatch(/taxes and fees/i);
  });

  describe("filters and sorts (PLAN.md 14.1)", () => {
    const rows = () => [
      hotel("a", 120, { rating: 4.2, star_class: 4 }),
      hotel("b", 80, { rating: 4.6, star_class: 3 }),
      hotel("c", undefined, { rating: 4.9, star_class: 5 }),
      hotel("d", 95),
      hotel("e", 95, { rating: 4.6, star_class: 4 }),
    ];

    it.each([
      ["price ascending, unpriced last", { sort: "price" }, ["b", "d", "e", "a", "c"]],
      ["rating descending, unrated last", { sort: "rating" }, ["c", "b", "e", "a", "d"]],
      ["max_price_per_night", { max_price_per_night: 100 }, ["b", "d", "e"]],
      ["min_rating", { min_rating: 4.5 }, ["b", "c", "e"]],
      ["star_classes", { star_classes: [4, 5] }, ["a", "c", "e"]],
      ["everything together", { max_price_per_night: 100, min_rating: 4.5, star_classes: [3, 4], sort: "price" }, ["b", "e"]],
    ])("%s", async (_name, args, expected) => {
      const out = ok(await call(await connect([provider(async () => rows())]), { ...ARGS, ...args }));
      expect(out.hotels.map((h) => h.id.split(":")[1])).toEqual(expected);
    });

    it("says what the filters hid and how the sort treats missing fields", async () => {
      const out = ok(await call(await connect([provider(async () => rows())]), { ...ARGS, max_price_per_night: 100, sort: "price" }));
      expect(out.caveats.some((c) => /2 hotel\(s\) were hidden by the filters \(max_price_per_night 100 USD\)/.test(c))).toBe(true);
      expect(out.caveats.some((c) => /without a price are last/.test(c))).toBe(false); // none left without a price
      const rated = ok(await call(await connect([provider(async () => rows())]), { ...ARGS, sort: "rating" }));
      expect(rated.caveats.some((c) => /without a rating are last/.test(c))).toBe(true);
      expect(rated.caveats.some((c) => /1 hotel\(s\) showed no price/.test(c))).toBe(true);
    });

    it("caps at max_results and says how many were left out", async () => {
      const many = provider(async () => Array.from({ length: 30 }, (_, i) => hotel(`h${i}`, 100 - i)));
      const out = ok(await call(await connect([many]), { ...ARGS, max_results: 10, sort: "price" }));
      expect(out.hotels).toHaveLength(10);
      expect(out.hotels[0]?.price_per_night?.amount).toBe(71);
      expect(out.caveats.some((c) => /20 further hotel\(s\) were left out .*max_results \(10\)/.test(c))).toBe(true);
    });
  });

  describe("caveats", () => {
    it("explains per-night-only prices with the nights count, and printed totals", async () => {
      const g = provider(async () => [hotel("a", 100), hotel("b", 120, { total_price: { amount: 400, currency: "USD" } })]);
      const out = ok(await call(await connect([g])));
      expect(out.caveats.some((c) => /1 hotel\(s\) show a per-night price only; the stay total is 3 night\(s\) times the nightly rate, before taxes and fees/.test(c))).toBe(true);
      expect(out.caveats.some((c) => /total_price is the stay total as the page printed it/.test(c))).toBe(true);
    });

    it("flags prices in another currency and never converts", async () => {
      const g = provider(async () => [hotel("a", 100), hotel("b", 650, { price_per_night: { amount: 650, currency: "EUR" } })]);
      const out = ok(await call(await connect([g])));
      expect(out.caveats.some((c) => /not in the requested currency USD \(seen: USD, EUR\)/.test(c) && /no conversion/.test(c))).toBe(true);
      // With a price ceiling, the foreign-currency row cannot be compared and is hidden.
      const capped = ok(await call(await connect([g]), { ...ARGS, max_price_per_night: 1000 }));
      expect(capped.hotels.map((h) => h.id)).toEqual(["google_hotels:a"]);
      expect(capped.caveats.some((c) => /hidden by the filters/.test(c))).toBe(true);
    });

    it("surfaces the provider's notes once and says when nothing was found", async () => {
      const g = provider(async (_q, _s, hooks) => {
        hooks?.caveats?.push("A cookie consent dialog was shown and dismissed (reject preferred) before reading results.");
        hooks?.caveats?.push("A cookie consent dialog was shown and dismissed (reject preferred) before reading results.");
        hooks?.caveats?.push("Guest count was not applied on Google Hotels (wanted 4, page shows 2); prices may be for a different party size.");
        return [];
      });
      const out = ok(await call(await connect([g])));
      expect(out.hotels).toEqual([]);
      expect(out.caveats.filter((c) => /cookie consent/.test(c))).toHaveLength(1);
      expect(out.caveats.some((c) => /Guest count was not applied/.test(c))).toBe(true);
      expect(out.caveats.some((c) => /No hotels were found/.test(c))).toBe(true);
      expect(out.caveats.at(-1)).toBe(PRICE_DISCLAIMER);
    });

    it("passes the daily cost cap to the provider as the shared meter", async () => {
      let meter: unknown;
      const g = provider(async (_q, _s, hooks) => {
        meter = hooks?.meter;
        return [];
      });
      const dir = await mkdtemp(join(tmpdir(), "webrunner-hotels-cap-"));
      const dailyCap = new DailyCostCap({ capUsd: 5, dir, log: makeLogger() });
      ok(await call(await connect([g], { deps: { dailyCap } })));
      expect(meter).toBe(dailyCap);
    });
  });

  describe("errors", () => {
    it("answers invalid_input for input the schema rejects, without running any provider", async () => {
      const g = provider(async () => []);
      const r = await call(await connect([g]), { ...ARGS, check_out: "2026-11-19" });
      expect(r.isError).toBe(true);
      expect(g.search).not.toHaveBeenCalled();
      const e = err(await call(await connect([g]), { ...ARGS, check_out: "2026-11-19" }));
      expect(e.code).toBe("invalid_input");
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/check_out/);
      expect(err(await call(await connect([g]), { ...ARGS, check_out: "2027-01-20" })).message).toMatch(/30 nights/);
      // Field-level failures are rejected by the SDK's own input validation before the handler runs.
      expect((await call(await connect([g]), { ...ARGS, currency: "dollars" })).isError).toBe(true);
      expect((await call(await connect([g]), { ...ARGS, check_in: "tomorrow" })).isError).toBe(true);
      expect(g.search).not.toHaveBeenCalled();
    });

    it("answers config when no source is configured and none was requested, or the requested one is not", async () => {
      const e = err(await call(await connect([provider(async () => [], false)])));
      expect(e.code).toBe("config");
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/No hotel source is configured/);
      const e2 = err(await call(await connect([provider(async () => [], false)]), { ...ARGS, sources: ["google_hotels"] }));
      expect(e2.code).toBe("config");
      expect(e2.message).toMatch(/not configured/);
      expect(err(await call(await connect([]), { ...ARGS, sources: ["google_hotels"] })).code).toBe("config");
    });

    it.each([
      ["blocked", false],
      ["timeout", true],
      ["provider", true],
      ["config", false],
      ["invalid_input", false],
    ] as const)("maps a %s provider failure onto the envelope", async (code, retryable) => {
      const e = err(await call(await connect([fail(code, `the wall: ${code}`, retryable)])));
      expect(e.code).toBe(code);
      expect(e.retryable).toBe(retryable);
      expect(e.message).toMatch(new RegExp(`google_hotels: the wall: ${code}`));
      expect(e.details).toMatchObject({ sources_failed: [{ source: "google_hotels", error: `the wall: ${code}` }] });
    });

    it("passes an LlmError through by its code and maps an unexpected throw to provider", async () => {
      const budget = provider(async () => {
        throw new LlmError("budget_exceeded", "api", "cost cap reached", { retryable: false });
      });
      expect(err(await call(await connect([budget]))).code).toBe("budget_exceeded");
      const cfg = provider(async () => {
        throw new LlmError("config", "not_configured", "ANTHROPIC_API_KEY is not set", { retryable: false });
      });
      const e = err(await call(await connect([cfg])));
      expect(e.code).toBe("config");
      expect(e.message).toMatch(/ANTHROPIC_API_KEY/);
      const kaput = provider(async () => {
        throw new TypeError("kaput");
      });
      expect(err(await call(await connect([kaput]))).code).toBe("provider");
    });

    it("times the source out even when it ignores its signal", async () => {
      const hang = provider(() => new Promise(() => {}));
      const e = err(await call(await connect([hang], { timeoutsMs: { google_hotels: 150 } })));
      expect(e.code).toBe("timeout");
      expect(e.retryable).toBe(true);
      expect(e.message).toMatch(/google_hotels did not answer within/);
      const signal = hang.search.mock.calls[0]?.[1] as AbortSignal;
      expect(signal.aborted).toBe(true);
    });

    it("returns the wall-clock timeout envelope and cancels the source", async () => {
      let seen: AbortSignal | undefined;
      const hang = provider((_q, signal) => {
        seen = signal;
        return new Promise(() => {});
      });
      const e = err(await call(await connect([hang], { wallClockMs: 60, timeoutsMs: { google_hotels: 60_000 } })));
      expect(e).toMatchObject({ code: "timeout", retryable: true });
      expect(e.message).toMatch(/120 s|0 s limit/);
      expect(seen?.aborted).toBe(true);
    });

    it("answers internal when the provider factory throws, without leaking a stack", async () => {
      const deps: Deps = { config, log: makeLogger() };
      const server = new McpServer({ name: "test", version: "0" });
      registerSearchHotelsTool(server, deps, {
        providers: () => {
          const e = new Error("boom");
          e.stack = "Error: boom\n    at secretInternalFunction (/home/owner/webrunner/src/core/secret.ts:42:7)";
          throw e;
        },
      });
      const client = new Client({ name: "test-client", version: "0" });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      open.push(async () => {
        await client.close();
        await server.close();
      });
      const r = await call(client);
      const e = err(r);
      expect(e.code).toBe("internal");
      expect(e.message).toBe("search_hotels failed: boom");
      expect(JSON.stringify(r)).not.toContain("secretInternalFunction");
    });
  });
});
