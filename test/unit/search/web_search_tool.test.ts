import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../src/config.js";
import { createCache } from "../../../src/core/cache/index.js";
import { createSearchService, type SearchService } from "../../../src/core/search/index.js";
import {
  ProviderError,
  type RawResult,
  type SearchProvider,
  type SearchProviderName,
} from "../../../src/core/search/types.js";
import type { Deps } from "../../../src/deps.js";
import type { Logger } from "../../../src/log.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { WebSearchOutputSchema } from "../../../src/schemas/web_search.js";
import { registerTools } from "../../../src/tools/index.js";
import { registerWebSearchTool } from "../../../src/tools/web_search.js";

let dir: string;
let log: Logger;
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-tool-"));
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
  rmSync(dir, { recursive: true, force: true });
});

function provider(name: SearchProviderName, impl: () => Promise<RawResult[]>): SearchProvider {
  return { name, isConfigured: () => true, search: impl };
}

const rawA: RawResult[] = [
  { url: "https://www.a.com/x?utm_source=n", title: "A", snippet: "from brave", rank: 1 },
  { url: "https://b.com/y", title: "B", snippet: "b", rank: 2 },
];
const rawB: RawResult[] = [{ url: "https://a.com/x", title: "A longer", snippet: "from exa, longer", rank: 1 }];

