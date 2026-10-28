import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertAmount,
  createFxService,
  CURRENCY_API_CAVEAT,
  FX_CAVEAT,
  FX_TTL_MS,
  FxError,
  ISO_4217_CODES,
  utcDateOf,
  type FxServiceDeps,
} from "../../../src/core/fx/index.js";
import { ExchangeRateOutputSchema } from "../../../src/schemas/fx.js";
import { makeLogger, memoryCache, signal } from "../markets/helpers.js";
import { fakeFetch, jsonResponse, type RecordedCall } from "../search/helpers.js";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/fx/${name}.json`, import.meta.url), "utf8"));
const latest = load("frankfurter-latest-usd");
const historical = load("frankfurter-2024-03-15-eur");
const currencies = load("frankfurter-currencies") as Record<string, string>;
// currency-api, recorded live 2026-10-28 through jsDelivr.
const apiCurrencies = load("currency-api-currencies");
const apiLatestUsd = load("currency-api-latest-usd");
const api20260101Usd = load("currency-api-2026-01-01-usd");
const NOW = Date.parse("2026-10-18T12:00:00Z");
/** The day the currency-api latest fixture was recorded. */
const NOW_API = Date.parse("2026-10-28T15:00:00Z");

/** Which currency-api file a URL asks for, from either host; undefined for any other URL. */
function currencyApiFile(call: RecordedCall): { host: "jsdelivr" | "pages"; date: string; file: string } | undefined {
  const url = new URL(call.url);
  const cdn = /^\/npm\/@fawazahmed0\/currency-api@([^/]+)\/v1\/(.+)$/.exec(url.pathname);
  if (url.host === "cdn.jsdelivr.net" && cdn !== null) return { host: "jsdelivr", date: cdn[1] as string, file: cdn[2] as string };
  const pages = /^(.+)\.currency-api\.pages\.dev$/.exec(url.host);
  if (pages !== null && url.pathname.startsWith("/v1/")) return { host: "pages", date: pages[1] as string, file: url.pathname.slice(4) };
  return undefined;
}

function respondApi(call: RecordedCall): Response {
  const f = currencyApiFile(call);
  if (f?.date === "latest" && f.file === "currencies.json") return jsonResponse(apiCurrencies);
  if (f?.date === "latest" && f.file === "currencies/usd.json") return jsonResponse(apiLatestUsd);
  if (f?.date === "2026-01-01" && f.file === "currencies/usd.json") return jsonResponse(api20260101Usd);
  return new Response(`Couldn't find the requested release version ${f?.date ?? ""}.`, { status: 404 });
}

function respond(call: RecordedCall): Response {
  const url = new URL(call.url);
  if (url.host !== "api.frankfurter.dev") return respondApi(call);
  const path = url.pathname;
  if (path === "/v1/currencies") return jsonResponse(currencies);
  if (path === "/v1/latest") return jsonResponse(latest);
  if (/^\/v1\/\d{4}-\d{2}-\d{2}$/.test(path)) return jsonResponse(historical);
  return new Response("not found", { status: 404 });
}

const isFrankfurter = (call: RecordedCall): boolean => new URL(call.url).host === "api.frankfurter.dev";
const apiCalls = (calls: RecordedCall[]) => calls.map(currencyApiFile).filter((f) => f !== undefined);

function service(f = fakeFetch(respond), over: Partial<FxServiceDeps> = {}) {
  const log = makeLogger();
  return { f, log, svc: createFxService({ log, fetchImpl: f.fetchImpl, now: () => NOW, ...over }) };
}

