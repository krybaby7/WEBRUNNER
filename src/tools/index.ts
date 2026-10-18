import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { registerPingTool } from "./ping.js";
import { registerFetchPageTool } from "./fetch_page.js";
import { registerWebSearchTool } from "./web_search.js";

/** Wire every tool. Each work package adds exactly one line here. */
export function registerTools(server: McpServer, deps: Deps): void {
  registerPingTool(server, deps);
  registerWebSearchTool(server, deps);
  registerFetchPageTool(server, deps);
}
