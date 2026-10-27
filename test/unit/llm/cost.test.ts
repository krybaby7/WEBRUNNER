import { describe, expect, it } from "vitest";
import { addUsage, computeCost, CostMeter, EMPTY_USAGE } from "../../../src/core/llm/cost.js";
import { DEFAULT_CODEX_MODEL, FALLBACK_PRICE, PRICES, priceFor } from "../../../src/core/llm/models.js";
import { LlmError, type Usage } from "../../../src/core/llm/types.js";
import { makeLogger } from "./helpers.js";

const usage = (u: Partial<Usage>): Usage => ({ ...EMPTY_USAGE, ...u });

describe("price table", () => {
  it("matches the PLAN.md 4.6 prices", () => {
    expect(PRICES["claude-opus-5-5"]).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 });
    expect(PRICES["claude-sonnet-5-5"]).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 });
    expect(PRICES["claude-haiku-5-5"]).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(PRICES["claude-fable-5-1"]).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 });
  });

  it("prices the Codex fallback's GPT models at OpenAI's standard tier, long context above 272K (PLAN.md 15.4)", () => {
    expect(PRICES[DEFAULT_CODEX_MODEL]).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 2.5,
      longContext: { thresholdTokens: 272_000, inputPerMTok: 4, outputPerMTok: 15, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
    });
    expect(PRICES["gpt-6-luna"]).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 });
    // 300K prompt tokens cross the threshold: 0.3 * 4 + 0.1 * 15
    expect(computeCost(DEFAULT_CODEX_MODEL, usage({ inputTokens: 300_000, outputTokens: 100_000 }))).toBeCloseTo(2.7, 10);
  });

  it("prices cache writes at 1.25x input and Haiku cache reads at 0.1x input", () => {
    for (const price of Object.values(PRICES)) {
      expect(price.cacheWritePerMTok).toBeCloseTo(price.inputPerMTok * 1.25, 10);
    }
    expect(PRICES["claude-haiku-5-5"]?.cacheReadPerMTok).toBeCloseTo(0.01, 10);
  });
});

describe("computeCost", () => {
  it("opus 5.5: input, output, cache read, cache write", () => {
    // 1M of each: 4 + 20 + 0.2 + 5
    expect(
      computeCost("claude-opus-5-5", usage({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 })),
    ).toBeCloseTo(29.2, 10);
  });

  it("sonnet 5.5: input, output, cache read, cache write", () => {
    // 2 + 10 + 0.2 + 2.5
    expect(
      computeCost("claude-sonnet-5-5", usage({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 })),
    ).toBeCloseTo(14.7, 10);
  });

  it("haiku 5.5 up to 100K prompt tokens", () => {
    // prompt = 90k + 5k + 5k = 100k, exactly at the threshold: base rates
    const u = usage({ inputTokens: 90_000, cacheReadTokens: 5_000, cacheWriteTokens: 5_000, outputTokens: 10_000 });
    const expected = (90_000 * 0.1 + 5_000 * 0.01 + 5_000 * 0.125 + 10_000 * 0.5) / 1e6;
    expect(computeCost("claude-haiku-5-5", u)).toBeCloseTo(expected, 12);
  });

  it("haiku 5.5 above 100K prompt tokens uses the long-context rates", () => {
    const u = usage({ inputTokens: 50_000, cacheReadTokens: 50_001, outputTokens: 10_000 });
    const expected = (50_000 * 0.5 + 50_001 * 0.05 + 10_000 * 2.5) / 1e6;
    expect(computeCost("claude-haiku-5-5", u)).toBeCloseTo(expected, 12);
  });

  it("fable 5.1: input, output, cache read, cache write", () => {
    // 10 + 50 + 0.25 + 12.5
    expect(
      computeCost("claude-fable-5-1", usage({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 })),
    ).toBeCloseTo(72.75, 10);
  });

  it("is zero for empty usage", () => {
    expect(computeCost("claude-opus-5-5", EMPTY_USAGE)).toBe(0);
  });

  it("long context never applies to models without a threshold", () => {
    expect(computeCost("claude-opus-5-5", usage({ inputTokens: 500_000 }))).toBeCloseTo(2, 10);
  });
});