const failure = (p: Promise<unknown>): Promise<FxError> => p.then(() => expect.fail("expected an FxError"), (e: unknown) => e as FxError);

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
    // A request the ECB covers never reaches currency-api.
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
    const early = await failure(svc.convert({ from: "USD", to: ["EUR"], amount: 1, date: "1998-12-31" }, signal()));
    expect(early.code).toBe("invalid_input");
    const future = await failure(svc.convert({ from: "USD", to: ["EUR"], amount: 1, date: "2026-10-19" }, signal()));
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

  it("maps HTTP, network and timeout failures when currency-api fails too", async () => {
    const down = (call: RecordedCall) => (isFrankfurter(call) ? respond(call) : new Response("busy", { status: 503 }));
    const f500 = fakeFetch((call) => (new URL(call.url).pathname === "/v1/latest" ? new Response("x", { status: 500 }) : down(call)));
    const e1 = await failure(service(f500).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()));
    expect(e1).toMatchObject({ code: "provider", retryable: true });
    expect(e1.message).toBe("frankfurter failed (frankfurter returned HTTP 500: x) and currency-api failed (currency-api returned HTTP 503: busy)");
    const fNet = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const e2 = await failure(service(fNet).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()));
    expect(e2.code).toBe("provider");
    expect(e2.message).toContain("frankfurter network error: fetch failed");
    const fHang = fakeFetch(() => new Promise<Response>(() => undefined));
    const e3 = await failure(service(fHang, { timeoutMs: 30 }).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()));
    expect(e3).toMatchObject({ code: "timeout", retryable: true });
    expect(fHang.calls.map((c) => new URL(c.url).host)).toEqual(["api.frankfurter.dev", "cdn.jsdelivr.net", "latest.currency-api.pages.dev"]);
    const fBad = fakeFetch((call) => (new URL(call.url).pathname === "/v1/latest" ? jsonResponse({ rates: "none" }) : down(call)));
    expect((await failure(service(fBad).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal()))).code).toBe("provider");
  });

  it("a caller that gives up gets no fallback", async () => {
    const { f, svc } = service();
    const gone = new AbortController();
    gone.abort();
    expect((await failure(svc.convert({ from: "USD", to: ["EGP"], amount: 1 }, gone.signal))).code).toBe("timeout");
    expect(f.calls.filter((c) => !isFrankfurter(c))).toHaveLength(0);
  });
});

