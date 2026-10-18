import { z } from "zod";
import type { ProviderOptions, RawResult, SearchProvider, SearchQuery } from "../types.js";
import {
  absoluteUrl,
  bareDomain,
  clamp,
  finalize,
  hasKey,
  notConfigured,
  parseBody,
  requestJson,
  stripTrailingSlash,
} from "./shared.js";

/**
 * Perplexity Search API (POST /search, the raw ranked-results API; NOT the
 * Sonar chat completions API).
 * Docs: https://docs.perplexity.ai/api-reference/search-post
 *       https://docs.perplexity.ai/docs/search/filters/domain-filter
 *
 * Auth: `Authorization: Bearer <key>`.
 *
 * Parameter mapping:
 * - maxResults -> `max_results` (web search supports 1 to 20).
 * - recency    -> `search_recency_filter` (day, week, month, year).
 * - domains    -> `search_domain_filter`, a single list that is EITHER an
 *   allowlist (bare domains) OR a denylist (each entry prefixed with "-"),
 *   never both, max 20 entries. When only one kind is requested it is sent
 *   natively. When BOTH include and exclude are requested, the allowlist is
 *   sent natively and the exclusions are applied CLIENT-SIDE, which can leave
 *   fewer than maxResults results. Entries beyond the 20-entry cap are dropped
 *   from the native list; includes are then also enforced client-side so a
 *   truncated allowlist cannot widen the result set.
 *
 * Snippet is `snippet`; date is `date` (YYYY-MM-DD); `last_updated` is ignored.
 */

const DEFAULT_BASE_URL = "https://api.perplexity.ai";
const PATH = "/search";
const MAX_RESULTS = 20;
const MAX_DOMAIN_FILTER = 20;

const PerplexityResult = z.object({
  title: z.string().nullish(),
  url: absoluteUrl,
  snippet: z.string().nullish(),
  date: z.unknown().optional(),
});

const PerplexityResponse = z.object({ results: z.array(PerplexityResult) });

export class PerplexityProvider implements SearchProvider {
  readonly name = "perplexity" as const;
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

    const include = (q.includeDomains ?? []).map(bareDomain).filter((d) => d !== "");
    const exclude = (q.excludeDomains ?? []).map(bareDomain).filter((d) => d !== "");

    const payload: Record<string, unknown> = {
      query: q.query,
      max_results: clamp(q.maxResults, 1, MAX_RESULTS),
    };
    if (q.recency !== undefined) payload["search_recency_filter"] = q.recency;
    let clientExclude: string[] | undefined;
    if (include.length > 0) {
      payload["search_domain_filter"] = include.slice(0, MAX_DOMAIN_FILTER);
      if (exclude.length > 0) clientExclude = exclude;
    } else if (exclude.length > 0) {
      payload["search_domain_filter"] = exclude.slice(0, MAX_DOMAIN_FILTER).map((d) => `-${d}`);
      if (exclude.length > MAX_DOMAIN_FILTER) clientExclude = exclude;
    }

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
    const parsed = parseBody(this.name, PerplexityResponse, body);

    const items = parsed.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      date: r.date,
    }));
    const needsClientFilter = clientExclude !== undefined || include.length > MAX_DOMAIN_FILTER;
    return finalize(
      items,
      q.maxResults,
      needsClientFilter ? { include: include.length > 0 ? include : undefined, exclude: clientExclude } : undefined,
    );
  }
}