describe("unknown models", () => {
  it("fall back to the conservative price and warn once", () => {
    const logger = makeLogger();
    const model = "claude-unknown-test-model";
    expect(priceFor(model, logger)).toBe(FALLBACK_PRICE);
    expect(priceFor(model, logger)).toBe(FALLBACK_PRICE);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ model });
  });

  it("is at least as expensive as every known model, so budgets err high", () => {
    for (const price of Object.values(PRICES)) {
      expect(FALLBACK_PRICE.inputPerMTok).toBeGreaterThanOrEqual(price.inputPerMTok);
      expect(FALLBACK_PRICE.outputPerMTok).toBeGreaterThanOrEqual(price.outputPerMTok);
      expect(FALLBACK_PRICE.cacheReadPerMTok).toBeGreaterThanOrEqual(price.cacheReadPerMTok);
      expect(FALLBACK_PRICE.cacheWritePerMTok).toBeGreaterThanOrEqual(price.cacheWritePerMTok);
    }
    const cost = computeCost("another-unknown-model", usage({ inputTokens: 1e6 }), makeLogger());
    expect(cost).toBeCloseTo(10, 10);
  });

  it("does not treat Object.prototype keys as models", () => {
    expect(priceFor("constructor", makeLogger())).toBe(FALLBACK_PRICE);
  });
});

describe("CostMeter", () => {
  it("accumulates usage, cost and call count", () => {
    const meter = new CostMeter();
    meter.record(usage({ inputTokens: 10, outputTokens: 5 }), 0.5);
    meter.record(usage({ inputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3 }), 0.25);
    expect(meter.totalUsage).toEqual({ inputTokens: 11, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3 });
    expect(meter.totalCostUsd).toBeCloseTo(0.75, 10);
    expect(meter.calls).toBe(2);
    expect(meter.remainingUsd).toBe(Infinity);
    expect(meter.exhausted).toBe(false);
  });

  it("returns a copy of the totals", () => {
    const meter = new CostMeter();
    meter.totalUsage.inputTokens = 999;
    expect(meter.totalUsage.inputTokens).toBe(0);
  });

  it("never throws without a cap", () => {
    const meter = new CostMeter();
    meter.record(usage({}), 1e9);
    expect(() => meter.check()).not.toThrow();
  });

  it("allows calls below the cap and throws budget_exceeded once the cap is reached", () => {
    const meter = new CostMeter({ maxCostUsd: 1 });
    expect(() => meter.check()).not.toThrow();
    meter.record(usage({}), 0.6);
    expect(() => meter.check()).not.toThrow();
    expect(meter.remainingUsd).toBeCloseTo(0.4, 10);

    // The call that crosses the cap is recorded, not rejected: overshoot is one call.
    meter.record(usage({}), 0.6);
    expect(meter.totalCostUsd).toBeCloseTo(1.2, 10);
    expect(meter.exhausted).toBe(true);
    expect(meter.remainingUsd).toBe(0);

    let thrown: unknown;
    try {
      meter.check();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    const err = thrown as LlmError;
    expect(err.code).toBe("budget_exceeded");
    expect(err.retryable).toBe(false);
    expect(err.details).toMatchObject({ max_cost_usd: 1, calls: 2 });
  });

  it("treats spend exactly equal to the cap as exhausted", () => {
    const meter = new CostMeter({ maxCostUsd: 0.5 });
    meter.record(usage({}), 0.5);
    expect(() => meter.check()).toThrow(LlmError);
  });
});

describe("addUsage", () => {
  it("adds field by field", () => {
    expect(
      addUsage(
        { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      ),
    ).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });
});
