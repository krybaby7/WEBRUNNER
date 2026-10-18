import type { Logger } from "../../log.js";
import { priceFor } from "./models.js";
import { LlmError, type Usage } from "./types.js";

const MTOK = 1_000_000;

export const EMPTY_USAGE: Readonly<Usage> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Cost in USD of one response. Unknown models are priced conservatively with a warning. */
export function computeCost(model: string, usage: Usage, logger?: Logger): number {
  const price = priceFor(model, logger);
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rates =
    price.longContext !== undefined && promptTokens > price.longContext.thresholdTokens
      ? price.longContext
      : price;
  return (
    (usage.inputTokens * rates.inputPerMTok +
      usage.outputTokens * rates.outputPerMTok +
      usage.cacheReadTokens * rates.cacheReadPerMTok +
      usage.cacheWriteTokens * rates.cacheWritePerMTok) /
    MTOK
  );
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface CostMeterOptions {
  /** Hard cap in USD. Unset means unlimited. */
  maxCostUsd?: number;
}

/**
 * Accumulates usage and cost across calls.
 *
 * Budget semantics: `record()` never throws, so the response that crosses the
 * cap is still delivered. `check()` throws `budget_exceeded` once the total has
 * reached the cap, and the client calls it before every request. The overshoot
 * is therefore at most one call.
 */
export class CostMeter {
  readonly maxCostUsd: number | undefined;
  private usage: Usage = { ...EMPTY_USAGE };
  private cost = 0;
  private callCount = 0;

  constructor(options: CostMeterOptions = {}) {
    this.maxCostUsd = options.maxCostUsd;
  }

  record(usage: Usage, costUsd: number): void {
    this.usage = addUsage(this.usage, usage);
    this.cost += costUsd;
    this.callCount += 1;
  }

  get totalUsage(): Usage {
    return { ...this.usage };
  }

  get totalCostUsd(): number {
    return this.cost;
  }

  get calls(): number {
    return this.callCount;
  }

  /** USD left before the cap, or Infinity when unlimited. Never negative. */
  get remainingUsd(): number {
    return this.maxCostUsd === undefined ? Infinity : Math.max(0, this.maxCostUsd - this.cost);
  }

  get exhausted(): boolean {
    return this.maxCostUsd !== undefined && this.cost >= this.maxCostUsd;
  }

  /** Throws LlmError `budget_exceeded` when the cap has been reached. */
  check(): void {
    if (this.maxCostUsd !== undefined && this.cost >= this.maxCostUsd) {
      throw new LlmError(
        "budget_exceeded",
        "api",
        `Cost cap of $${this.maxCostUsd.toFixed(2)} reached (spent $${this.cost.toFixed(4)} over ${this.callCount} calls)`,
        {
          retryable: false,
          details: { spent_usd: this.cost, max_cost_usd: this.maxCostUsd, calls: this.callCount },
        },
      );
    }
  }
}
