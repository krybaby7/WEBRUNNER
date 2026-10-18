import type { Config } from "../../config.js";
import type { Logger } from "../../log.js";
import type { Confidence } from "../../schemas/deep_research.js";
import type { FetchService } from "../fetch/index.js";
import type { LlmClient } from "../llm/types.js";
import type { SearchService } from "../search/index.js";

/** Everything the research engine needs, PLAN.md 3.3. */
export interface ResearchDeps {
  search: SearchService;
  fetch: FetchService;
  llm: LlmClient;
  log: Logger;
  config: Config;
  /** Clock in epoch milliseconds, used for `elapsed_ms`. Default Date.now. */
  now?: () => number;
}

export interface NoteClaim {
  text: string;
  /** Verbatim text from the page, at most 300 characters. */
  quote: string;
  confidence: Confidence;
}

/**
 * What the extractor distilled from one page. Raw pages never reach the
 * writer, only notes. `source_id` is provisional: unique within a run, assigned
 * in read order. Final ids are assigned after the writer returns, in
 * first-citation order (see `renumberCitations`).
 */
export interface Note {
  source_id: number;
  url: string;
  title: string;
  /** ISO 8601 UTC. From the page when it states a date, else from the search result. */
  published_at?: string;
  /** ISO 8601 UTC of the fetch. */
  accessed_at: string;
  /** 0 to 10, how relevant the page is to the question. */
  relevance: number;
  claims: NoteClaim[];
}

/** A search result that might be worth reading. */
export interface Candidate {
  /** Canonical URL. */
  url: string;
  title: string;
  snippet: string;
  published_at?: string;
  /** Scorer output, 0 to 10. Absent until scored. */
  score?: number;
  reason?: string;
}

/** One sub-query from the planner. */
export interface PlanStep {
  query: string;
  rationale: string;
}

export type ResearchErrorCode = "config" | "provider" | "timeout" | "budget_exceeded" | "internal";

/**
 * Thrown by `runResearch` when no result can be produced. `code` maps onto the
 * error envelope (PLAN.md 3.6). Running out of budget is not an error as long
 * as there is something to report: the result carries `stopped_reason: "budget"`.
 */
export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ResearchErrorCode, message: string, retryable: boolean, details?: unknown) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}
