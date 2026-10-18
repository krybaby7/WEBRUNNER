import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "../../../src/core/llm/types.js";
import { ResearchError } from "../../../src/core/research/index.js";
import type { ResearchDeps } from "../../../src/core/research/types.js";
import type { Deps } from "../../../src/deps.js";
import { DeepResearchResultSchema, type DeepResearchInput, type DeepResearchResult } from "../../../src/schemas/deep_research.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { registerDeepResearchTool, type DeepResearchRunner } from "../../../src/tools/deep_research.js";
import { registerTools } from "../../../src/tools/index.js";
import { makeConfig } from "../llm/helpers.js";
import { fakeFetch, fakeSearch, recordingLogger, scriptedLlm, type LogLine } from "./helpers.js";

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

const QUESTION = "What is the airspeed velocity of an unladen swallow, and who asked?";

const RESULT: DeepResearchResult = {
  question: QUESTION,
  report_markdown: "# Swallows\n\nAn unladen European swallow flies at roughly 11 m/s [1].\n\n## Gaps\n\n- African swallows were not covered.\n",
  findings: [
    { claim: "An unladen European swallow flies at roughly 11 m/s.", confidence: "medium", source_ids: [1], quote: "about 11 metres per second" },
  ],
  sources: [
    {
      id: 1,
      url: "https://example.org/swallows",
      title: "Swallow flight speeds",
      accessed_at: "2026-10-18T09:00:00.000Z",
      published_at: "2025-03-01T00:00:00.000Z",
      used_for: "The flight speed.",
    },
  ],
  gaps: ["African swallows were not covered."],
  depth: "standard",
  stats: {
    searches: 5,
    pages_read: 7,
    pages_failed: 1,
    iterations: 2,
    input_tokens: 40_000,
    output_tokens: 5_000,
    cost_usd: 0.42,
    elapsed_ms: 12_345,
    stopped_reason: "converged",
  },
};

interface Harness {
  client: Client;
  lines: LogLine[];
  runner: ReturnType<typeof vi.fn<DeepResearchRunner>>;
  deps: Deps;
}

async function connect(
  impl: DeepResearchRunner,
  patch: (deps: Deps) => Deps = (d) => d,
  configPatch: Parameters<typeof makeConfig>[0] = {},
): Promise<Harness> {
  const { logger, lines } = recordingLogger();
  const deps = patch({
    config: makeConfig(configPatch),
    log: logger,
    search: fakeSearch(),
    fetch: fakeFetch(),
    llm: scriptedLlm({}),
  });
  const runner = vi.fn<DeepResearchRunner>(impl);
  const server = new McpServer({ name: "test", version: "0" });
  registerDeepResearchTool(server, deps, runner);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, lines, runner, deps };
}

function envelope(result: unknown): ReturnType<typeof ErrorEnvelopeSchema.parse> {
  const r = result as { isError?: boolean; structuredContent?: unknown; content: Array<{ text: string }> };
  expect(r.isError).toBe(true);
  const parsed = ErrorEnvelopeSchema.parse(r.structuredContent);
  expect(JSON.parse(r.content[0]?.text ?? "{}")).toEqual(parsed);
  return parsed;
}

