import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_MS,
  DEFAULT_MAX_MS,
  MAX_RETRIES,
  jitterDelayMs,
  parseRetryAfter,
  retryAfterMsOf,
  withRetry,
  worstCaseMs,
} from "../../src/core/retry.js";

class Transient extends Error {
  constructor(
    message = "transient",
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const always = (): boolean => true;

/** A sleep that records the requested waits and returns at once. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe("withRetry", () => {
  it("returns the first success without waiting", async () => {
    const { sleep, waits } = recordingSleep();
    const fn = vi.fn(() => Promise.resolve("ok"));
    await expect(withRetry(fn, { isRetryable: always, sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("retries a retryable failure and passes the attempt number", async () => {
    const { sleep, waits } = recordingSleep();
    const fn = vi.fn((attempt: number) => (attempt < 2 ? Promise.reject(new Transient()) : Promise.resolve(`done after ${attempt}`)));
    await expect(withRetry(fn, { isRetryable: always, sleep })).resolves.toBe("done after 2");
    expect(fn.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(waits).toHaveLength(2);
  });

  it("never retries more than twice, even when asked for more", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.reject(new Transient("still down")));
    await expect(withRetry(fn, { isRetryable: always, retries: 10, sleep })).rejects.toThrow("still down");
    expect(fn).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(MAX_RETRIES).toBe(2);
  });

  it("honors a smaller retry count, including zero", async () => {
    const { sleep } = recordingSleep();
    const one = vi.fn(() => Promise.reject(new Transient()));
    await expect(withRetry(one, { isRetryable: always, retries: 1, sleep })).rejects.toThrow();
    expect(one).toHaveBeenCalledTimes(2);
    const none = vi.fn(() => Promise.reject(new Transient()));
    await expect(withRetry(none, { isRetryable: always, retries: 0, sleep })).rejects.toThrow();
    expect(none).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error the predicate rejects, and rethrows it unchanged", async () => {
    const { sleep, waits } = recordingSleep();
    const err = new Transient("bad request", 400);
    const fn = vi.fn(() => Promise.reject(err));
    await expect(withRetry(fn, { isRetryable: (e) => (e as Transient).status === 503, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("does not start another attempt once the signal has aborted", async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    const fn = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Transient("first failure"));
    });
    await expect(withRetry(fn, { isRetryable: always, signal: controller.signal, sleep })).rejects.toThrow("first failure");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops waiting and does not retry when the signal aborts during the wait", async () => {
    const controller = new AbortController();
    const fn = vi.fn(() => Promise.reject(new Transient("down")));
    // The real sleep: it must end as soon as the signal aborts.
    const started = Date.now();
    const result = withRetry(fn, { isRetryable: always, signal: controller.signal, baseMs: 10_000, maxMs: 10_000, random: () => 0.99 });
    setTimeout(() => controller.abort(), 20);
    await expect(result).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("makes the first attempt but no retry when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(() => Promise.reject(new Transient()));
    await expect(withRetry(fn, { isRetryable: always, signal: controller.signal })).rejects.toThrow();
    // The first attempt always runs (the caller decides whether to start); no retry follows.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("logs each retry without the error message", async () => {
    const { sleep } = recordingSleep();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fn = vi.fn((attempt: number) =>
      attempt === 0 ? Promise.reject(new Transient("secret-in-body sk-123456", 503)) : Promise.resolve(1),
    );
    await withRetry(fn, { isRetryable: always, sleep, log, label: "search:brave" });
    expect(log.debug).toHaveBeenCalledTimes(1);
    const fields = log.debug.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toMatchObject({ label: "search:brave", attempt: 1, retries: 2, status: 503 });
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain("sk-123456");
  });
});

describe("jitter", () => {
  it("draws the wait uniformly from [0, min(maxMs, baseMs * 2^n))", () => {
    expect(jitterDelayMs(0, 300, 2000, () => 0)).toBe(0);
    expect(jitterDelayMs(0, 300, 2000, () => 0.5)).toBe(150);
    expect(jitterDelayMs(1, 300, 2000, () => 0.5)).toBe(300);
    // 300 * 2^3 = 2400 is clamped to the 2000 ceiling.
    expect(jitterDelayMs(3, 300, 2000, () => 0.999999)).toBeLessThan(2000);
    expect(jitterDelayMs(3, 300, 2000, () => 0.999999)).toBeGreaterThanOrEqual(1999);
  });

  it("keeps every wait inside the window for the first and second retry", async () => {
    const lows = recordingSleep();
    const highs = recordingSleep();
    const failTwice = (): ((a: number) => Promise<string>) => (a) => (a < 2 ? Promise.reject(new Transient()) : Promise.resolve("ok"));
    await withRetry(failTwice(), { isRetryable: always, sleep: lows.sleep, random: () => 0 });
    await withRetry(failTwice(), { isRetryable: always, sleep: highs.sleep, random: () => 0.9999999 });
    expect(lows.waits).toEqual([0, 0]);
    // Window for retry 1 is 300 ms, for retry 2 it is 600 ms; both strictly below.
    expect(highs.waits[0]).toBeLessThan(DEFAULT_BASE_MS);
    expect(highs.waits[1]).toBeLessThan(DEFAULT_BASE_MS * 2);
    expect(highs.waits[1]).toBeGreaterThanOrEqual(DEFAULT_BASE_MS);
  });

  it("never waits longer than maxMs", async () => {
    const { sleep, waits } = recordingSleep();
    const fn = vi.fn((a: number) => (a < 2 ? Promise.reject(new Transient()) : Promise.resolve("ok")));
    await withRetry(fn, { isRetryable: always, sleep, random: () => 0.9999999, baseMs: 5000, maxMs: 700 });
    expect(Math.max(...waits)).toBeLessThan(700);
  });

  it("with real randomness stays within bounds over many draws", () => {
    for (let i = 0; i < 500; i++) {
      const d = jitterDelayMs(i % 3, DEFAULT_BASE_MS, DEFAULT_MAX_MS, Math.random);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(Math.min(DEFAULT_MAX_MS, DEFAULT_BASE_MS * 2 ** (i % 3)));
    }
  });
});

describe("Retry-After", () => {
  it("is read only from an error with status 429 and a numeric retryAfterMs", () => {
    expect(retryAfterMsOf(new Transient("x", 429, 1500))).toBe(1500);
    expect(retryAfterMsOf(new Transient("x", 503, 1500))).toBeUndefined();
    expect(retryAfterMsOf(new Transient("x", 429))).toBeUndefined();
    expect(retryAfterMsOf(new Transient("x", 429, -5))).toBeUndefined();
    expect(retryAfterMsOf(new Transient("x", 429, Number.NaN))).toBeUndefined();
    expect(retryAfterMsOf("nope")).toBeUndefined();
    expect(retryAfterMsOf(null)).toBeUndefined();
  });

  it("is waited for in full when it exceeds the jittered delay", async () => {
    const { sleep, waits } = recordingSleep();
    const fn = vi.fn((a: number) => (a === 0 ? Promise.reject(new Transient("slow down", 429, 1800)) : Promise.resolve("ok")));
    await withRetry(fn, { isRetryable: always, sleep, random: () => 0 });
    expect(waits).toEqual([1800]);
  });

  it("never shortens the wait below the jittered delay", async () => {
    const { sleep, waits } = recordingSleep();
    const fn = vi.fn((a: number) => (a === 0 ? Promise.reject(new Transient("slow down", 429, 10)) : Promise.resolve("ok")));
    await withRetry(fn, { isRetryable: always, sleep, random: () => 0.5, baseMs: 300 });
    expect(waits).toEqual([150]);
  });

  it("is ignored on other statuses", async () => {
    const { sleep, waits } = recordingSleep();
    const fn = vi.fn((a: number) => (a === 0 ? Promise.reject(new Transient("down", 503, 1900)) : Promise.resolve("ok")));
    await withRetry(fn, { isRetryable: always, sleep, random: () => 0 });
    expect(waits).toEqual([0]);
  });

  it("gives up at once when it asks for longer than the wait ceiling", async () => {
    const { sleep, waits } = recordingSleep();
    const err = new Transient("quota", 429, 60_000);
    const fn = vi.fn(() => Promise.reject(err));
    await expect(withRetry(fn, { isRetryable: always, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    expect(parseRetryAfter("1.5")).toBe(1500);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseRetryAfter("Sun, 18 Oct 2026 12:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfter("Sun, 18 Oct 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("returns undefined for missing or invalid values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-3")).toBeUndefined();
  });
});

describe("call budget", () => {
  it("worstCaseMs is attempts x timeout plus the waits", () => {
    expect(worstCaseMs(8000)).toBe(3 * 8000 + 2 * DEFAULT_MAX_MS);
    expect(worstCaseMs(8000, 0)).toBe(8000);
    expect(worstCaseMs(8000, 99)).toBe(worstCaseMs(8000, 2));
  });

  it("stays inside the documented per-tool worst cases", () => {
    // web_search: 8 s per attempt, capped by the tool at 30 s.
    expect(worstCaseMs(8_000)).toBeLessThanOrEqual(30_000);
    // fetch_page fast chain: 20 s per attempt, well inside the 90 s tool cap (the browser fallback has the rest).
    expect(worstCaseMs(20_000)).toBeLessThanOrEqual(90_000 - 20_000);
  });

  it("a call that fails slowly every time finishes within worstCaseMs of virtual time", async () => {
    vi.useFakeTimers();
    try {
      const attemptMs = 8_000;
      const fn = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, attemptMs));
        throw new Transient("slow failure");
      });
      const started = Date.now();
      // random() just below 1 is the longest possible jitter.
      const result = withRetry(fn, { isRetryable: always, random: () => 0.9999999 }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(Transient);
      expect(fn).toHaveBeenCalledTimes(3);
      expect(Date.now() - started).toBeLessThanOrEqual(worstCaseMs(attemptMs));
    } finally {
      vi.useRealTimers();
    }
  });
});