describe("the currency-api backup (fixtures recorded live 2026-10-28)", () => {
  it("serves a currency the ECB lacks, saying why", async () => {
    const { f, svc } = service(fakeFetch(respond), { now: () => NOW_API });
    const out = await svc.convert({ from: "USD", to: ["EGP"], amount: 100 }, signal());
    expect(ExchangeRateOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      base: "USD",
      date: "2026-10-28",
      amount: 100,
      rates: [{ currency: "EGP", rate: 56.11961073, converted: 5611.961073 }],
      source: "currency-api",
      fetched_at: "2026-10-28T15:00:00.000Z",
      caveats: [CURRENCY_API_CAVEAT, "The ECB reference rates do not cover EGP, so these rates come from currency-api."],
    });
    expect(f.calls.filter(isFrankfurter).map((c) => new URL(c.url).pathname)).toEqual(["/v1/currencies"]);
    expect(f.calls.filter((c) => !isFrankfurter(c)).map((c) => c.url)).toEqual([
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies.json",
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    ]);
  });

  it("serves the whole request when any code is outside the ECB list", async () => {
    const { svc } = service(fakeFetch(respond), { now: () => NOW_API });
    const out = await svc.convert({ from: "USD", to: ["EUR", "EGP", "USD"], amount: 1 }, signal());
    expect(out.source).toBe("currency-api");
    expect(out.rates).toEqual([
      { currency: "EUR", rate: 0.89912268, converted: 0.899123 },
      { currency: "EGP", rate: 56.11961073, converted: 56.119611 },
      { currency: "USD", rate: 1, converted: 1 },
    ]);
    expect(out.caveats).toEqual([CURRENCY_API_CAVEAT, "The ECB reference rates do not cover EGP, so these rates come from currency-api.", "USD to USD is reported with rate 1."]);
  });

  it("serves a historical date from that day's file", async () => {
    const { f, svc } = service(fakeFetch(respond), { now: () => NOW_API });
    const out = await svc.convert({ from: "USD", to: ["EGP"], amount: 1, date: "2026-01-01" }, signal());
    expect(out).toMatchObject({ date: "2026-01-01", source: "currency-api", rates: [{ currency: "EGP", rate: 47.70320713, converted: 47.703207 }] });
    expect(apiCalls(f.calls).map((c) => c.date)).toEqual(["latest", "2026-01-01"]);
  });

  it("asks for latest when the date is today, and names an older latest file", async () => {
    const { f, svc } = service(fakeFetch(respond), { now: () => NOW_API });
    const today = await svc.convert({ from: "USD", to: ["EGP"], amount: 1, date: "2026-10-28" }, signal());
    expect(today.date).toBe("2026-10-28");
    expect(apiCalls(f.calls).map((c) => c.date)).toEqual(["latest", "latest"]);
    const nextDay = service(fakeFetch(respond), { now: () => NOW_API + 24 * 60 * 60_000 }).svc;
    const out = await nextDay.convert({ from: "USD", to: ["EGP"], amount: 1 }, signal());
    expect(out.caveats).toContain("The latest currency-api date is 2026-10-28.");
  });

  it("refuses crypto and unknown codes, naming market_quote for crypto", async () => {
    const { f, svc } = service(fakeFetch(respond), { now: () => NOW_API });
    const err = await failure(svc.convert({ from: "USD", to: ["EUR", "XYZ", "BTC"], amount: 1 }, signal()));
    expect(err.code).toBe("invalid_input");
    expect(err.message).toBe(
      "unsupported currency codes XYZ, BTC: not in the ECB reference rates (Frankfurter) or the current ISO 4217 currencies in currency-api. For crypto, use market_quote.",
    );
    const { unsupported, supported } = err.details as { unsupported: string[]; supported: string[] };
    expect(unsupported).toEqual(["XYZ", "BTC"]);
    expect(supported).toEqual([...supported].sort());
    expect(supported).toEqual(expect.arrayContaining([...Object.keys(currencies), "EGP", "NGN", "XAU"]));
    expect(supported).not.toContain("BTC");
    expect(supported.every((c) => ISO_4217_CODES.has(c) || c in currencies)).toBe(true);
    expect(apiCalls(f.calls).map((c) => c.file)).toEqual(["currencies.json"]);
  });

  it("refuses a currency the ECB lacks before currency-api's history starts, without asking it", async () => {
    const { f, svc } = service(fakeFetch(respond), { now: () => NOW_API });
    const err = await failure(svc.convert({ from: "USD", to: ["EGP"], amount: 1, date: "2023-06-01" }, signal()));
    expect(err.code).toBe("invalid_input");
    expect(err.message).toBe("the ECB reference rates do not cover EGP, and currency-api, which covers more currencies, has rates from 2024-03-02; got 2023-06-01");
    expect(apiCalls(f.calls)).toHaveLength(0);
  });

  it("stands in when Frankfurter fails, with the reason in the caveats", async () => {
    const f500 = fakeFetch((call) => (new URL(call.url).pathname === "/v1/latest" ? new Response("x", { status: 500 }) : respond(call)));
    const { svc, log } = service(f500, { now: () => NOW_API });
    const out = await svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal());
    expect(out).toMatchObject({ source: "currency-api", rates: [{ currency: "EUR", rate: 0.89912268 }] });
    expect(out.caveats).toEqual([CURRENCY_API_CAVEAT, "Frankfurter failed (frankfurter returned HTTP 500: x), so these rates come from currency-api."]);
    expect(log.warn).toHaveBeenCalledWith("exchange_rate is falling back to currency-api", { error: "frankfurter returned HTTP 500: x" });

    const hang = fakeFetch((call) => (isFrankfurter(call) ? new Promise<Response>(() => undefined) : respond(call)));
    const timedOut = await service(hang, { now: () => NOW_API, timeoutMs: 30 }).svc.convert({ from: "USD", to: ["EUR"], amount: 1 }, signal());
    expect(timedOut.source).toBe("currency-api");
    expect(timedOut.caveats[1]).toBe("Frankfurter failed (frankfurter did not answer in time (timed out or cancelled)), so these rates come from currency-api.");
  });

  it("keeps Frankfurter's error for a date before currency-api's history", async () => {
    const f500 = fakeFetch((call) => (/^\/v1\/\d{4}/.test(new URL(call.url).pathname) ? new Response("x", { status: 500 }) : respond(call)));
    const err = await failure(service(f500, { now: () => NOW_API }).svc.convert({ from: "EUR", to: ["USD"], amount: 1, date: "2020-05-05" }, signal()));
    expect(err).toMatchObject({ code: "provider", message: "frankfurter returned HTTP 500: x" });
    expect(apiCalls(f500.calls)).toHaveLength(0);
  });

  it("checks codes against currency-api alone when Frankfurter's list cannot be fetched", async () => {
    const fNet = fakeFetch((call) => (isFrankfurter(call) ? Promise.reject(new TypeError("fetch failed")) : respond(call)));
    const { svc } = service(fNet, { now: () => NOW_API });
    expect((await svc.convert({ from: "USD", to: ["GBP"], amount: 1 }, signal())).source).toBe("currency-api");
    const err = await failure(svc.convert({ from: "USD", to: ["XYZ"], amount: 1 }, signal()));
    expect(err.message).toBe(
      "unsupported currency code XYZ: not in the current ISO 4217 currencies in currency-api (Frankfurter's list could not be fetched). For crypto, use market_quote.",
    );
  });

  it("uses the Pages mirror when jsDelivr fails", async () => {
    const f = fakeFetch((call) => (currencyApiFile(call)?.host === "jsdelivr" && call.url.endsWith("/usd.json") ? new Response("down", { status: 503 }) : respond(call)));
    const out = await service(f, { now: () => NOW_API }).svc.convert({ from: "USD", to: ["EGP"], amount: 1 }, signal());
    expect(out.rates[0]?.rate).toBe(56.11961073);
    expect(apiCalls(f.calls).map((c) => `${c.host} ${c.date} ${c.file}`)).toEqual([
      "jsdelivr latest currencies.json",
      "jsdelivr latest currencies/usd.json",
      "pages latest currencies/usd.json",
    ]);
  });

  it("a dated file missing from both hosts is a provider error that is not retryable", async () => {
    const err = await failure(service(fakeFetch(respond), { now: () => NOW_API }).svc.convert({ from: "USD", to: ["EGP"], amount: 1, date: "2025-05-05" }, signal()));
    expect(err).toMatchObject({ code: "provider", retryable: false, message: "currency-api has no rates published for 2025-05-05" });
  });

  it("keeps one cached file per base and date, latest for 1 hour, with the ISO list for 7 days", async () => {
    const clock = { now: NOW_API };
    const cache = memoryCache(clock);
    const { f, svc } = service(fakeFetch(respond), { cache, now: () => clock.now });
    const files = () => apiCalls(f.calls).map((c) => c.file);
    await svc.convert({ from: "USD", to: ["EGP"], amount: 1 }, signal());
    const ngn = await svc.convert({ from: "USD", to: ["NGN", "EGP"], amount: 1 }, signal());
    expect(ngn.rates.map((r) => r.currency)).toEqual(["NGN", "EGP"]);
    expect(files()).toEqual(["currencies.json", "currencies/usd.json"]);
    clock.now += FX_TTL_MS.latest;
    await svc.convert({ from: "USD", to: ["EGP"], amount: 1 }, signal());
    expect(files()).toEqual(["currencies.json", "currencies/usd.json", "currencies/usd.json"]);
    clock.now += FX_TTL_MS.currencies - FX_TTL_MS.latest;
    await svc.convert({ from: "USD", to: ["EGP"], amount: 1 }, signal());
    expect(files().filter((x) => x === "currencies.json")).toHaveLength(2);
  });

  it("caches historical files 30 days", async () => {
    const clock = { now: NOW_API };
    const cache = memoryCache(clock);
    const { f, svc } = service(fakeFetch(respond), { cache, now: () => clock.now });
    const dated = () => apiCalls(f.calls).filter((c) => c.date === "2026-01-01").length;
    await svc.convert({ from: "USD", to: ["EGP"], amount: 1, date: "2026-01-01" }, signal());
    clock.now += FX_TTL_MS.historical - 1;
    await svc.convert({ from: "USD", to: ["EGP"], amount: 2, date: "2026-01-01" }, signal());
    expect(dated()).toBe(1);
    clock.now += 1;
    await svc.convert({ from: "USD", to: ["EGP"], amount: 1, date: "2026-01-01" }, signal());
    expect(dated()).toBe(2);
  });

  it("lists both sources' codes, preferring the ECB's names", async () => {
    const list = await service(fakeFetch(respond)).svc.currencies(signal());
    expect(list.EUR).toBe(currencies.EUR);
    expect(list.EGP).toBe("Egyptian Pound");
    expect(list.BTC).toBeUndefined();
  });
});
