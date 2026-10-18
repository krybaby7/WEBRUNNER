import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Config } from "../../../src/config.js";
import type { Logger } from "../../../src/log.js";
import { FetchServiceError, type FetchService } from "../../../src/core/fetch/index.js";
import type { LlmClient, LlmRequest, LlmResponse, Role } from "../../../src/core/llm/types.js";
import type { SearchService } from "../../../src/core/search/index.js";
import type { ResearchDeps } from "../../../src/core/research/types.js";
import type { FetchPageInput, FetchPageOutput } from "../../../src/schemas/fetch_page.js";
import type { WebSearchInput, WebSearchOutput, WebSearchResult } from "../../../src/schemas/web_search.js";
import { makeConfig } from "../llm/helpers.js";

export { makeConfig };

const FIXTURES = new URL("../../fixtures/research/", import.meta.url);

export interface PoolResult {
  url: string;
  title: string;
  snippet: string;
  published_at?: string;
}

/** The fixture search results: six real pages and two spam results. */
export const searchPool: PoolResult[] = (
  JSON.parse(readFileSync(new URL("search-results.json", FIXTURES), "utf8")) as { results: PoolResult[] }
).results;

export function pageUrl(n: number): string {
  return `https://example.org/page-${n}`;
}

export function pageResult(n: number): PoolResult {
  const found = searchPool.find((r) => r.url === pageUrl(n));
  if (found === undefined) throw new Error(`no fixture result for page ${n}`);
  return found;
}

export function pageMarkdown(n: number): string {
  return readFileSync(new URL(`pages/page-${n}.md`, FIXTURES), "utf8");
}

// ---------------------------------------------------------------------------
// Scripted LLM
// ---------------------------------------------------------------------------

export type Responder = (req: LlmRequest, callIndex: number) => unknown;
/** A list is consumed in order (each item a value or a responder); a function answers every call. */
export type Script = unknown[] | Responder;

export interface LlmScript {
  planner?: Script;
  scorer?: Script;
  extractor?: Script;
  writer?: Script;
  /** Cost recorded on the request's meter for every call. Default 0. */
  costPerCall?: number;
  /** Return an error to throw instead of answering. Runs after the meter check, like a provider error. */
  failures?: (role: Role, callIndex: number, req: LlmRequest) => Error | undefined;
}

export interface RecordedLlm extends LlmClient {
  requests: LlmRequest[];
  byRole(role: Role): LlmRequest[];
}

export function userText(req: LlmRequest): string {
  const m = req.messages[0];
  if (m === undefined || typeof m.content !== "string") throw new Error("expected a single string user message");
  return m.content;
}

/** A client that answers from a script and records every request. It enforces the meter like the real client. */
export function scriptedLlm(script: LlmScript): RecordedLlm {
  const counts: Record<Role, number> = { planner: 0, scorer: 0, extractor: 0, writer: 0 };
  const requests: LlmRequest[] = [];
  return {
    requests,
    byRole: (role) => requests.filter((r) => r.role === role),
    async complete(req: LlmRequest): Promise<LlmResponse> {
      requests.push(req);
      req.meter?.check();
      // Calls in flight together all pass the meter check before any of them is billed.
      await Promise.resolve();
      // Quick depth writes with the extractor role; script it as the writer it is.
      const role: Role = req.role === "extractor" && userText(req).includes("<notes>") ? "writer" : req.role;
      const n = counts[role]++;
      const failure = script.failures?.(role, n, req);
      if (failure !== undefined) throw failure;
      const s = script[role];
      if (s === undefined) throw new Error(`no scripted ${role} responder`);
      let raw: unknown;
      if (typeof s === "function") raw = s(req, n);
      else {
        if (n >= s.length) throw new Error(`scripted ${role} responses exhausted at call ${n + 1}`);
        const item = s[n];
        raw = typeof item === "function" ? (item as Responder)(req, n) : item;
      }
      const parsed = req.schema !== undefined ? req.schema.parse(raw) : raw;
      const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const cost = script.costPerCall ?? 0;
      req.meter?.record(usage, cost);
      return { parsed, usage, costUsd: cost, model: "scripted", stopReason: "end_turn" };
    },
  };
}

export function plan(queries: string[], opts: { stop?: boolean; gaps?: string[] } = {}): unknown {
  return {
    steps: queries.map((query) => ({ query, rationale: `because ${query}` })),
    stop: opts.stop ?? false,
    gaps: opts.gaps ?? ["an open gap"],
  };
}

interface ParsedCandidate {
  index: number;
  title: string;
  url: string;
}

export function candidatesIn(req: LlmRequest): ParsedCandidate[] {
  return [...userText(req).matchAll(/^#(\d+) \| (.*?) \| (\S+) \|/gm)].map((m) => ({
    index: Number(m[1]),
    title: m[2] ?? "",
    url: m[3] ?? "",
  }));
}

export function scoreWith(fn: (c: ParsedCandidate) => number): Responder {
  return (req) => ({
    scores: candidatesIn(req).map((c) => ({ index: c.index, score: fn(c), reason: "scripted" })),
  });
}

/** Spam scores 1, everything else 8. */
export const defaultScorer: Responder = scoreWith((c) => (c.title.startsWith("SPAM") ? 1 : 8));

/** Claims are the page's bullet lines, quotes are those same lines. */
export const defaultExtractor: Responder = (req) => {
  const text = userText(req);
  const page = /<page>\n([\s\S]*?)\n<\/page>/.exec(text)?.[1] ?? "";
  const claims = [...page.matchAll(/^- (.+)$/gm)].map((m) => ({
    text: m[1] ?? "",
    quote: m[1] ?? "",
    confidence: "high" as const,
  }));
  const published = /^Published: (\S+)$/m.exec(page)?.[1] ?? null;
  return { relevance: 8, published_at: published, claims };
};

