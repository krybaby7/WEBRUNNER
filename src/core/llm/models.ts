import type { Config } from "../../config.js";
import { log, type Logger } from "../../log.js";
import type { Effort, Role } from "./types.js";

/**
 * Price table, USD per million tokens (prices as of 2026-10, PLAN.md 4.6).
 * Cache writes use the 5-minute TTL rate, 1.25x the input price.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** Applies instead of the base rates when the prompt exceeds `thresholdTokens`. */
  longContext?: {
    thresholdTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
  };
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
  },
  "claude-sonnet-5-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
  "claude-haiku-5-5": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
    longContext: {
      thresholdTokens: 100_000,
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.625,
    },
  },
  "claude-fable-5-1": {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 12.5,
  },
};

/** Used for models missing from the table: the most expensive known rates, so budgets err on the safe side. */
export const FALLBACK_PRICE: ModelPrice = {
  inputPerMTok: 10,
  outputPerMTok: 50,
  cacheReadPerMTok: 1,
  cacheWritePerMTok: 12.5,
};

const warnedModels = new Set<string>();

/** Price for `model`. Unknown models get FALLBACK_PRICE and a one-time warning. */
export function priceFor(model: string, logger: Logger = log): ModelPrice {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (price !== undefined) return price;
  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    logger.warn("Unknown model, using conservative fallback pricing for cost accounting", { model });
  }
  return FALLBACK_PRICE;
}

/** Model for a role, honoring `config.models` overrides. */
export function resolveModel(role: Role, config: Pick<Config, "models">): string {
  return config.models[role];
}

/** Routing table defaults, PLAN.md section 4.6 and the WP6 brief. */
export const ROLE_DEFAULTS: Readonly<Record<Role, { effort: Effort; maxTokens: number }>> = {
  planner: { effort: "high", maxTokens: 8192 },
  scorer: { effort: "low", maxTokens: 8192 },
  extractor: { effort: "medium", maxTokens: 8192 },
  writer: { effort: "high", maxTokens: 32000 },
};
