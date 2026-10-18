import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "./deps.js";
import { registerTools } from "./tools/index.js";

const SERVER_NAME = "webrunner";

/** Package version, read from package.json (one directory above src/ and dist/). */
export function getVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = z.object({ version: z.string() }).parse(JSON.parse(raw));
  return parsed.version;
}

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: getVersion() });
  registerTools(server, deps);
  return server;
}
