import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildHooks } from "../core/browser/handoff.js";
import type { HandoffHooks } from "../core/browser/types.js";
import type { Deps } from "../deps.js";
import { toolError } from "../schemas/error.js";
import { PausedOutputSchema, type PausedOutput } from "../schemas/handoff.js";
import { jsonResult } from "../schemas/result.js";

/**
 * Tool-side plumbing for the human handoff (PLAN.md 16.4, 16.5). A tool that
 * can pause runs its work through `runPausable`: when the work parks a page
 * (through the hooks it was given), the call returns the `paused` result
 * instead of whatever the work produced; the same work is the continuation
 * `resume` runs later, on the parked page.
 */

/**
 * A typed failure a tool's work wants reported as an error envelope. Thrown
 * inside the work so that both the original call and `resume` return the same
 * envelope, whichever of them ran the work.
 */
export class ToolResultError extends Error {
  readonly result: CallToolResult;

  constructor(result: CallToolResult) {
    super("tool result");
    this.name = "ToolResultError";
    this.result = result;
  }
}

export type PausableOutcome<Out> =
  /** The work finished: the tool returns its output as usual. */
  | { kind: "output"; output: Out }
  /** The call parked a page (a `paused` result) or was refused by a full store (a `provider` error). */
  | { kind: "result"; result: CallToolResult };

/**
 * Run `work` with handoff hooks when the server can pause (a store exists and
 * a human can see the window), and without them otherwise. The work must
 * return the tool's validated output object, or throw `ToolResultError` for a
 * typed failure; anything else propagates to the caller's own mapping.
 */
export async function runPausable<Out extends Record<string, unknown>>(
  deps: Deps,
  tool: string,
  work: (hooks: HandoffHooks | undefined) => Promise<Out>,
): Promise<PausableOutcome<Out>> {
  const store = deps.handoffs;
  if (store === undefined || !store.canPause()) return { kind: "output", output: await work(undefined) };

  const bound = buildHooks(store, { tool }, (hooks) => work(hooks));
  const parkedResult = (): CallToolResult | undefined => {
    const record = bound.parkedRecord();
    if (record !== undefined) return jsonResult(pausedOutput(record.toHandoff()));
    const refused = bound.refused();
    if (refused !== undefined) return toolError(refused.code, refused.message, true);
    return undefined;
  };
  try {
    const output = await work(bound.hooks);
    const result = parkedResult();
    return result !== undefined ? { kind: "result", result } : { kind: "output", output };
  } catch (err) {
    const result = parkedResult();
    if (result !== undefined) return { kind: "result", result };
    throw err;
  }
}

export function pausedOutput(handoff: PausedOutput["handoff"]): PausedOutput {
  return PausedOutputSchema.parse({ paused: true, handoff });
}