export interface WriterNote {
  id: number;
  url: string;
  title: string;
  quote: string | null;
}

export function notesIn(req: LlmRequest): WriterNote[] {
  const text = userText(req);
  const block = /<notes>\n([\s\S]*?)\n<\/notes>/.exec(text)?.[1] ?? "";
  return block.split(/\n\n(?=\[\d+\] )/).flatMap((chunk) => {
    const head = /^\[(\d+)\] (.*)\nURL: (\S+)/.exec(chunk);
    if (head === null) return [];
    return [{ id: Number(head[1]), title: head[2] ?? "", url: head[3] ?? "", quote: /Quote: "(.*)"/.exec(chunk)?.[1] ?? null }];
  });
}

/** Cites every note, in reverse id order so that renumbering has work to do. */
export const defaultWriter: Responder = (req) => {
  const notes = notesIn(req);
  const reversed = [...notes].reverse();
  return {
    report_markdown: [
      "# Report",
      "",
      ...reversed.map((n) => `Statement about ${n.title}. [${n.id}]`),
      "",
      "## Gaps",
      "",
      "- Something remains unresolved.",
      "",
    ].join("\n"),
    findings: reversed.map((n) => ({
      claim: `Finding from ${n.title}`,
      confidence: "high" as const,
      source_ids: [n.id],
      quote: n.quote,
    })),
    source_notes: notes.map((n) => ({ source_id: n.id, used_for: `Supports the statement about ${n.title}.` })),
    gaps: ["Something remains unresolved."],
  };
};

// ---------------------------------------------------------------------------
// Fake search and fetch
// ---------------------------------------------------------------------------

export interface FakeSearch extends SearchService {
  calls: WebSearchInput[];
  search: ReturnType<typeof vi.fn<(input: WebSearchInput) => Promise<WebSearchOutput>>>;
}

/** `rows` may throw to simulate a failing provider. */
export function fakeSearch(rows: (query: string, callIndex: number) => PoolResult[] = () => searchPool): FakeSearch {
  const calls: WebSearchInput[] = [];
  const search = vi.fn(async (input: WebSearchInput): Promise<WebSearchOutput> => {
    const callIndex = calls.length;
    calls.push(input);
    const results: WebSearchResult[] = rows(input.query, callIndex).map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      ...(r.published_at !== undefined && { published_at: r.published_at }),
      providers: ["fake"],
      score: 1 / (i + 1),
    }));
    return {
      query: input.query,
      results,
      providers_used: ["fake"],
      providers_failed: [],
      cached: false,
      latency_ms: 1,
    };
  });
  return { calls, search };
}

export interface FakeFetch extends FetchService {
  calls: FetchPageInput[];
  fetchPage: ReturnType<typeof vi.fn<(input: FetchPageInput) => Promise<FetchPageOutput>>>;
}

/** Serves the fixture pages; any other URL gets a small generic page. */
export function fakeFetch(opts: { fail?: (url: string) => Error | undefined } = {}): FakeFetch {
  const calls: FetchPageInput[] = [];
  const fetchPage = vi.fn(async (input: FetchPageInput): Promise<FetchPageOutput> => {
    calls.push(input);
    const failure = opts.fail?.(input.url);
    if (failure !== undefined) throw failure;
    const n = /\/page-(\d+)$/.exec(input.url)?.[1];
    const markdown =
      n !== undefined
        ? pageMarkdown(Number(n))
        : `# Generic page\n\n- First fact about ${input.url}.\n- Second fact about ${input.url}.\n`;
    return {
      url: input.url,
      final_url: input.url,
      title: /^# (.+)$/m.exec(markdown)?.[1] ?? "Untitled",
      markdown,
      truncated: false,
      method: "direct",
      fetched_at: "2026-10-18T09:00:00.000Z",
      cached: false,
    };
  });
  return { calls, fetchPage };
}

export function blocked(message = "blocked by site"): FetchServiceError {
  return new FetchServiceError({ code: "blocked", message, retryable: false });
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

export function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, msg, ...(fields !== undefined && { fields }) });
    };
  return { logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

export interface TestRig {
  deps: ResearchDeps;
  llm: RecordedLlm;
  search: FakeSearch;
  fetch: FakeFetch;
  lines: LogLine[];
}

/** One search query per round, each answering with the fixture page of that number: queries "q-1", "q-2", ... */
export function pageByQuery(query: string): PoolResult[] {
  const n = /^q-(\d+)$/.exec(query)?.[1];
  return n === undefined ? [] : [pageResult(Number(n))];
}

export function makeRig(
  script: Partial<LlmScript> = {},
  over: {
    search?: FakeSearch;
    fetch?: FakeFetch;
    config?: Partial<Config>;
    now?: () => number;
  } = {},
): TestRig {
  const llm = scriptedLlm({ scorer: defaultScorer, extractor: defaultExtractor, writer: defaultWriter, ...script });
  const search = over.search ?? fakeSearch();
  const fetch = over.fetch ?? fakeFetch();
  const { logger, lines } = recordingLogger();
  const deps: ResearchDeps = {
    search,
    fetch,
    llm,
    log: logger,
    config: makeConfig(over.config),
    ...(over.now !== undefined && { now: over.now }),
  };
  return { deps, llm, search, fetch, lines };
}