async function connect(search: SearchService | undefined, register = true): Promise<Client> {
  const deps: Deps = { config: {} as Config, log, ...(search !== undefined && { search }) };
  const server = new McpServer({ name: "test", version: "0" });
  if (register) registerWebSearchTool(server, deps);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("web_search tool", () => {
  it("is listed with a description and schemas", async () => {
    const client = await connect(createSearchService({ providers: [], cache: createCache(dir), log }));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "web_search");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/several/i);
    expect(tool?.description).toMatch(/merged/i);
    expect(tool?.description).toMatch(/fewer/i);
    const props = (tool?.inputSchema as { properties: Record<string, { default?: unknown }>; required?: string[] }).properties;
    expect(Object.keys(props).sort()).toEqual(
      ["exclude_domains", "include_domains", "max_results", "providers", "query", "recency"].sort(),
    );
    expect(props["max_results"]?.default).toBe(10);
    expect(tool?.inputSchema.required).toEqual(["query"]);
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
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ping", "web_search"]));
  });

  it("returns the fused output as text and structuredContent", async () => {
    const svc = createSearchService({
      providers: [provider("brave", () => Promise.resolve(rawA)), provider("exa", () => Promise.resolve(rawB))],
      cache: createCache(dir),
      log,
    });
    const client = await connect(svc);
    const res = await client.callTool({ name: "web_search", arguments: { query: "hello" } });

    expect(res.isError).toBeFalsy();
    const structured = WebSearchOutputSchema.parse(res.structuredContent);
    expect(structured.query).toBe("hello");
    expect(structured.cached).toBe(false);
    expect(structured.providers_used).toEqual(["brave", "exa"]);
    expect(structured.providers_failed).toEqual([]);
    expect(structured.results[0]).toMatchObject({
      url: "https://a.com/x",
      title: "A longer",
      snippet: "from exa, longer",
      providers: ["brave", "exa"],
    });
    expect(structured.results[1]?.url).toBe("https://b.com/y");

    const content = res.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(structured);
  });

  it("reports partial failure in providers_failed without an error", async () => {
    const svc = createSearchService({
      providers: [
        provider("brave", () => Promise.reject(new ProviderError({ provider: "brave", message: "nope", retryable: true }))),
        provider("exa", () => Promise.resolve(rawB)),
      ],
      cache: createCache(dir),
      log,
    });
    const client = await connect(svc);
    const res = await client.callTool({ name: "web_search", arguments: { query: "q", max_results: 5 } });
    expect(res.isError).toBeFalsy();
    const out = WebSearchOutputSchema.parse(res.structuredContent);
    expect(out.providers_failed).toEqual([{ provider: "brave", error: "nope" }]);
    expect(out.results).toHaveLength(1);
  });

  it("a second identical call is served from the cache", async () => {
    const brave = provider("brave", vi.fn(() => Promise.resolve(rawA)));
    const client = await connect(createSearchService({ providers: [brave], cache: createCache(dir), log }));
    await client.callTool({ name: "web_search", arguments: { query: "q" } });
    const res = await client.callTool({ name: "web_search", arguments: { query: "q" } });
    expect(WebSearchOutputSchema.parse(res.structuredContent).cached).toBe(true);
    expect(brave.search).toHaveBeenCalledTimes(1);
  });

  it("returns a provider error envelope with providers_failed when every provider fails", async () => {
    const svc = createSearchService({
      providers: [
        provider("brave", () =>
          Promise.reject(new ProviderError({ provider: "brave", message: "brave returned HTTP 503", status: 503, retryable: true })),
        ),
        provider("exa", () =>
          Promise.reject(new ProviderError({ provider: "exa", message: "exa returned HTTP 401", status: 401, retryable: false })),
        ),
      ],
      cache: createCache(dir),
      log,
    });
    const client = await connect(svc);
    const res = await client.callTool({ name: "web_search", arguments: { query: "q" } });
    expect(res.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(res.structuredContent);
    expect(envelope.error.code).toBe("provider");
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.details).toEqual({
      providers_failed: [
        { provider: "brave", error: "brave returned HTTP 503" },
        { provider: "exa", error: "exa returned HTTP 401" },
      ],
    });
    const content = res.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(envelope);
  });

  it("returns a timeout envelope when every provider times out", async () => {
    const svc = createSearchService({
      providers: [provider("brave", () => new Promise<RawResult[]>(() => undefined))],
      cache: createCache(dir),
      log,
      timeoutMs: 50,
    });
    const client = await connect(svc);
    const res = await client.callTool({ name: "web_search", arguments: { query: "q" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error).toMatchObject({ code: "timeout", retryable: true });
  });

  it("returns a config envelope when no provider is configured", async () => {
    const client = await connect(createSearchService({ providers: [], cache: createCache(dir), log }));
    const res = await client.callTool({ name: "web_search", arguments: { query: "q" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error).toMatchObject({ code: "config", retryable: false });
  });

  it("returns an internal envelope, without a stack, on an unexpected error", async () => {
    const search: SearchService = {
      search: () => Promise.reject(new Error("kaboom\n    at secret.ts:1:1")),
    };
    const client = await connect(search);
    const res = await client.callTool({ name: "web_search", arguments: { query: "q" } });
    expect(res.isError).toBe(true);
    const err = ErrorEnvelopeSchema.parse(res.structuredContent).error;
    expect(err.code).toBe("internal");
    expect(err.message).toContain("kaboom");
    expect(err.details).toBeUndefined();
  });

  it("returns an internal envelope when deps.search is missing", async () => {
    const client = await connect(undefined);
    const res = await client.callTool({ name: "web_search", arguments: { query: "q" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error.code).toBe("internal");
  });

  it("rejects invalid input (max_results over 30, empty query, unknown provider)", async () => {
    const search: SearchService = { search: vi.fn(() => Promise.reject(new Error("should not run"))) };
    const client = await connect(search);
    for (const args of [{ query: "q", max_results: 31 }, { query: "" }, { query: "q", providers: ["bing"] }, {}]) {
      const res = await client.callTool({ name: "web_search", arguments: args }).catch((e: unknown) => e);
      const rejected = res instanceof Error || (res as { isError?: boolean }).isError === true;
      expect(rejected).toBe(true);
    }
    expect(search.search).not.toHaveBeenCalled();
  });

  it("applies the max_results default of 10 before calling the service", async () => {
    const spy = vi.fn((): Promise<never> => Promise.reject(new Error("x")));
    const client = await connect({ search: spy });
    await client.callTool({ name: "web_search", arguments: { query: "  padded  " } });
    expect(spy).toHaveBeenCalledWith({ query: "padded", max_results: 10 });
  });
});
