import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_NAME = "webrunner";

/** Package version, read from package.json (one directory above src/ and dist/). */
export function getVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = z.object({ version: z.string() }).parse(JSON.parse(raw));
  return parsed.version;
}

export function buildServer(): McpServer {
  const version = getVersion();
  const server = new McpServer({ name: SERVER_NAME, version });

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
    () => {
      const result = { ok: true as const, version, time: new Date().toISOString() };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}
