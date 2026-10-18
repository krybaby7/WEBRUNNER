import { z } from "zod";
import type { ProviderOptions, RawResult, SearchProvider, SearchQuery } from "../types.js";
import {
  absoluteUrl,
  clamp,
  finalize,
  hasKey,
  notConfigured,
  parseBody,
  RECENCY_MS,
  requestJson,
  stripTrailingSlash,
} from "./shared.js";

/**
 * Exa Search API.
 * Docs: https://exa.ai/docs/reference/search
 *
 * Parameter mapping (all native, no client-side filtering):
 * - maxResults     -> `numResults` (1 to 100).
 * - recency        -> `startPublishedDate`, an ISO 8601 timestamp computed as
 *   now minus the window (day=24h, week=7d, month=31d, year=365d). Exa has no
 *   relative-window parameter.
 * - includeDomains -> `includeDomains`; excludeDomains -> `excludeDomains`.
 *
 * Snippets: the search is asked for `contents.highlights`; the snippet is the
 * highlights joined with spaces, falling back to `summary`, then to the first
 * 500 characters of `text` when the API returned those instead.
 * Dates: `publishedDate` (documented as YYYY-MM-DD, schema says date-time).
 */

const DEFAULT_BASE_URL = "https://api.exa.ai";
const PATH = "/search";
const HIGHLIGHT_CHARS = 1000;
const TEXT_FALLBACK_CHARS = 500;

const ExaResult = z.object({
  title: z.string().nullish(),
  url: absoluteUrl,
  publishedDate: z.unknown().optional(),
  highlights: z.array(z.string()).nullish(),
  summary: z.string().nullish(),
  text: z.string().nullish(),
});

const ExaResponse = z.object({ results: z.array(ExaResult) });

function snippetOf(r: z.infer<typeof ExaResult>): string {
  const highlights = (r.highlights ?? []).map((h) => h.trim()).filter((h) => h !== "");
  if (highlights.length > 0) return highlights.join(" ");
  if (r.summary !== null && r.summary !== undefined && r.summary.trim() !== "") return r.summary.trim();
  return (r.text ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_FALLBACK_CHARS);
}

export interface ExaOptions extends ProviderOptions {
  /** Clock for the recency cutoff. Injected in tests. */
  now?: () => number;
}

export class ExaProvider implements SearchProvider {
  readonly name = "exa" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: ExaOptions = {}) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.now = opts.now ?? Date.now;
  }

  isConfigured(): boolean {
    return hasKey(this.apiKey);
  }

  async search(q: SearchQuery, signal: AbortSignal): Promise<RawResult[]> {
    if (!hasKey(this.apiKey)) throw notConfigured(this.name);

    const payload: Record<string, unknown> = {
      query: q.query,
      type: "auto",
      numResults: clamp(q.maxResults, 1, 100),
      contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
    };
    if (q.recency !== undefined) {
      payload["startPublishedDate"] = new Date(this.now() - RECENCY_MS[q.recency]).toISOString();
    }
    if (q.includeDomains !== undefined && q.includeDomains.length > 0) payload["includeDomains"] = q.includeDomains;
    if (q.excludeDomains !== undefined && q.excludeDomains.length > 0) payload["excludeDomains"] = q.excludeDomains;

    const body = await requestJson({
      provider: this.name,
      url: `${this.baseUrl}${PATH}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": this.apiKey as string },
        body: JSON.stringify(payload),
      },
      fetchImpl: this.fetchImpl,
      signal,
    });
    const parsed = parseBody(this.name, ExaResponse, body);

    const items = parsed.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: snippetOf(r),
      date: r.publishedDate,
    }));
    return finalize(items, q.maxResults);
  }
}
