import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AccountsError, createAccountsService, type AccountsService } from "../core/accounts/index.js";
import type { Deps } from "../deps.js";
import {
  AccountActionSchema,
  AccountsConnectOutputSchema,
  AccountsDisconnectOutputSchema,
  AccountsInputSchema,
  AccountsListOutputSchema,
  AccountsOutputSchema,
  DEFAULT_CONNECT_WAIT_S,
  MAX_CONNECT_WAIT_S,
  type AccountsOutput,
} from "../schemas/accounts.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Connect your own accounts (reddit, x, facebook, instagram, google, amazon, linkedin) to webrunner's browser so that browser-based tools (social_search, search_reviews, search_hotels) read through your login; see what is connected; disconnect. " +
  "action list: for each platform whether its session cookies are present, which tools use it and when the login expires. " +
  "action connect: opens the platform's login page in the webrunner browser window (or as a tab in your own Chrome when BROWSER_CDP_URL is set) and waits up to wait_seconds " +
  `(0 to ${MAX_CONNECT_WAIT_S}, default ${DEFAULT_CONNECT_WAIT_S}) for you to log in there yourself; it never types credentials. ` +
  "Returns connected, pending (the page stays open for 10 minutes; log in and call connect again) or already_connected. In headless mode connect returns error code config with the two ways out. " +
  "action disconnect: clears that platform's cookies from the webrunner profile (refused with code config when attached to your own Chrome). " +
  "Cookie values are never returned or logged. The whole call is capped at 330 seconds; past that it returns error code timeout (retryable).";

/**
 * MCP SDK 1.32 takes only an object schema as `outputSchema`: a discriminated
 * union is dropped from `tools/list` and crashes result validation. So the
 * tool advertises one object carrying every per-action field (optional
 * except `action` and `caveats`) and makes that object validate exactly what
 * `AccountsOutputSchema`, the real contract, accepts.
 */
export const AccountsOutputObjectSchema = z
  .object({
    ...AccountsListOutputSchema.shape,
    ...AccountsConnectOutputSchema.shape,
    ...AccountsDisconnectOutputSchema.shape,
    action: AccountActionSchema,
    status: z.enum(["connected", "pending", "already_connected", "disconnected", "not_connected"]),
  })
  .partial()
  .required({ action: true, caveats: true })
  .superRefine((value, ctx) => {
    const checked = AccountsOutputSchema.safeParse(value);
    if (checked.success) return;
    for (const issue of checked.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  });

export interface AccountsToolOptions {
  /** Replaces the real service. For tests. */
  service?: (deps: Deps) => AccountsService;
  /** Overrides the 330 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

export function registerAccountsTool(server: McpServer, deps: Deps, options: AccountsToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.accounts;
  // One service per server: it remembers the login pages a `pending` connect left open.
  let service: AccountsService | undefined;
  const getService = (): AccountsService | undefined => {
    if (service !== undefined) return service;
    if (options.service !== undefined) {
      service = options.service(deps);
    } else if (deps.browser !== undefined) {
      service = createAccountsService({ browser: deps.browser, config: deps.config, log: deps.log });
    }
    return service;
  };

  server.registerTool(
    "accounts",
    {
      title: "Accounts",
      description: DESCRIPTION,
      inputSchema: AccountsInputSchema,
      outputSchema: AccountsOutputObjectSchema,
      // disconnect clears cookies, so the tool is neither read-only nor idempotent as a whole.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      runWithWallClock("accounts", capMs, async () => {
        try {
          const parsed = AccountsInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const input = parsed.data;
          const svc = getService();
          if (svc === undefined) {
            return toolError("config", "No browser session is available, so accounts cannot read or change cookies.", false);
          }

          let output: AccountsOutput;
          try {
            if (input.action === "list") {
              output = await svc.list();
            } else if (input.platform === undefined) {
              // The schema's refine already enforces this; the check narrows the type.
              return toolError("invalid_input", `platform is required for action ${input.action}`, false);
            } else if (input.action === "connect") {
              output = await svc.connect(input.platform, input.wait_seconds);
            } else {
              output = await svc.disconnect(input.platform);
            }
          } catch (err) {
            if (err instanceof AccountsError) return toolError(err.code, err.message, err.retryable);
            throw err;
          }

          const checked = AccountsOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("accounts produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "accounts produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("accounts failed unexpectedly", { error: message });
          return toolError("internal", `accounts failed: ${message}`, false);
        }
      }),
  );
}
