import type { Logger } from "../../log.js";
import type { ErrorCode } from "../../schemas/error.js";
import {
  MarketQuoteOutputSchema,
  type HistoryRequest,
  type MarketQuote,
  type MarketQuoteOutput,
  type MarketSource,
  type SymbolMatch,
} from "../../schemas/markets.js";
import type { Cache } from "../cache/index.js";
import { redactSecrets } from "./http.js";
import type { RankedCoin } from "./providers/coingecko.js";
import { fallbackTicker, isPlausibleTicker, looksLikeCrypto, lookupCaveat, providerOrder, symbolForSource, type AssetKind } from "./resolve.js";
import { MarketProviderError, type MarketProvider, type QuoteOptions } from "./types.js";

/**
 * The `market_quote` service, PLAN.md 14.2: classifies each input, looks names
 * up, tries the routed sources in turn and merges the result. Inputs run in
 * parallel (at most `concurrency` at once), each source call under its own
 * timeout. Cache: quotes 60 s, history 10 min, lookups 24 h, keyed per source.
 */

export const MARKET_TTL_MS = { quote: 60_000, history: 10 * 60_000, lookup: 24 * 60 * 60_000 } as const;
export const MARKET_DEFAULT_TIMEOUT_MS = 10_000;
export const MARKET_DEFAULT_CONCURRENCY = 4;
export const MARKET_CAVEAT = "Quotes may be delayed; not investment advice.";
/** A CoinGecko name hit counts as crypto only for a coin ranked at least this high, so "Apple" never becomes a token. */
const CRYPTO_NAME_MAX_RANK = 300;

export interface MarketQuoteRequest {
  symbols: string[];
  history?: HistoryRequest;
  sources?: MarketSource[];
  /** Quote currency for crypto; the tool fills the config default. */
  currency: string;
}

export interface MarketService {
  quote(request: MarketQuoteRequest, signal: AbortSignal): Promise<MarketQuoteOutput>;
}

export interface MarketServiceDeps {
  providers: MarketProvider[];
  cache?: Cache;
  log: Logger;
  /** Per-source, per-symbol timeout. Default 10 s each. */
  timeoutsMs?: Partial<Record<MarketSource, number>>;
  /** Clock in epoch milliseconds. Default Date.now. */
  now?: () => number;
  /** Secret values to scrub from error text, on top of the pattern-based scrubbing. */
  secrets?: string[];
  /** Inputs quoted at once. Default 4. */
  concurrency?: number;
}

