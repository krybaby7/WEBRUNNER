import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { createFxService, FxError, type FxService } from "../core/fx/index.js";
import { toolError } from "../schemas/error.js";
import { EARLIEST_RATE_DATE, ExchangeRateInputSchema, ExchangeRateOutputSchema, MAX_TARGET_CURRENCIES } from "../schemas/fx.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  `Convert an amount from one currency into up to ${MAX_TARGET_CURRENCIES} others at the latest or a historical reference rate (YYYY-MM-DD, ${EARLIEST_RATE_DATE} or later). ` +
  "Source: Frankfurter (no API key), which serves the European Central Bank's reference rates for about 30 major currencies, published once per working day around 16:00 CET; " +
  "weekends and holidays return the previous working day's rates, named in `date`. Not a trading quote; crypto is not covered. An unsupported code returns error code invalid_input listing the supported codes. " +
  "Latest rates are cached 1 hour, historical rates 30 days. One request of 10 seconds; the whole call is capped at 20 seconds; past that it returns error code timeout (retryable).";

export interface ExchangeRateToolOptions {
  /** Replaces the Frankfurter service. For tests. */
  service?: (deps: Deps) => FxService;
  /** Overrides the 20 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

export function registerExchangeRateTool(server: McpServer, deps: Deps, options: ExchangeRateToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.exchange_rate;
  const makeService = options.service ?? ((d: Deps): FxService => createFxService({ log: d.log, ...(d.cache !== undefined && { cache: d.cache }) }));

  server.registerTool(
    "exchange_rate",
    {
      title: "Exchange rate",
      description: DESCRIPTION,
      inputSchema: ExchangeRateInputSchema,
      outputSchema: ExchangeRateOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("exchange_rate", capMs, async (wallSignal) => {
        try {
          const parsed = ExchangeRateInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const service = makeService(deps);
          const output = await service.convert(parsed.data, AbortSignal.any([extra.signal, wallSignal]));
          const checked = ExchangeRateOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("exchange_rate produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "exchange_rate produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          if (err instanceof FxError) return toolError(err.code, err.message, err.retryable, err.details);
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("exchange_rate failed unexpectedly", { error: message });
          return toolError("internal", `exchange_rate failed: ${message}`, false);
        }
      }),
  );
}