describe("deep_research tool", () => {
  it("is listed with read-only annotations, both schemas and a description of depths, cap, gaps and stopped_reason", async () => {
    const { client } = await connect(async () => RESULT);
    const tool = (await client.listTools()).tools.find((t) => t.name === "deep_research");
    expect(tool).toBeDefined();
    const d = tool?.description ?? "";
    expect(d).toMatch(/citation/i);
    for (const depth of ["quick", "standard", "deep"]) expect(d).toContain(depth);
    expect(d).toContain("$0.10 to $0.30");
    expect(d).toContain("$0.50 to $1.50");
    expect(d).toContain("$1.50 to $4.00");
    expect(d).toMatch(/max_cost_usd is a hard cap/);
    expect(d).toMatch(/Gaps section/);
    expect(d).toContain("stats.stopped_reason");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    const props = (tool?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(
      ["depth", "exclude_domains", "focus_domains", "max_cost_usd", "output", "question", "recency"].sort(),
    );
    expect(tool?.inputSchema.required).toEqual(["question"]);
    expect(tool?.outputSchema).toBeDefined();
  });

  it("is wired into registerTools", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerTools(server, { config: makeConfig(), log: recordingLogger().logger });
    const client = new Client({ name: "c", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("deep_research");
  });

  it("returns the result as text and structuredContent, and hands the runner the services and the parsed input", async () => {
    const h = await connect(async () => RESULT);
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(res.isError).toBeFalsy();
    expect(DeepResearchResultSchema.parse(res.structuredContent)).toEqual(RESULT);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0]?.text ?? "{}")).toEqual(RESULT);

    expect(h.runner).toHaveBeenCalledTimes(1);
    const [input, deps] = h.runner.mock.calls[0] as [DeepResearchInput, ResearchDeps];
    expect(input).toMatchObject({ question: QUESTION, depth: "standard", output: "report" });
    expect(deps.search).toBe(h.deps.search);
    expect(deps.fetch).toBe(h.deps.fetch);
    expect(deps.llm).toBe(h.deps.llm);
    expect(deps.log).toBe(h.deps.log);
    expect(deps.config).toBe(h.deps.config);
  });

  it("logs one info line at start and one at the end, never the question text at info", async () => {
    const h = await connect(async () => RESULT);
    await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION, depth: "quick", max_cost_usd: 0.5 } });

    const info = h.lines.filter((l) => l.level === "info");
    expect(info.map((l) => l.msg)).toEqual(["deep_research started", "deep_research finished"]);
    expect(info[0]?.fields).toEqual({ question_chars: QUESTION.length, depth: "quick", max_cost_usd: 0.5 });
    expect(info[1]?.fields).toMatchObject({ stopped_reason: "converged", cost_usd: 0.42 });
    expect(typeof info[1]?.fields?.["elapsed_ms"]).toBe("number");

    const infoAndAbove = h.lines.filter((l) => l.level !== "debug");
    expect(JSON.stringify(infoAndAbove)).not.toContain(QUESTION);
    // Debug may carry it.
    expect(h.lines.some((l) => l.level === "debug" && JSON.stringify(l.fields).includes(QUESTION))).toBe(true);
  });

  it("logs the configured default cap when max_cost_usd is not given", async () => {
    const h = await connect(async () => RESULT, undefined, { research_max_cost_usd: 1.25 });
    await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(h.lines.find((l) => l.msg === "deep_research started")?.fields).toMatchObject({ depth: "standard", max_cost_usd: 1.25 });
  });

  it("maps ResearchError budget_exceeded to the envelope with retryable false", async () => {
    const h = await connect(async () => {
      throw new ResearchError("budget_exceeded", "The cost cap of $0.05 was reached before any source was read.", false, { cap_usd: 0.05 });
    });
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(envelope(res).error).toEqual({
      code: "budget_exceeded",
      message: "The cost cap of $0.05 was reached before any source was read.",
      retryable: false,
      details: { cap_usd: 0.05 },
    });
  });

  it("maps other ResearchError codes and keeps retryable and details", async () => {
    const h = await connect(async () => {
      throw new ResearchError("provider", "all search providers failed", true, { kind: "api" });
    });
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(envelope(res).error).toMatchObject({ code: "provider", retryable: true, details: { kind: "api" } });

    const h2 = await connect(async () => {
      throw new ResearchError("invalid_input", "Invalid deep_research input: question: too small", false, { issues: [] });
    });
    const res2 = await h2.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(envelope(res2).error).toMatchObject({ code: "invalid_input", retryable: false });
  });

  it("maps LlmError the same way", async () => {
    const h = await connect(async () => {
      throw new LlmError("budget_exceeded", "api", "The per-call cost cap was reached", { retryable: false, details: { spent: 3 } });
    });
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(envelope(res).error).toEqual({
      code: "budget_exceeded",
      message: "The per-call cost cap was reached",
      retryable: false,
      details: { spent: 3 },
    });
  });

  it("maps any other error to internal with the message and no stack", async () => {
    const h = await connect(async () => {
      throw new TypeError("cannot read properties of undefined\n    at secretFunction (/home/me/src/x.ts:1:1)");
    });
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    const env = envelope(res);
    expect(env.error.code).toBe("internal");
    expect(env.error.retryable).toBe(false);
    expect(env.error.message).toContain("cannot read properties of undefined");
    expect(JSON.stringify(env)).not.toContain("secretFunction");
    expect(JSON.stringify(env)).not.toContain("\\n    at ");
  });

  it("returns config naming ANTHROPIC_API_KEY when the key is unset, without calling the runner", async () => {
    const h = await connect(
      async () => RESULT,
      (d) => {
        const { anthropic_api_key: _drop, ...rest } = d.config;
        return { ...d, config: rest };
      },
    );
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    const env = envelope(res);
    expect(env.error.code).toBe("config");
    expect(env.error.message).toContain("ANTHROPIC_API_KEY");
    expect(env.error.retryable).toBe(false);
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.lines.filter((l) => l.level === "info")).toHaveLength(0);
  });

  it.each(["search", "fetch", "llm"] as const)("returns internal when deps.%s is missing", async (missing) => {
    const h = await connect(async () => RESULT, (d) => {
      const copy = { ...d };
      delete copy[missing];
      return copy;
    });
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(envelope(res).error).toMatchObject({ code: "internal", retryable: false });
    expect(h.runner).not.toHaveBeenCalled();
  });

  it("checks the key before the services, so a keyless server says config", async () => {
    const h = await connect(
      async () => RESULT,
      (d) => {
        const { anthropic_api_key: _drop, ...config } = d.config;
        const { search: _s, ...rest } = d;
        return { ...rest, config };
      },
    );
    const res = await h.client.callTool({ name: "deep_research", arguments: { question: QUESTION } });
    expect(envelope(res).error.code).toBe("config");
  });
});
