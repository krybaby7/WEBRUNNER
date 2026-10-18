import { z } from "zod";
import { ProviderError, type ProviderOptions, type RawResult, type SearchProvider, type SearchQuery } from "../types.js";
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
 * Brave Web Search API.
 * Docs: https://api-dashboard.search.brave.com/app/documentation/web-search/query
 *       https://api-dashboard.search.brave.com/api-reference/web/search/get
 *
 * Parameter mapping:
 * - maxResults -> `count` (the API caps it at 20, so a request for more than 20
 *   returns at most 20; `offset` pagination is not used).
 * - recency    -> `freshness`: day=pd, week=pw, month=pm (31 days), year=py.
 * - domains    -> Brave has NO include/exclude parameter. The documented way is
 *   search operators inside `q`: `site:example.com` and `-site:example.com`.
 *   Operators are best-effort on Brave's side, so the result list is ALSO
 *   filtered client-side (hostname equals or is a subdomain of the domain).
 *   Client-side filtering can leave fewer than maxResults results.
 *
 * Dates: only `page_age` is used. `age` is a human string such as "2 days ago".
 * Snippets: `description` may carry inline markup such as <strong>; it is
 * stripped to plain text.
 */

const DEFAULT_BASE_URL = "https://api.search.brave.com";
const PATH = "/res/v1/web/search";
const MAX_COUNT = 20;

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

const BraveResult = z.object({
  title: z.string().nullish(),
  url: absoluteUrl,
  description: z.string().nullish(),
  page_age: z.unknown().optional(),
});

const BraveResponse = z.object({
  // `web` is absent when a query has no web results; `query` then identifies a genuine Brave body.
  web: z.object({ results: z.array(BraveResult) }).optional(),
  query: z.object({ original: z.string().optional() }).optional(),
});

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function plainText(s: string | null | undefined): string | null | undefined {
  if (s === null || s === undefined) return s;
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function buildBraveQuery(q: SearchQuery): string {
  const parts: string[] = [];
  const include = (q.includeDomains ?? []).map(bareDomain).filter((d) => d !== "");
  const exclude = (q.excludeDomains ?? []).map(bareDomain).filter((d) => d !== "");
  if (include.length === 1) parts.push(`site:${include[0]}`);
  else if (include.length > 1) parts.push(`(${include.map((d) => `site:${d}`).join(" OR ")})`);
  parts.push(q.query);
  for (const d of exclude) parts.push(`-site:${d}`);
  return parts.join(" ");
}

export class BraveProvider implements SearchProvider {
  readonly name = "brave" as const;
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

    const params = new URLSearchParams({
      q: buildBraveQuery(q),
      count: String(clamp(q.maxResults, 1, MAX_COUNT)),
    });
    if (q.recency !== undefined) params.set("freshness", FRESHNESS[q.recency]);

    const body = await requestJson({
      provider: this.name,
      url: `${this.baseUrl}${PATH}?${params.toString()}`,
      init: { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey as string } },
      fetchImpl: this.fetchImpl,
      signal,
    });
    const parsed = parseBody(this.name, BraveResponse, body);
    if (parsed.web === undefined && parsed.query === undefined) {
      throw new ProviderError({
        provider: this.name,
        message: "brave returned an unexpected response shape (neither web nor query present)",
        retryable: false,
      });
    }

    const items = (parsed.web?.results ?? []).map((r) => ({
      url: r.url,
      title: plainText(r.title),
      snippet: plainText(r.description),
      date: r.page_age,
    }));
    return finalize(items, q.maxResults, { include: q.includeDomains, exclude: q.excludeDomains });
  }
}
