import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { SearchError } from "../core/search/index.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";
import { WebSearchInputSchema, WebSearchOutputSchema } from "../schemas/web_search.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Search the web. Queries several search engines (Brave, Exa, Tavily, Perplexity; whichever have API keys configured) in parallel and returns one merged, deduplicated list ranked by reciprocal rank fusion, with the engines that returned each result. " +
  "Supports recency and domain filters. Results are cached for an hour. A failing or slow engine is reported in providers_failed and does not fail the call. " +
  "Each engine returns at most about 20 results per request, so a very large max_results (up to 30) may return fewer rows than asked for. " +
  "Transient engine failures (429, 5xx, network errors) are retried up to twice. The whole call is capped at 30 seconds; past that it returns error code timeout (retryable).";

export interface WebSearchToolOptions {
  /** Overrides the 30 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

export function registerWebSearchTool(server: McpServer, deps: Deps, options: WebSearchToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.web_search;
  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description: DESCRIPTION,
      inputSchema: WebSearchInputSchema,
      outputSchema: WebSearchOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runWithWallClock("web_search", capMs, async () => {
        const search = deps.search;
        if (search === undefined) {
          return toolError("internal", "The search service is not available.", false);
        }
        try {
          return jsonResult(await search.search(args));
        } catch (err) {
          if (err instanceof SearchError) {
            return toolError(err.code, err.message, err.retryable, { providers_failed: err.providersFailed });
          }
          const message = err instanceof Error ? err.message : String(err);
          deps.log.error("web_search failed unexpectedly", { error: message });
          return toolError("internal", `web_search failed: ${message}`, false);
        }
      }),
  );
}
