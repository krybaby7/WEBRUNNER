/**
 * A small FIFO semaphore. `createLimiter(n).run(fn)` runs `fn` once fewer than
 * `n` calls are in flight; waiting calls start in the order they arrived. Used
 * per search provider and per fast fetcher so that many parallel sub-queries in
 * a `deep_research` run cannot flood one API.
 */

/** Concurrent requests per search provider. */
export const DEFAULT_SEARCH_CONCURRENCY = 4;
/** Concurrent requests per fast fetcher. */
export const DEFAULT_FETCH_CONCURRENCY = 6;

export interface Limiter {
  /** Run `fn` when a slot is free. Resolves or rejects with whatever `fn` does; a failure frees the slot. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Calls running now. */
  readonly active: number;
  /** Calls waiting for a slot. */
  readonly pending: number;
  readonly limit: number;
}

export function createLimiter(limit: number): Limiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`createLimiter: limit must be an integer of at least 1, got ${String(limit)}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  function release(): void {
    const next = waiting.shift();
    // Hand the slot straight to the oldest waiter so `active` never dips and FIFO holds.
    if (next !== undefined) next();
    else active -= 1;
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    get active() {
      return active;
    },
    get pending() {
      return waiting.length;
    },
    limit,
  };
}
