import type { Cache } from "../cache/index.js";
import type { Logger } from "../../log.js";
import {
  DEFAULT_MAX_RESULTS,
  WebSearchOutputSchema,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchProviderFailure,
} from "../../schemas/web_search.js";
import { fuseResults } from "./fusion.js";
import {
  ProviderError,
  type RawResult,
  type SearchProvider,
  type SearchProviderName,
  type SearchQuery,
} from "./types.js";

export { canonicalizeUrl } from "./canonical.js";
export { fuseResults, type FusedResult } from "./fusion.js";

/** Per-provider timeout, PLAN.md section 3.1. */
export const DEFAULT_TIMEOUT_MS = 8000;
/** Cache lifetime for a search, PLAN.md section 3.1. */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

export type SearchErrorCode = "provider" | "timeout" | "config";

/**
 * Thrown by `SearchService.search` when no result could be produced: nothing is
 * configured, or every requested provider failed. `code` maps onto the error
 * envelope (PLAN.md section 3.6).
 */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly retryable: boolean;
  readonly providersFailed: WebSearchProviderFailure[];

  constructor(init: {
    code: SearchErrorCode;
    message: string;
    retryable: boolean;
    providersFailed?: WebSearchProviderFailure[];
  }) {
    super(init.message);
    this.name = "SearchError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.providersFailed = init.providersFailed ?? [];
  }
}

export interface SearchService {
  search(input: WebSearchInput): Promise<WebSearchOutput>;
}

export interface SearchServiceDeps {
  providers: SearchProvider[];
  cache: Cache;
  log: Logger;
  /** Per-provider timeout. Default 8000. */
  timeoutMs?: number;
  /** Clock in epoch milliseconds, used for `latency_ms`. Default Date.now. */
  now?: () => number;
  /** Secret values (API keys) to scrub from error messages and logs, on top of pattern-based scrubbing. */
  secrets?: string[];
}

/** Replace anything that looks like a credential in a message. */
function makeRedactor(secrets: string[]): (s: string) => string {
  const exact = secrets.filter((s) => s.length >= 6);
  return (s) => {
    let out = s;
    for (const secret of exact) out = out.split(secret).join("[redacted]");
    return out
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/((?:api[_-]?key|access[_-]?token|token|key|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi, "$1[redacted]");
  };
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v !== ""))].sort();
}

/** Reject when `signal` aborts, for providers that ignore it. */
function whenAborted(signal: AbortSignal, onAbort: () => Error): { promise: Promise<never>; dispose: () => void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(onAbort());
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  // The race may never observe a loser's rejection.
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

type Outcome =
  | { provider: SearchProviderName; ok: true; results: RawResult[] }
  | { provider: SearchProviderName; ok: false; error: string; aborted: boolean; retryable: boolean };

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { cache, log } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const redact = makeRedactor(deps.secrets ?? []);
  const configured = deps.providers.filter((p) => p.isConfigured());

  async function runProvider(provider: SearchProvider, q: SearchQuery): Promise<Outcome> {
    const name = provider.name;
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = (): ProviderError =>
      new ProviderError({ provider: name, message: `${name} timed out`, retryable: true, aborted: true });
    const abort = whenAborted(signal, timedOut);
    try {
      const results = await Promise.race([
        Promise.resolve().then(() => provider.search(q, signal)),
        abort.promise,
      ]);
      return { provider: name, ok: true, results };
    } catch (err) {
      if (err instanceof ProviderError && err.aborted) {
        return {
          provider: name,
          ok: false,
          error: `${name} timed out after ${timeoutMs} ms`,
          aborted: true,
          retryable: true,
        };
      }
      const message = redact(err instanceof Error ? err.message : String(err));
      return {
        provider: name,
        ok: false,
        error: message,
        aborted: false,
        retryable: err instanceof ProviderError ? err.retryable : false,
      };
    } finally {
      abort.dispose();
    }
  }

  async function search(input: WebSearchInput): Promise<WebSearchOutput> {
    const started = now();
    const query = input.query;
    const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

    if (configured.length === 0) {
      throw new SearchError({
        code: "config",
        message:
          "No search providers are configured. Set at least one of BRAVE_API_KEY, EXA_API_KEY, TAVILY_API_KEY or PERPLEXITY_API_KEY.",
        retryable: false,
      });
    }

    const requested = [...new Set(input.providers ?? configured.map((p) => p.name))];
    const byName = new Map(configured.map((p) => [p.name, p]));
    const toRun: SearchProvider[] = [];
    const failed: WebSearchProviderFailure[] = [];
    for (const name of requested) {
      const p = byName.get(name);
      if (p === undefined) failed.push({ provider: name, error: "not configured" });
      else toRun.push(p);
    }

    const cacheKey = {
      query,
      recency: input.recency,
      include_domains: sortedUnique(input.include_domains),
      exclude_domains: sortedUnique(input.exclude_domains),
      providers: [...requested].sort(),
      max_results: maxResults,
    };
    const stored = await cache.get<unknown>(cacheKey);
    if (stored !== undefined) {
      // An entry written by an older version of the output shape is a miss, not an error.
      const hit = WebSearchOutputSchema.safeParse(stored);
      if (hit.success) return { ...hit.data, cached: true, latency_ms: Math.max(0, now() - started) };
      log.warn("search cache entry does not match the output schema, ignoring it");
    }

    if (toRun.length === 0) {
      throw new SearchError({
        code: "config",
        message: `None of the requested providers (${requested.join(", ")}) is configured.`,
        retryable: false,
        providersFailed: failed,
      });
    }

    const q: SearchQuery = {
      query,
      maxResults,
      ...(input.recency !== undefined && { recency: input.recency }),
      ...(input.include_domains !== undefined && input.include_domains.length > 0 && { includeDomains: input.include_domains }),
      ...(input.exclude_domains !== undefined && input.exclude_domains.length > 0 && { excludeDomains: input.exclude_domains }),
    };
    const outcomes = await Promise.all(toRun.map((p) => runProvider(p, q)));

    const succeeded: Array<{ provider: SearchProviderName; results: RawResult[] }> = [];
    const runtimeFailures: Extract<Outcome, { ok: false }>[] = [];
    for (const o of outcomes) {
      if (o.ok) succeeded.push({ provider: o.provider, results: o.results });
      else {
        runtimeFailures.push(o);
        failed.push({ provider: o.provider, error: o.error });
        log.warn("search provider failed", { provider: o.provider, error: o.error, timed_out: o.aborted });
      }
    }

    if (succeeded.length === 0) {
      const allTimedOut = runtimeFailures.every((f) => f.aborted);
      throw new SearchError({
        code: allTimedOut ? "timeout" : "provider",
        message: `All search providers failed: ${failed.map((f) => `${f.provider} (${f.error})`).join("; ")}`,
        retryable: runtimeFailures.some((f) => f.retryable),
        providersFailed: failed,
      });
    }

    const output: WebSearchOutput = {
      query,
      results: fuseResults(succeeded, maxResults),
      providers_used: succeeded.map((s) => s.provider),
      providers_failed: failed,
      cached: false,
      latency_ms: Math.max(0, now() - started),
    };

    // A result that is missing a provider because of a transient failure would
    // otherwise be served for an hour after the provider recovers.
    if (runtimeFailures.length === 0) {
      await cache.set(cacheKey, output, SEARCH_CACHE_TTL_MS);
    }
    return output;
  }

  return { search };
}
