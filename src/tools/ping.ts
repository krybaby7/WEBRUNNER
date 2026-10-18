import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { jsonResult } from "../schemas/result.js";
import { getVersion } from "../server.js";

export function registerPingTool(server: McpServer, _deps: Deps): void {
  const version = getVersion();
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check. Returns ok, the server version and the current time.",
      outputSchema: {
        ok: z.literal(true),
        version: z.string(),
        time: z.string(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => jsonResult({ ok: true as const, version, time: new Date().toISOString() }),
  );
}
