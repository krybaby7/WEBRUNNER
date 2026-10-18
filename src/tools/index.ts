import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { registerBrowseTaskTool } from "./browse_task.js";
import { registerDeepResearchTool } from "./deep_research.js";
import { registerHealthTool } from "./health.js";
import { registerPingTool } from "./ping.js";
import { registerFetchPageTool } from "./fetch_page.js";
import { registerSearchFlightsTool } from "./search_flights.js";
import { registerWebSearchTool } from "./web_search.js";

/**
 * Names of the tools `registerTools` registers, in registration order. The
 * `health` tool reports it; a unit test checks it against `tools/list`, so
 * add the name here when adding a line below.
 */
export const TOOL_NAMES = [
  "ping",
  "web_search",
  "fetch_page",
  "browse_task",
  "search_flights",
  "deep_research",
  "health",
] as const;

/** Wire every tool. Each work package adds exactly one line here. */
export function registerTools(server: McpServer, deps: Deps): void {
  registerPingTool(server, deps);
  registerWebSearchTool(server, deps);
  registerFetchPageTool(server, deps);
  registerBrowseTaskTool(server, deps);
  registerSearchFlightsTool(server, deps);
  registerDeepResearchTool(server, deps);
  registerHealthTool(server, deps, TOOL_NAMES);
}
