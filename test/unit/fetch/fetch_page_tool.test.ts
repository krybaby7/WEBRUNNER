import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../src/config.js";
import { FetchServiceError, type FetchService } from "../../../src/core/fetch/index.js";
import type { Deps } from "../../../src/deps.js";
import type { Logger } from "../../../src/log.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { FetchPageOutputSchema, type FetchPageInput, type FetchPageOutput } from "../../../src/schemas/fetch_page.js";
import { registerTools } from "../../../src/tools/index.js";
import { registerFetchPageTool } from "../../../src/tools/fetch_page.js";

const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const OUTPUT: FetchPageOutput = {
  url: "https://example.com/",
  final_url: "https://example.com/",
  title: "Example Domain",
  markdown: "# Example Domain\n\nThis domain is for use in illustrative examples.",
  truncated: false,
  method: "direct",
  fetched_at: "2026-10-18T00:00:00.000Z",
  cached: false,
};

async function connect(fetchService: FetchService | undefined): Promise<Client> {
  const deps: Deps = { config: {} as Config, log, ...(fetchService !== undefined && { fetch: fetchService }) };
  const server = new McpServer({ name: "test", version: "0" });
  registerFetchPageTool(server, deps);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("fetch_page tool", () => {
  it("is listed with a description, read-only annotations and schemas", async () => {
    const client = await connect({ fetchPage: () => Promise.resolve(OUTPUT) });
    const tool = (await client.listTools()).tools.find((t) => t.name === "fetch_page");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/auto/);
    expect(tool?.description).toMatch(/browser/i);
    expect(tool?.description).toMatch(/bot wall/i);
    expect(tool?.description).toMatch(/PDF/);
    expect(tool?.description).toMatch(/cached/i);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    const props = (tool?.inputSchema as { properties: Record<string, { default?: unknown }> }).properties;
    expect(Object.keys(props).sort()).toEqual(["max_chars", "mode", "url", "wait_for"]);
    expect(props["mode"]?.default).toBe("auto");
    expect(props["max_chars"]?.default).toBe(40_000);
    expect(tool?.inputSchema.required).toEqual(["url"]);
    expect(tool?.outputSchema).toBeDefined();
  });

  it("is wired into registerTools", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerTools(server, { config: {} as Config, log });
    const client = new Client({ name: "c", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ping", "web_search", "fetch_page"]));
  });

  it("returns the page as text and structuredContent, with defaults applied", async () => {
    const seen: FetchPageInput[] = [];
    const client = await connect({
      fetchPage: (input) => {
        seen.push(input);
        return Promise.resolve(OUTPUT);
      },
    });
    const res = await client.callTool({ name: "fetch_page", arguments: { url: "https://example.com/" } });
    expect(res.isError).toBeFalsy();
    expect(FetchPageOutputSchema.parse(res.structuredContent)).toEqual(OUTPUT);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(OUTPUT);
    expect(seen[0]).toEqual({ url: "https://example.com/", mode: "auto", max_chars: 40_000 });
  });

  it("passes mode, max_chars and wait_for through", async () => {
    const seen: FetchPageInput[] = [];
    const client = await connect({
      fetchPage: (input) => {
        seen.push(input);
        return Promise.resolve(OUTPUT);
      },
    });
    await client.callTool({
      name: "fetch_page",
      arguments: { url: "https://example.com/", mode: "browser", max_chars: 2000, wait_for: ".quote" },
    });
    expect(seen[0]).toEqual({ url: "https://example.com/", mode: "browser", max_chars: 2000, wait_for: ".quote" });
  });

  it("rejects malformed input before the handler runs", async () => {
    const fetchPage = vi.fn(() => Promise.resolve(OUTPUT));
    const client = await connect({ fetchPage });
    for (const args of [
      { url: "not a url" },
      { url: "ftp://example.com/x" },
      { url: "https://example.com/", max_chars: 10 },
      { url: "https://example.com/", mode: "turbo" },
    ]) {
      const res = await client.callTool({ name: "fetch_page", arguments: args }).catch(() => ({ isError: true }));
      expect(res.isError).toBe(true);
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("maps a FetchServiceError onto the error envelope", async () => {
    const client = await connect({
      fetchPage: () =>
        Promise.reject(new FetchServiceError({ code: "blocked", message: "Bot wall on example.com", retryable: false, method: "browser" })),
    });
    const res = await client.callTool({ name: "fetch_page", arguments: { url: "https://example.com/" } });
    expect(res.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(res.structuredContent);
    expect(envelope.error).toEqual({
      code: "blocked",
      message: "Bot wall on example.com",
      retryable: false,
      details: { method: "browser" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(envelope);
  });

  it("maps an unexpected throw to internal without a stack trace", async () => {
    const client = await connect({ fetchPage: () => Promise.reject(new Error("kaboom")) });
    const res = await client.callTool({ name: "fetch_page", arguments: { url: "https://example.com/" } });
    expect(res.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(res.structuredContent);
    expect(envelope.error.code).toBe("internal");
    expect(envelope.error.message).toContain("kaboom");
    expect(envelope.error.message).not.toMatch(/\n\s+at /);
  });

  it("reports internal when the fetch service is missing", async () => {
    const client = await connect(undefined);
    const res = await client.callTool({ name: "fetch_page", arguments: { url: "https://example.com/" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error.code).toBe("internal");
  });
});
