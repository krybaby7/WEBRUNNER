import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserSession, BrowserSessionStats } from "../../../src/core/browser/types.js";

export interface Connected {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

/** Connect a client to a server over an in-memory transport after `register` has added tools. */
export async function connectServer(register: (server: McpServer) => void): Promise<Connected> {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** A BrowserSession that never launches anything. */
export function fakeBrowser(over: Partial<BrowserSessionStats> = {}, isOpen = false): BrowserSession {
  const stats: BrowserSessionStats = {
    mode: null,
    open: false,
    closed: false,
    headless: true,
    activePages: 0,
    waiting: 0,
    maxPages: 3,
    totalAcquired: 0,
    ...over,
  };
  return {
    acquire: () => Promise.reject(new Error("fakeBrowser: acquire is not available")),
    release: () => Promise.resolve(),
    close: () => Promise.resolve(),
    isOpen: () => isOpen,
    stats: () => stats,
    cookies: () => Promise.resolve([]),
    clearCookies: () => Promise.resolve(0),
    openUnpooledPage: () => Promise.reject(new Error("fakeBrowser: openUnpooledPage is not available")),
  };
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content: Array<{ type: string; text: string }>;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}
