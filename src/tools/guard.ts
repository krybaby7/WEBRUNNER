import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "../deps.js";
import { toolError } from "../schemas/error.js";

/**
 * Per-call guards shared by the tool handlers: an overall wall-clock cap and
 * the daily cost cap check.
 */

/**
 * Overall wall-clock cap per tool call, in milliseconds. Every description
 * states its tool's cap. `deep_research` is configurable
 * (WEBRUNNER_RESEARCH_MAX_MS, default 15 minutes) so it is not listed here.
 *
 * Worst cases these must cover:
 *   web_search      3 attempts x 8 s per provider plus two waits of at most 2 s (28 s), under 30 s.
 *                   A provider that times out is not retried, so the realistic worst case is 8 s.
 *   fetch_page      fast chain 3 x 20 s plus two waits (64 s), then the browser (45 s): the cap cuts
 *                   in when both are slow.
 *   search_flights  Google Flights 90 s or Duffel 45 s per source, plus place resolution.
 *   browse_task     the agent stops itself after 10 minutes between steps; the extra minute is a
 *                   backstop for a step that hangs.
 */
export const TOOL_WALL_CLOCK_MS = {
  web_search: 30_000,
  fetch_page: 90_000,
  search_flights: 120_000,
  browse_task: 11 * 60_000,
} as const;

/** Thrown by `withWallClock` when the cap is reached. */
export class WallClockExceeded extends Error {
  readonly limitMs: number;

  constructor(limitMs: number) {
    super(`Exceeded the ${Math.round(limitMs / 1000)} s wall-clock limit`);
    this.name = "WallClockExceeded";
    this.limitMs = limitMs;
  }
}

/**
 * Run `work` with a deadline. At `ms` the signal handed to `work` aborts and
 * the returned promise rejects with `WallClockExceeded`, even when `work`
 * ignores the signal. Work that is still running after that has nobody
 * waiting for it; its eventual result or failure is dropped.
 */
export async function withWallClock<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new WallClockExceeded(ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The `timeout` envelope for a call that hit its wall-clock cap. Retryable: a second try may be faster. */
export function wallClockResult(tool: string, ms: number): CallToolResult {
  return toolError(
    "timeout",
    `${tool} did not finish within its ${Math.round(ms / 1000)} s limit and was stopped. Try again, or narrow the request.`,
    true,
    { limit_ms: ms },
  );
}

/**
 * Run a tool handler under its wall-clock cap. A `WallClockExceeded` becomes
 * the `timeout` envelope; every other outcome is the handler's own.
 */
export async function runWithWallClock(
  tool: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await withWallClock(ms, work);
  } catch (err) {
    if (err instanceof WallClockExceeded) return wallClockResult(tool, ms);
    throw err;
  }
}

/**
 * The `budget_exceeded` envelope when today's LLM spend has reached
 * WEBRUNNER_DAILY_COST_CAP_USD, otherwise undefined. A no-op while the cap is unset.
 */
export function dailyCapResult(deps: Deps): CallToolResult | undefined {
  const err = deps.dailyCap?.exceededError();
  if (err === undefined) return undefined;
  return toolError("budget_exceeded", err.message, false, err.details);
}
