import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertAmount, createFxService, FX_CAVEAT, FX_TTL_MS, FxError, utcDateOf, type FxServiceDeps } from "../../../src/core/fx/index.js";
import { ExchangeRateOutputSchema } from "../../../src/schemas/fx.js";
import { makeLogger, memoryCache, signal } from "../markets/helpers.js";
import { fakeFetch, jsonResponse, type RecordedCall } from "../search/helpers.js";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/fx/${name}.json`, import.meta.url), "utf8"));
const latest = load("frankfurter-latest-usd");
const historical = load("frankfurter-2024-03-15-eur");
const currencies = load("frankfurter-currencies") as Record<string, string>;
const NOW = Date.parse("2026-10-18T12:00:00Z");

function respond(call: RecordedCall): Response {
  const path = new URL(call.url).pathname;
  if (path === "/v1/currencies") return jsonResponse(currencies);
  if (path === "/v1/latest") return jsonResponse(latest);
  if (/^\/v1\/\d{4}-\d{2}-\d{2}$/.test(path)) return jsonResponse(historical);
  return new Response("not found", { status: 404 });
}

function service(f = fakeFetch(respond), over: Partial<FxServiceDeps> = {}) {
  return { f, svc: createFxService({ log: makeLogger(), fetchImpl: f.fetchImpl, now: () => NOW, ...over }) };
}

describe("exchange rates (Frankfurter fixtures recorded live 2026-10-18)", () => {
  it("maps the latest rates, converts the amount and names the reference date", async () => {
    const { f, svc } = service();
    const out = await svc.convert({ from: "USD", to: ["EUR", "GBP"], amount: 100 }, signal());
    expect(ExchangeRateOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      base: "USD",
      date: "2026-10-16",
      amount: 100,
      rates: [
        { currency: "EUR", rate: 0.88865, converted: 88.865 },
        { currency: "GBP", rate: 0.74989, converted: 74.989 },
      ],
      source: "frankfurter",
      fetched_at: "2026-10-18T12:00:00.000Z",
      caveats: [FX_CAVEAT, "The latest ECB reference date is 2026-10-16."],
    });
    expect(f.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual(["/v1/currencies", "/v1/latest?base=USD&symbols=EUR,GBP"]);
  });

  it("historical rates use the dated endpoint and are cached 30 days", async () => {
    const clock = { now: NOW };
    const cache = memoryCache(clock);
    const { f, svc } = service(fakeFetch(respond), { cache, now: () => clock.now });
    const out = await svc.convert({ from: "EUR", to: ["USD", "JPY"], amount: 2.5, date: "2024-03-15" }, signal());
    expect(out.date).toBe("2024-03-15");
    expect(out.rates).toEqual([
      { currency: "USD", rate: 1.0892, converted: 2.723 },
      { currency: "JPY", rate: 162.03, converted: 405.075 },
    ]);
    expect(new URL(f.calls[1]?.url ?? "").pathname).toBe("/v1/2024-03-15");
    const dated = () => f.calls.filter((c) => new URL(c.url).pathname === "/v1/2024-03-15").length;
    clock.now += FX_TTL_MS.historical - 1;
    await svc.convert({ from: "EUR", to: ["JPY", "USD"], amount: 1, date: "2024-03-15" }, signal());
    expect(dated()).toBe(1);
    clock.now += 1;
    await svc.convert({ from: "EUR", to: ["USD", "JPY"], amount: 1, date: "2024-03-15" }, signal());
    expect(dated()).toBe(2);
  });

  it("a weekend date gets the previous working day and a caveat", async () => {
    const { svc } = service();
    const out = await svc.convert({ from: "EUR", to: ["USD"], amount: 1, date: "2024-03-16" }, signal());
    expect(out.date).toBe("2024-03-15");
    expect(out.caveats).toContain("2024-03-16 is not an ECB working day; the rates are for 2024-03-15, the previous working day.");
  });

  it("an unsupported code is invalid_input listing the supported codes", async () => {
    const { f, svc } = service();
    const err = (await svc.convert({ from: "USD", to: ["EUR", "XYZ", "BTC"], amount: 1 }, signal()).catch((e: unknown) => e)) as FxError;
    expect(err).toBeInstanceOf(FxError);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("XYZ, BTC");
    expect(err.message).toContain("AUD, BRL, CAD");
    expect(err.details).toEqual({ unsupported: ["XYZ", "BTC"], supported: Object.keys(currencies).sort() });
    expect(f.calls).toHaveLength(1);
  });

  it("from equal to a target is rate 1, with no request when it is the only target", async () => {
    const { f, svc } = service();
    const out = await svc.convert({ from: "USD", to: ["USD"], amount: 3 }, signal());
    expect(out.rates).toEqual([{ currency: "USD", rate: 1, converted: 3 }]);
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/currencies"]);
    const out2 = await svc.convert({ from: "USD", to: ["EUR", "USD", "EUR"], amount: 1 }, signal());
    expect(out2.rates.map((r) => r.currency)).toEqual(["EUR", "USD"]);
    expect(out2.caveats).toContain("USD to USD is reported with rate 1.");
  });

  it("rejects dates before 1999-01-04 and in the future", async () => {
    const { f, svc } = service();
    const early = (await svc.convert({ from: "USD", to: ["EUR"], amount: 1, date: "1998-12-31" }, signal()).catch((e: unknown) => e)) as FxError;
    expect(early.code).toBe("invalid_input");
    const future = (await svc.convert({ from: "USD", to: ["EUR"], amount: 1, date: "2026-10-19" }, signal()).catch((e: unknown) => e)) as FxError;
    expect(future.code).toBe("invalid_input");
    expect(f.calls).toHaveLength(0);
    expect(utcDateOf(NOW)).toBe("2026-10-18");
  });

  it("converted is rounded to 6 decimals", () => {
    expect(convertAmount(1 / 3, 3)).toBe(1);
    expect(convertAmount(123.456789, 0.88865)).toBe(109.709876);
    expect(convertAmount(1, 0.1234567891)).toBe(0.123457);
  });

  it("caches latest rates 1 hour and the currency list 7 days", async () => {
    const clock = { now: NOW };
    const cache = memoryCache(clock);
    const { f, svc } = service(fakeFetch(respond), { cache, now: () => clock.now });
    const paths = () => f.calls.map((c) => new URL(c.url).pathname);
    await svc.convert({ from: "USD", to: ["EUR", "GBP"], amount: 1 }, signal());
    await svc.convert({ from: "USD", to: ["GBP", "EUR"], amount: 5 }, signal());
    expect(paths()).toEqual(["/v1/currencies", "/v1/latest"]);
    clock.now += FX_TTL_MS.latest;
    await svc.convert({ from: "USD", to: ["EUR", "GBP"], amount: 1 }, signal());
    expect(paths()).toEqual(["/v1/currencies", "/v1/latest", "/v1/latest"]);
    clock.now += FX_TTL_MS.currencies - FX_TTL_MS.latest;
    await svc.convert({ from: "USD", to: ["EUR", "GBP"], amount: 1 }, signal());
    expect(paths().filter((p) => p === "/v1/currencies")).toHaveLength(2);
  });

  it("maps HTTP, network and abort failures", async () => {
    const f500 = fakeFetch((call) => (new URL(call.url).pathname === "/v1/latest" ? new Response("x", { status: 500 }) : respond(call)));
    const e1 = (await service(f500).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()).catch((e: unknown) => e)) as FxError;
    expect(e1).toMatchObject({ code: "provider", retryable: true });
    const fNet = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(((await service(fNet).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()).catch((e: unknown) => e)) as FxError).code).toBe("provider");
    const fHang = fakeFetch(() => new Promise<Response>(() => undefined));
    const e3 = (await service(fHang, { timeoutMs: 30 }).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()).catch((e: unknown) => e)) as FxError;
    expect(e3).toMatchObject({ code: "timeout", retryable: true });
    const fBad = fakeFetch((call) => (new URL(call.url).pathname === "/v1/latest" ? jsonResponse({ rates: "none" }) : respond(call)));
    expect(((await service(fBad).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()).catch((e: unknown) => e)) as FxError).code).toBe("provider");
  });
});
