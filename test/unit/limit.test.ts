import { describe, expect, it } from "vitest";
import { DEFAULT_FETCH_CONCURRENCY, DEFAULT_SEARCH_CONCURRENCY, createLimiter } from "../../src/core/limit.js";

/** A task that stays running until released, and records when it started. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createLimiter", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_SEARCH_CONCURRENCY).toBe(4);
    expect(DEFAULT_FETCH_CONCURRENCY).toBe(6);
  });

  it("never runs more than n calls at once", async () => {
    const limiter = createLimiter(3);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, gate);
    const done = gates.map((g) =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }),
    );
    await tick();
    expect(running).toBe(3);
    expect(limiter.active).toBe(3);
    expect(limiter.pending).toBe(7);
    for (const g of gates) {
      g.release();
      await tick();
    }
    await Promise.all(done);
    expect(peak).toBe(3);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("starts waiting calls in arrival order", async () => {
    const limiter = createLimiter(2);
    const started: number[] = [];
    const gates = Array.from({ length: 8 }, gate);
    const done = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    // Finish out of order: the next waiters still start in arrival order.
    gates[1]?.release();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0]?.release();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3]?.release();
    gates[2]?.release();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    for (const g of gates) g.release();
    await Promise.all(done);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns what the task returns and rethrows what it throws", async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(() => Promise.resolve(42))).resolves.toBe(42);
    await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("frees the slot when a task fails, so waiting calls still run", async () => {
    const limiter = createLimiter(1);
    const g = gate();
    const first = limiter.run(async () => {
      await g.promise;
      throw new Error("first failed");
    });
    const second = limiter.run(() => Promise.resolve("second ran"));
    first.catch(() => undefined);
    g.release();
    await expect(second).resolves.toBe("second ran");
    expect(limiter.active).toBe(0);
  });

  it("frees the slot when a task throws synchronously", async () => {
    const limiter = createLimiter(1);
    await expect(
      limiter.run((() => {
        throw new Error("sync boom");
      }) as () => Promise<never>),
    ).rejects.toThrow("sync boom");
    await expect(limiter.run(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(-1)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
    expect(() => createLimiter(Number.NaN)).toThrow(RangeError);
  });
});
