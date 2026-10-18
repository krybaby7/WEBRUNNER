import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { FetchServiceError } from "../core/fetch/index.js";
import { toolError } from "../schemas/error.js";
import { FetchPageInputSchema, FetchPageOutputSchema } from "../schemas/fetch_page.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Read a web page as clean Markdown. Three modes: auto (default) tries fast fetchers first (Firecrawl when configured, Jina Reader, then a direct HTTP fetch with Readability) and falls back to a real Chromium browser when the page is behind a bot wall or has almost no text, which covers JavaScript-rendered pages; fast uses only the fast fetchers and never opens a browser; browser always renders the page in the browser and can wait for a CSS selector (wait_for). " +
  "Output is truncated to max_chars (default 40000) and `truncated` says so. `method` reports which fetcher produced the page. " +
  "PDFs are read as text: Markdown with the title (or file name) as heading and page breaks as --- lines; PDFs over 25 MB are refused with invalid_input, and scanned PDFs without a text layer are not supported. " +
  "Transient fast-fetch failures (network errors, 5xx, timeouts) are retried up to twice; bot walls are not retried. " +
  "Results are cached: 24 hours for fast fetches, 1 hour for browser fetches; `cached` is true on a cache hit. The whole call is capped at 90 seconds; past that it returns error code timeout (retryable).";

export interface FetchPageToolOptions {
  /** Overrides the 90 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

export function registerFetchPageTool(server: McpServer, deps: Deps, options: FetchPageToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.fetch_page;
  server.registerTool(
    "fetch_page",
    {
      title: "Fetch page",
      description: DESCRIPTION,
      inputSchema: FetchPageInputSchema,
      outputSchema: FetchPageOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      runWithWallClock("fetch_page", capMs, async () => {
        const fetchService = deps.fetch;
        if (fetchService === undefined) {
          return toolError("internal", "The fetch service is not available.", false);
        }
        try {
          return jsonResult(await fetchService.fetchPage(args));
        } catch (err) {
          if (err instanceof FetchServiceError) {
            return toolError(err.code, err.message, err.retryable, {
              ...(err.method !== undefined && { method: err.method }),
            });
          }
          const message = err instanceof Error ? err.message : String(err);
          deps.log.error("fetch_page failed unexpectedly", { error: message });
          return toolError("internal", `fetch_page failed: ${message}`, false);
        }
      }),
  );
}
