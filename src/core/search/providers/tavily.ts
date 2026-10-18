import { z } from "zod";
import type { ProviderOptions, RawResult, SearchProvider, SearchQuery } from "../types.js";
import {
  absoluteUrl,
  clamp,
  finalize,
  hasKey,
  notConfigured,
  parseBody,
  requestJson,
  stripTrailingSlash,
} from "./shared.js";

/**
 * Tavily Search API.
 * Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
 *
 * Auth: `Authorization: Bearer <key>`.
 *
 * Parameter mapping (all native, no client-side filtering):
 * - maxResults     -> `max_results` (the API allows 0 to 20; we send 1 to 20, so
 *   a request for more than 20 returns at most 20).
 * - recency        -> `time_range` (day, week, month, year are accepted as-is).
 * - includeDomains -> `include_domains` (hard filter, the default mode);
 *   excludeDomains -> `exclude_domains`.
 *
 * `include_published_date` is always sent: without it (and outside the news
 * topic) Tavily omits `published_date`. Snippet is `content`.
 */

const DEFAULT_BASE_URL = "https://api.tavily.com";
const PATH = "/search";
const MAX_RESULTS = 20;

const TavilyResult = z.object({
  title: z.string().nullish(),
  url: absoluteUrl,
  content: z.string().nullish(),
  published_date: z.unknown().optional(),
});

const TavilyResponse = z.object({ results: z.array(TavilyResult) });

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: ProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
  }

  isConfigured(): boolean {
    return hasKey(this.apiKey);
  }

  async search(q: SearchQuery, signal: AbortSignal): Promise<RawResult[]> {
    if (!hasKey(this.apiKey)) throw notConfigured(this.name);

    const payload: Record<string, unknown> = {
      query: q.query,
      search_depth: "basic",
      topic: "general",
      max_results: clamp(q.maxResults, 1, MAX_RESULTS),
      include_published_date: true,
    };
    if (q.recency !== undefined) payload["time_range"] = q.recency;
    if (q.includeDomains !== undefined && q.includeDomains.length > 0) payload["include_domains"] = q.includeDomains;
    if (q.excludeDomains !== undefined && q.excludeDomains.length > 0) payload["exclude_domains"] = q.excludeDomains;

    const body = await requestJson({
      provider: this.name,
      url: `${this.baseUrl}${PATH}`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey as string}`,
        },
        body: JSON.stringify(payload),
      },
      fetchImpl: this.fetchImpl,
      signal,
    });
    const parsed = parseBody(this.name, TavilyResponse, body);

    const items = parsed.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
      date: r.published_date,
    }));
    return finalize(items, q.maxResults);
  }
}