/** Thrown when no input could be quoted. `code` is the most specific code shared by the failures (PLAN.md 14.2). */
export class MarketQuoteError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, retryable: boolean, details?: unknown) {
    super(message);
    this.name = "MarketQuoteError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

interface Failure {
  source: MarketSource;
  error: string;
  code: ErrorCode;
  retryable: boolean;
}

/** Providers may take a fourth `hooks` argument (Google Finance does) to report caveats. */
interface HookedProvider {
  quote(symbol: string, opts: QuoteOptions, signal: AbortSignal, hooks?: { caveats?: string[] }): Promise<MarketQuote>;
}

const NOT_CONFIGURED_HINT: Record<MarketSource, string> = {
  yahoo: "not configured",
  finnhub: "not configured: set FINNHUB_API_KEY",
  coingecko: "not configured",
  google_finance: "not configured: no browser session is available",
};

export function createMarketService(deps: MarketServiceDeps): MarketService {
  const now = deps.now ?? Date.now;
  const concurrency = Math.max(1, deps.concurrency ?? MARKET_DEFAULT_CONCURRENCY);
  const redact = (s: string): string => redactSecrets(s, deps.secrets ?? []);
  const byName = new Map<MarketSource, MarketProvider>(deps.providers.map((p) => [p.name, p]));
  const timeoutFor = (source: MarketSource): number => deps.timeoutsMs?.[source] ?? MARKET_DEFAULT_TIMEOUT_MS;

  async function cached<T>(key: unknown, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = deps.cache !== undefined ? await deps.cache.get<T>(key) : undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    await deps.cache?.set(key, value, ttlMs);
    return value;
  }

  /** Run one provider call under its timeout, with `raceAbort` so a provider that ignores the signal still ends. */
  async function timed<T>(source: MarketSource, outer: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeoutMs = timeoutFor(source);
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), outer]);
    return raceAbort(work(signal), signal, source, timeoutMs);
  }

  async function lookup(provider: MarketProvider, query: string, outer: AbortSignal): Promise<SymbolMatch[]> {
    if (provider.lookup === undefined) return [];
    return cached({ source: provider.name, kind: "lookup", q: query.trim().toLowerCase() }, MARKET_TTL_MS.lookup, () =>
      timed(provider.name, outer, (signal) => (provider.lookup as NonNullable<MarketProvider["lookup"]>).call(provider, query, signal)),
    );
  }

  async function quoteFrom(provider: MarketProvider, symbol: string, opts: QuoteOptions, outer: AbortSignal, caveats: string[]): Promise<MarketQuote> {
    const key = {
      source: provider.name,
      kind: opts.history !== undefined ? "history" : "quote",
      symbol: symbol.toUpperCase(),
      currency: opts.currency,
      ...(opts.history !== undefined && { range: opts.history.range, interval: opts.history.interval ?? null }),
    };
    const ttl = opts.history !== undefined ? MARKET_TTL_MS.history : MARKET_TTL_MS.quote;
    return cached(key, ttl, () =>
      timed(provider.name, outer, (signal) => (provider as unknown as HookedProvider).quote(symbol, opts, signal, { caveats })),
    );
  }

  /** Decide the kind and the symbol candidates for one input. */
  async function classify(
    requested: string,
    configured: MarketSource[],
    requestedSources: MarketSource[] | undefined,
    outer: AbortSignal,
    caveats: string[],
    failures: Failure[],
  ): Promise<{ kind: AssetKind; candidates: Array<{ symbol: string; source?: MarketSource }> }> {
    const input = requested.trim();
    if (looksLikeCrypto(input)) return { kind: "crypto", candidates: [{ symbol: input }] };
    if (isPlausibleTicker(input)) return { kind: "other", candidates: [{ symbol: input }] };

    // A name: ask CoinGecko first (an exact, well-ranked hit means crypto), then the equity sources that can look up.
    const coingecko = byName.get("coingecko");
    if (coingecko !== undefined && configured.includes("coingecko") && (requestedSources === undefined || requestedSources.includes("coingecko"))) {
      try {
        const coins = await lookup(coingecko, input, outer);
        const first = coins[0];
        if (first !== undefined && first.name?.toLowerCase() === input.toLowerCase()) {
          const rankOk = await coinRankOk(coingecko, input, outer);
          if (rankOk) {
            const caveat = lookupCaveat(requested, coins);
            if (caveat !== undefined) caveats.push(caveat);
            return { kind: "crypto", candidates: [{ symbol: first.symbol, source: "coingecko" }] };
          }
        }
      } catch (err) {
        failures.push(classifyError(err, "coingecko", redact));
      }
    }
    for (const source of providerOrder("other", configured, requestedSources)) {
      const provider = byName.get(source);
      if (provider?.lookup === undefined) continue;
      try {
        const matches = await lookup(provider, input, outer);
        if (matches.length === 0) continue;
        const caveat = lookupCaveat(requested, matches);
        if (caveat !== undefined) caveats.push(caveat);
        const first = matches[0] as SymbolMatch;
        return { kind: first.asset_type === "crypto" ? "crypto" : "other", candidates: [{ symbol: first.symbol, source }] };
      } catch (err) {
        failures.push(classifyError(err, source, redact));
      }
    }
    const ticker = fallbackTicker(input);
    return { kind: "other", candidates: ticker !== undefined ? [{ symbol: ticker }] : [] };
  }

  /** A name is crypto only when CoinGecko's best hit is a well-ranked coin (`SymbolMatch` carries no rank, so ask the provider). */
  async function coinRankOk(provider: MarketProvider, input: string, outer: AbortSignal): Promise<boolean> {
    if (!hasRankedSearch(provider)) return true;
    const coins = await cached({ source: provider.name, kind: "ranked-lookup", q: input.trim().toLowerCase() }, MARKET_TTL_MS.lookup, () =>
      timed(provider.name, outer, (signal) => provider.rankedSearch(input, signal)),
    );
    const rank = coins[0]?.market_cap_rank;
    return rank != null && rank <= CRYPTO_NAME_MAX_RANK;
  }

  async function quoteOne(
    requested: string,
    request: MarketQuoteRequest,
    configured: MarketSource[],
    outer: AbortSignal,
    shared: { caveats: string[]; failures: Failure[]; used: Set<MarketSource> },
  ): Promise<{ quote?: MarketQuote; error?: string }> {
    const { kind, candidates } = await classify(requested, configured, request.sources, outer, shared.caveats, shared.failures);
    if (candidates.length === 0) return { error: `no source could resolve "${requested}" to a symbol` };
    const order = providerOrder(kind, configured, request.sources);
    if (order.length === 0) return { error: `no configured source quotes ${kind === "crypto" ? "crypto" : "this kind of"} assets` };

    let lastError = `no source answered for "${requested}"`;
    for (const source of order) {
      const provider = byName.get(source) as MarketProvider;
      const candidate = candidates.find((c) => c.source === undefined || c.source === source) ?? (candidates[0] as { symbol: string });
      const symbol = symbolForSource(source, candidate.symbol, kind, request.currency);
      const opts: QuoteOptions = { currency: request.currency, ...(request.history !== undefined && { history: request.history }) };
      try {
        const quote = await quoteFrom(provider, symbol, opts, outer, shared.caveats);
        shared.used.add(source);
        if (request.history !== undefined && quote.history === undefined) {
          shared.caveats.push(`${source} has no price history, so ${requested} is quoted without history.`);
        }
        if (quote.history !== undefined && request.history?.interval !== undefined && quote.history.interval !== request.history.interval) {
          shared.caveats.push(`${source} returned ${requested} history at interval ${quote.history.interval}, not the requested ${request.history.interval}.`);
        }
        return { quote: { ...quote, requested } };
      } catch (err) {
        const f = classifyError(err, source, redact);
        lastError = `${source}: ${f.error}`;
        if (err instanceof MarketProviderError && err.code === "not_found") {
          deps.log.debug("market source has no such symbol", { source, symbol });
          continue;
        }
        deps.log.warn("market source failed", { source, symbol, code: f.code, error: f.error });
        shared.failures.push(f);
        if (outer.aborted) break;
      }
    }
    return { error: lastError };
  }

  async function quote(request: MarketQuoteRequest, signal: AbortSignal): Promise<MarketQuoteOutput> {
    const configured = deps.providers.filter((p) => p.isConfigured()).map((p) => p.name);
    const shared = { caveats: [] as string[], failures: [] as Failure[], used: new Set<MarketSource>() };
    for (const s of request.sources ?? []) {
      if (!configured.includes(s)) shared.failures.push({ source: s, error: NOT_CONFIGURED_HINT[s], code: "config", retryable: false });
    }

    const inputs = [...new Set(request.symbols.map((s) => s.trim()).filter((s) => s !== ""))];
    const results = new Array<{ quote?: MarketQuote; error?: string }>(inputs.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= inputs.length) return;
        const requested = inputs[i] as string;
        try {
          results[i] = await quoteOne(requested, request, configured, signal, shared);
        } catch (err) {
          results[i] = { error: redact(err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error" };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));

    const quotes = results.flatMap((r) => (r.quote !== undefined ? [r.quote] : []));
    const unresolved = inputs.flatMap((requested, i) => {
      const r = results[i];
      return r?.quote === undefined ? [{ requested, error: redact(r?.error ?? "unknown error") }] : [];
    });

    if (quotes.length === 0) throw noQuotes(shared.failures, unresolved);

    const delays = [...new Set(quotes.map((q) => q.delayed_min).filter((d): d is number => d !== undefined && d > 0))].sort((a, b) => a - b);
    const caveats = dedupe([
      MARKET_CAVEAT,
      ...(delays.length > 0 ? [`Equity quotes from ${quotes.filter((q) => q.delayed_min !== undefined && q.delayed_min > 0).map((q) => q.source).filter(uniq).join(", ")} are delayed by ${delays.join(" to ")} minutes.`] : []),
      ...shared.caveats,
    ]);
    const output: MarketQuoteOutput = {
      quotes,
      unresolved,
      sources_used: [...shared.used],
      sources_failed: dedupeFailures(shared.failures).map((f) => ({ source: f.source, error: f.error })),
      fetched_at: new Date(now()).toISOString(),
      caveats,
    };
    const checked = MarketQuoteOutputSchema.safeParse(output);
    if (!checked.success) {
      throw new MarketQuoteError("internal", `market_quote produced a result that failed its own schema check (${checked.error.issues[0]?.message ?? "invalid"})`, false);
    }
    return checked.data;
  }

  return { quote };
}

function hasRankedSearch(p: MarketProvider): p is MarketProvider & { rankedSearch(q: string, signal: AbortSignal): Promise<RankedCoin[]> } {
  return typeof (p as { rankedSearch?: unknown }).rankedSearch === "function";
}

function uniq<T>(v: T, i: number, arr: T[]): boolean {
  return arr.indexOf(v) === i;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function dedupeFailures(failures: Failure[]): Failure[] {
  const seen = new Map<MarketSource, Failure>();
  for (const f of failures) if (!seen.has(f.source)) seen.set(f.source, f);
  return [...seen.values()];
}

function classifyError(err: unknown, source: MarketSource, redact: (s: string) => string): Failure {
  if (err instanceof MarketProviderError) {
    const code: ErrorCode = err.code === "not_found" ? "provider" : err.code;
    return { source: err.provider, error: redact(err.message), code, retryable: err.retryable };
  }
  const message = redact(err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
  return { source, error: message, code: "provider", retryable: false };
}

/** Most specific code wins: blocked, then a code shared by every failure, then provider. */
function noQuotes(failures: Failure[], unresolved: Array<{ requested: string; error: string }>): MarketQuoteError {
  const basis = failures.filter((f) => f.code !== "config");
  const pool = basis.length > 0 ? basis : failures;
  let code: ErrorCode;
  if (pool.length === 0) code = "provider";
  else if (pool.some((f) => f.code === "blocked")) code = "blocked";
  else if (pool.every((f) => f.code === (pool[0] as Failure).code)) code = (pool[0] as Failure).code;
  else code = "provider";
  const retryable = code !== "blocked" && pool.some((f) => f.retryable);
  const summary = unresolved.map((u) => `${u.requested}: ${u.error}`).join("; ");
  const message =
    failures.length === 0
      ? `No symbol could be quoted. ${summary}`
      : `No market source answered. ${dedupeFailures(failures).map((f) => `${f.source}: ${f.error}`).join("; ")}${summary !== "" ? `. ${summary}` : ""}`;
  return new MarketQuoteError(code, message, retryable, {
    sources_failed: dedupeFailures(failures).map((f) => ({ source: f.source, error: f.error })),
    unresolved,
  });
}

/** Reject when `signal` aborts, even if the provider ignores it. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, source: MarketSource, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new MarketProviderError(`${source} did not answer within ${Math.round(timeoutMs / 1000)}s (timed out or cancelled)`, {
          provider: source,
          code: "timeout",
          retryable: true,
        }),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
