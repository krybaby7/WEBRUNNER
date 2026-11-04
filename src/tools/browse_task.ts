import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runBrowseTask, type BrowseResumeHolder, type BrowseTaskRunner } from "../core/browser/agent.js";
import { JsonSchemaError } from "../core/browser/json-schema.js";
import { LlmError } from "../core/llm/types.js";
import { modelBackend, type Deps } from "../deps.js";
import { NO_BACKEND_MESSAGE } from "../core/llm/index.js";
import { BrowseTaskInputSchema, BrowseTaskOutputSchema, type BrowseTaskOutput } from "../schemas/browse_task.js";
import { toolError } from "../schemas/error.js";
import { PAUSED_DESCRIPTION_SENTENCE, withPausedOutput } from "../schemas/handoff.js";
import { jsonResult } from "../schemas/result.js";
import { dailyCapResult, runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";
import { runPausable, ToolResultError } from "./handoff.js";

const DESCRIPTION =
  "Goal-directed browsing in a real browser, for live data that has no dedicated tool. A Claude-driven agent looks at the page's accessibility tree and clicks, types, scrolls and navigates step by step until the goal is met, using the owner's persistent browser profile (cookies from earlier logins apply). " +
  "Read-and-extract only: it never submits payments or purchases, never types into password or card fields, never logs in, never downloads files, and by default stays on the start domain. It stops with outcome \"blocked\" on bot walls, and on CAPTCHAs, checkpoints and login walls too when nobody can see the browser window; when the window is visible it pauses there instead. " +
  `${PAUSED_DESCRIPTION_SENTENCE} ` +
  "Pass extract_schema (a JSON Schema object) to get structured data back in `extracted`. Each step is a Claude call: max_steps (default 15, max 40) and max_cost_usd (default 1.00) cap the run, and a run that hits either returns outcome \"partial\" with what it has. " +
  "A run stops itself after 10 minutes; the whole call has a hard limit of 11 minutes and then returns error code timeout (retryable). " +
  "Returns error code budget_exceeded when WEBRUNNER_DAILY_COST_CAP_USD is set and today's LLM spend has reached it. " +
  "Prefer fetch_page or web_search when the data is in static page content.";

export interface BrowseTaskToolOptions {
  /** Overrides the 11 minute hard wall-clock cap. For tests. */
  wallClockMs?: number;
}

/**
 * `runner` is the agent entry point; tests inject a fake so the tool can be
 * exercised without a browser. Production uses `runBrowseTask`.
 */
export function registerBrowseTaskTool(
  server: McpServer,
  deps: Deps,
  runner: BrowseTaskRunner = runBrowseTask,
  options: BrowseTaskToolOptions = {},
): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.browse_task;
  server.registerTool(
    "browse_task",
    {
      title: "Browse task",
      description: DESCRIPTION,
      inputSchema: BrowseTaskInputSchema,
      outputSchema: withPausedOutput(BrowseTaskOutputSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      runWithWallClock("browse_task", capMs, async () => {
        const { browser, llm } = deps;
        if (browser === undefined || llm === undefined) {
          return toolError("internal", "The browser engine or the LLM client is not available.", false);
        }
        if (modelBackend(deps) === "none") {
          return toolError("config", `browse_task needs a model. ${NO_BACKEND_MESSAGE}`, false);
        }
        const overDailyCap = dailyCapResult(deps);
        if (overDailyCap !== undefined) return overDailyCap;
        // One holder per call: a paused run leaves its loop state here and the continuation reads it back.
        const holder: BrowseResumeHolder = {};
        try {
          const outcome = await runPausable<BrowseTaskOutput>(deps, "browse_task", async (hooks) => {
            try {
              const output = await runner(args, {
                browser,
                llm,
                log: deps.log,
                config: deps.config,
                ...(hooks !== undefined && { handoff: hooks, resume: holder }),
              });
              // The agent words a stop on any budget error as its own per-run cap; when the daily cap is
              // what ran out, say so.
              const dailyStop = deps.dailyCap?.exceededError();
              if (dailyStop !== undefined && output.outcome === "partial") {
                return { ...output, summary: `${output.summary} ${dailyStop.message}` };
              }
              return output;
            } catch (err) {
              if (err instanceof LlmError) throw new ToolResultError(toolError(err.code, err.message, err.retryable, err.details));
              if (err instanceof JsonSchemaError) throw new ToolResultError(toolError("invalid_input", err.message, false));
              throw err;
            }
          });
          return outcome.kind === "result" ? outcome.result : jsonResult(outcome.output);
        } catch (err) {
          if (err instanceof ToolResultError) return err.result;
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("browse_task failed unexpectedly", { error: message });
          return toolError("internal", `browse_task failed: ${message}`, false);
        }
      }),
  );
}
