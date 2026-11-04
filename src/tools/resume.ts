import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LlmError } from "../core/llm/types.js";
import type { Deps } from "../deps.js";
import { toolError } from "../schemas/error.js";
import { DEFAULT_RESUME_WAIT_S, MAX_RESUME_WAIT_S, ResumeInputSchema, ResumeOutputObjectSchema } from "../schemas/handoff.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";
import { ToolResultError } from "./handoff.js";

const DESCRIPTION =
  "Continue a browser run that paused at a wall you cleared by hand (PLAN section 16): a CAPTCHA, a security checkpoint, a cookie dialog, a login page or a one-time code that a tool left open in the browser window and reported as a `paused` result with a handoff id. " +
  `It re-probes the parked page every 2 seconds for up to wait_seconds (0 to ${MAX_RESUME_WAIT_S}, default ${DEFAULT_RESUME_WAIT_S}; 0 probes once). ` +
  "When the wall is gone it runs the paused tool again on that page and returns that tool's normal output; when the wall is still there it returns `paused` again with the same id and an updated what_to_do. " +
  "An expired or unknown id is error code invalid_input. cancel: true closes the parked page instead and returns { cancelled: true }. " +
  "It never types into the page. The whole call is capped at 330 seconds; past that it returns error code timeout (retryable).";

export interface ResumeToolOptions {
  /** Overrides the 330 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

export function registerResumeTool(server: McpServer, deps: Deps, options: ResumeToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.resume;
  server.registerTool(
    "resume",
    {
      title: "Resume a paused run",
      description: DESCRIPTION,
      inputSchema: ResumeInputSchema,
      outputSchema: ResumeOutputObjectSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      runWithWallClock("resume", capMs, async () => {
        const parsed = ResumeInputSchema.safeParse(args);
        if (!parsed.success) {
          return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
        }
        const { handoff_id: id, wait_seconds: waitSeconds, cancel } = parsed.data;
        const store = deps.handoffs;
        if (store === undefined) return toolError("config", "No browser session is available, so there is nothing to resume.", false);

        const unknown = (): ReturnType<typeof toolError> =>
          toolError(
            "invalid_input",
            `No parked handoff has id ${id}: it finished, was cancelled, expired (its page is closed), or never existed. Run the tool again.`,
            false,
          );

        try {
          if (cancel) {
            return (await store.cancel(id)) ? jsonResult({ cancelled: true, handoff_id: id }) : unknown();
          }
          const outcome = await store.resume(id, waitSeconds);
          switch (outcome.kind) {
            case "finished":
              return jsonResult(outcome.output);
            case "paused":
              return jsonResult({ paused: true, handoff: outcome.handoff });
            case "cancelled":
              // The owner closed the window by hand.
              return jsonResult({ cancelled: true, handoff_id: id });
            case "expired":
              return toolError("invalid_input", `Handoff ${id} expired and its page was closed. Run the tool again.`, false);
            case "unknown":
              return unknown();
          }
        } catch (err) {
          if (err instanceof ToolResultError) return err.result;
          if (err instanceof LlmError) return toolError(err.code, err.message, err.retryable, err.details);
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("resume failed unexpectedly", { error: message });
          return toolError("internal", `resume failed: ${message}`, false);
        }
      }),
  );
}
