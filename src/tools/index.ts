import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { registerAccountsTool } from "./accounts.js";
import { registerBrowseTaskTool } from "./browse_task.js";
import { registerDeepResearchTool } from "./deep_research.js";
import { registerExchangeRateTool } from "./exchange_rate.js";
import { registerHealthTool } from "./health.js";
import { registerPingTool } from "./ping.js";
import { registerFetchPageTool } from "./fetch_page.js";
import { registerMarketQuoteTool } from "./market_quote.js";
import { registerSearchFlightsTool } from "./search_flights.js";
import { registerSocialSearchTool } from "./social_search.js";
import { registerSearchHotelsTool } from "./search_hotels.js";
import { registerSearchReviewsTool } from "./search_reviews.js";
import { registerWeatherTool } from "./weather.js";
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
  "social_search",
  "search_hotels",
  "search_reviews",
  "market_quote",
  "weather",
  "exchange_rate",
  "deep_research",
  "accounts",
  "health",
] as const;

/** Wire every tool. Each work package adds exactly one line here. */
export function registerTools(server: McpServer, deps: Deps): void {
  registerPingTool(server, deps);
  registerWebSearchTool(server, deps);
  registerFetchPageTool(server, deps);
  registerBrowseTaskTool(server, deps);
  registerSearchFlightsTool(server, deps);
  registerSocialSearchTool(server, deps);
  registerSearchHotelsTool(server, deps);
  registerSearchReviewsTool(server, deps);
  registerMarketQuoteTool(server, deps);
  registerWeatherTool(server, deps);
  registerExchangeRateTool(server, deps);
  registerDeepResearchTool(server, deps);
  registerAccountsTool(server, deps);
  registerHealthTool(server, deps, TOOL_NAMES);
}
