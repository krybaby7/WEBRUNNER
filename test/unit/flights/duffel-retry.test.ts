import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DuffelProvider } from "../../../src/core/flights/providers/duffel.js";
import { FlightProviderError } from "../../../src/core/flights/types.js";
import type { NormalizedFlightsQuery } from "../../../src/schemas/flights.js";

const OFFERS = JSON.parse(
  readFileSync(new URL("../../fixtures/flights/duffel-offer-request-oneway.json", import.meta.url), "utf8"),
) as unknown;

const QUERY: NormalizedFlightsQuery = {
  origin: "LHR",
  destination: "JFK",
  depart_date: "2026-12-01",
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: "economy",
  sources: ["duffel"],
  currency: "GBP",
};

type Step = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that plays a script (the last step repeats) and counts calls. */
function scripted(...steps: Step[]): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if (step === undefined) throw new Error("no step scripted");
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? { errors: [{ message: "x" }] }), { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function make(fetchImpl: typeof fetch, waits: number[] = []): DuffelProvider {
  return new DuffelProvider({
    apiKey: "duffel_test_REDACTED",
    fetchImpl,
    retry: {
      random: () => 0,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  });
}

async function rejection(p: Promise<unknown>): Promise<FlightProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FlightProviderError);
    return err as FlightProviderError;
  }
  throw new Error("expected the search to reject");
}

const ok = { status: 200, body: OFFERS };

describe("DuffelProvider retries", () => {
  it.each([429, 500, 502, 503, 504])("retries HTTP %d and returns the recovered offers", async (status) => {
    const { fetchImpl, calls } = scripted({ status }, ok);
    const offers = await make(fetchImpl).search(QUERY, new AbortController().signal);
    expect(offers.length).toBeGreaterThan(0);
    expect(calls()).toBe(2);
  });

  it("retries a network error", async () => {
    const { fetchImpl, calls } = scripted(new TypeError("fetch failed"), ok);
    const offers = await make(fetchImpl).search(QUERY, new AbortController().signal);
    expect(offers.length).toBeGreaterThan(0);
    expect(calls()).toBe(2);
  });

  it("gives up after two retries and throws the last error", async () => {
    const { fetchImpl, calls } = scripted({ status: 503 });
    const err = await rejection(make(fetchImpl).search(QUERY, new AbortController().signal));
    expect(calls()).toBe(3);
    expect(err).toMatchObject({ code: "provider", retryable: true, status: 503 });
  });

  it.each([400, 401, 403, 422])("does not retry HTTP %d", async (status) => {
    const { fetchImpl, calls } = scripted({ status });
    const err = await rejection(make(fetchImpl).search(QUERY, new AbortController().signal));
    expect(calls()).toBe(1);
    expect(err.retryable).toBe(false);
  });

  it("does not retry a malformed 200 response", async () => {
    const { fetchImpl, calls } = scripted({ status: 200, body: { nope: true } });
    const err = await rejection(make(fetchImpl).search(QUERY, new AbortController().signal));
    expect(calls()).toBe(1);
    expect(err.retryable).toBe(false);
  });

  it("does not retry a timeout: the attempt already used its budget", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;
    const provider = new DuffelProvider({ apiKey: "k", fetchImpl, timeoutMs: 30, retry: { sleep: () => Promise.resolve() } });
    const err = await rejection(provider.search(QUERY, new AbortController().signal));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry once the caller's signal has aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    await rejection(make(fetchImpl).search(QUERY, controller.signal));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After on a 429", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = scripted({ status: 429, headers: { "retry-after": "1" } }, ok);
    await make(fetchImpl, waits).search(QUERY, new AbortController().signal);
    expect(calls()).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("does not wait out a Retry-After longer than the ceiling", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = scripted({ status: 429, headers: { "retry-after": "120" } });
    const err = await rejection(make(fetchImpl, waits).search(QUERY, new AbortController().signal));
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
    expect(err).toMatchObject({ retryable: true, status: 429 });
  });

  it("sends a fresh request each attempt with its own timeout signal", async () => {
    const { fetchImpl } = scripted({ status: 502 }, { status: 502 }, ok);
    await make(fetchImpl).search(QUERY, new AbortController().signal);
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const signals = mock.mock.calls.map((c) => (c[1] as RequestInit).signal);
    expect(new Set(signals).size).toBe(3);
  });
});
