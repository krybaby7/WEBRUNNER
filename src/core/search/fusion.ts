import { canonicalizeUrl } from "./canonical.js";
import type { RawResult, SearchProviderName } from "./types.js";

/** One row of the `results` array in the web_search output, PLAN.md section 3.1. */
export interface FusedResult {
  url: string;
  title: string;
  snippet: string;
  published_at?: string;
  providers: SearchProviderName[];
  score: number;
}

/** Reciprocal rank fusion constant, PLAN.md section 3.1. */
export const RRF_K = 60;

interface Group {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  providers: SearchProviderName[];
  score: number;
}

function earlier(a: string, b: string): string {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a <= b ? a : b;
  return tb < ta ? b : a;
}

/** Scores are sums of floats; round so the order of addition cannot leak into the output. */
function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/**
 * Merge per-provider ranked lists into one list.
 *
 * - Duplicates are found by `canonicalizeUrl`; the output `url` is the canonical form.
 * - Score is the sum over providers of 1 / (60 + rank). A provider that lists the
 *   same canonical URL twice counts once, at its best rank.
 * - Of the duplicates, the longest non-empty title and snippet win (the first one on
 *   ties), and the earliest `publishedAt` is kept.
 * - `providers` lists every provider that returned the URL, in input order.
 * - Sorted by score descending, then URL ascending, so the output is deterministic.
 * - Truncated to `maxResults`.
 */
export function fuseResults(
  perProvider: Array<{ provider: SearchProviderName; results: RawResult[] }>,
  maxResults: number,
): FusedResult[] {
  const groups = new Map<string, Group>();

  for (const { provider, results } of perProvider) {
    const bestRank = new Map<string, number>();
    for (const r of results) {
      const url = canonicalizeUrl(r.url);
      if (url === "") continue;
      const prev = bestRank.get(url);
      if (prev === undefined || r.rank < prev) bestRank.set(url, r.rank);

      let g = groups.get(url);
      if (g === undefined) {
        g = { url, title: "", snippet: "", providers: [], score: 0 };
        groups.set(url, g);
      }
      if (r.title.length > g.title.length) g.title = r.title;
      if (r.snippet.length > g.snippet.length) g.snippet = r.snippet;
      if (r.publishedAt !== undefined && r.publishedAt !== "") {
        g.publishedAt = g.publishedAt === undefined ? r.publishedAt : earlier(g.publishedAt, r.publishedAt);
      }
      if (!g.providers.includes(provider)) g.providers.push(provider);
    }
    for (const [url, rank] of bestRank) {
      const g = groups.get(url);
      if (g !== undefined) g.score += 1 / (RRF_K + rank);
    }
  }

  const fused: FusedResult[] = [...groups.values()].map((g) => ({
    url: g.url,
    title: g.title,
    snippet: g.snippet,
    ...(g.publishedAt !== undefined && { published_at: g.publishedAt }),
    providers: g.providers,
    score: round(g.score),
  }));
  fused.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return fused.slice(0, Math.max(0, Math.floor(maxResults)));
}
