import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { FlightProviderError, type FlightProvider } from "../core/flights/types.js";
import { buildAllFlightProviders } from "../core/flights/providers/index.js";
import { resolvePlace } from "../core/flights/resolve.js";
import { LlmError } from "../core/llm/types.js";
import { toolError, type ErrorCode } from "../schemas/error.js";
import {
  FlightsInputError,
  MAX_OFFERS,
  SearchFlightsInputSchema,
  SearchFlightsOutputSchema,
  normalizeFlightsInput,
  type FlightOffer,
  type FlightSource,
  type NormalizedFlightsQuery,
  type SearchFlightsOutput,
} from "../schemas/flights.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Search for exact flight fares and schedules. Sources: Google Flights (read through a real browser, no API key needed) and Duffel (licensed API, needs DUFFEL_API_KEY). " +
  "Takes IATA codes or city names, dates, passengers, cabin and optional stop limit; returns offers sorted by price with carriers, times, airports, stops and layovers, tagged by source (the same flight can show different prices per source). " +
  "Prices are quotes at fetch time and can change before booking; this tool reads and extracts only and never books. " +
  "For personal use: reading Google Flights automatically is against Google's terms of service, so keep volume low. " +
  "Google Flights lists only the outbound leg of a round trip and no flight numbers; the caveats field says when that applies. " +
  "Transient Duffel failures (429, 5xx, network errors) are retried up to twice; Google Flights is never retried automatically. The whole call is capped at 120 seconds; past that it returns error code timeout (retryable).";

/** Per-source time budgets, in ms. Google Flights loads a page and calls the LLM, so it gets the longer one. */
const DEFAULT_TIMEOUTS_MS: Record<FlightSource, number> = { google_flights: 90_000, duffel: 45_000 };

export interface SearchFlightsToolOptions {
  /** Replaces the real providers. For tests. */
  providers?: (deps: Deps) => FlightProvider[];
  /** Overrides the per-source timeouts. For tests. */
  timeoutsMs?: Partial<Record<FlightSource, number>>;
  /** Overrides the 120 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

interface Failure {
  source: FlightSource;
  error: string;
  code: ErrorCode;
  retryable: boolean;
  /** True for "not configured"; such entries do not decide the error code when a real failure exists. */
  unconfigured: boolean;
}

/** Hooks a provider may accept as a third argument (Google Flights does). */
interface HookedSearch {
  search(q: NormalizedFlightsQuery, signal: AbortSignal, hooks?: { caveats?: string[] }): Promise<FlightOffer[]>;
}

const NOT_CONFIGURED_HINT: Record<FlightSource, string> = {
  duffel: "not configured: set DUFFEL_API_KEY",
  google_flights: "not configured: no browser session is available",
};

export function registerSearchFlightsTool(server: McpServer, deps: Deps, options: SearchFlightsToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.search_flights;
  const makeProviders =
    options.providers ??
    ((d: Deps): FlightProvider[] =>
      buildAllFlightProviders(d.config, {
        ...(d.browser !== undefined && { browser: d.browser }),
        ...(d.llm !== undefined && { llm: d.llm }),
      }));

  server.registerTool(
    "search_flights",
    {
      title: "Search flights",
      description: DESCRIPTION,
      inputSchema: SearchFlightsInputSchema,
      outputSchema: SearchFlightsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("search_flights", capMs, async (wallSignal) => {
        try {
        const parsed = SearchFlightsInputSchema.safeParse(args);
        if (!parsed.success) {
          return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
        }
        const input = parsed.data;

        const all = makeProviders(deps);
        const configured = all.filter((p) => p.isConfigured());
        if (input.sources === undefined && configured.length === 0) {
          return toolError(
            "config",
            "No flight source is configured. Google Flights needs the browser and a model backend (ANTHROPIC_API_KEY or the claude CLI); Duffel needs DUFFEL_API_KEY.",
            false,
          );
        }

        // Place names resolve asynchronously (LLM fallback); normalizeFlightsInput takes a synchronous resolver.
        let query: NormalizedFlightsQuery;
        try {
          const [origin, destination] = await Promise.all([
            resolvePlace(input.origin, deps.llm),
            resolvePlace(input.destination, deps.llm),
          ]);
          const resolved = new Map<string, string>([
            [input.origin, origin],
            [input.destination, destination],
          ]);
          query = normalizeFlightsInput(input, deps.config, {
            resolve: (place) => resolved.get(place),
            defaultSources: configured.map((p) => p.name),
          });
        } catch (err) {
          if (err instanceof FlightsInputError) return toolError("invalid_input", err.message, false);
          if (err instanceof LlmError) return toolError(err.code, err.message, err.retryable, err.details);
          const msg = err instanceof Error ? err.message : String(err);
          deps.log.error("search_flights failed while resolving places", { error: msg });
          return toolError("internal", `search_flights failed: ${msg}`, false);
        }

        const failures: Failure[] = [];
        const used: FlightSource[] = [];
        const offers: FlightOffer[] = [];
        const providerCaveats: string[] = [];

        await Promise.all(
          query.sources.map(async (source) => {
            const provider = all.find((p) => p.name === source);
            if (provider === undefined || !provider.isConfigured()) {
              failures.push({
                source,
                error: NOT_CONFIGURED_HINT[source],
                code: "config",
                retryable: false,
                unconfigured: true,
              });
              return;
            }
            const timeoutMs = options.timeoutsMs?.[source] ?? DEFAULT_TIMEOUTS_MS[source];
            const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), extra.signal, wallSignal]);
            try {
              const found = await raceAbort(
                (provider as unknown as HookedSearch).search(query, signal, { caveats: providerCaveats }),
                signal,
                source,
                timeoutMs,
              );
              used.push(source);
              offers.push(...found);
            } catch (err) {
              const f = classify(err, source);
              deps.log.warn("flight source failed", { source, code: f.code, error: f.error });
              failures.push(f);
            }
          }),
        );

        if (used.length === 0) {
          return failureResult(failures);
        }

        const { merged, omitted } = mergeOffers(offers, query.currency);
        const caveats = buildCaveats({ query, merged, omitted, used, providerCaveats });

        const output: SearchFlightsOutput = {
          query,
          offers: merged,
          sources_used: query.sources.filter((s) => used.includes(s)),
          sources_failed: query.sources
            .map((s) => failures.find((f) => f.source === s))
            .filter((f): f is Failure => f !== undefined)
            .map((f) => ({ source: f.source, error: f.error })),
          fetched_at: new Date().toISOString(),
          caveats,
        };
        const checked = SearchFlightsOutputSchema.safeParse(output);
        if (!checked.success) {
          deps.log.error("search_flights produced an invalid result", { issues: checked.error.issues.length });
          return toolError("internal", "search_flights produced a result that failed its own schema check", false);
        }
        return jsonResult(checked.data);
      } catch (err) {
        // Anything that escapes the per-source handling above (a throwing provider factory, a merge bug).
        const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
        deps.log.error("search_flights failed unexpectedly", { error: message });
        return toolError("internal", `search_flights failed: ${message}`, false);
        }
      }),
  );
}

/** Reject when `signal` aborts, even if the provider ignores it. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, source: FlightSource, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new FlightProviderError(`${source} did not answer within ${Math.round(timeoutMs / 1000)}s (timed out or cancelled)`, {
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

function classify(err: unknown, source: FlightSource): Failure {
  if (err instanceof FlightProviderError) {
    return { source, error: err.message, code: err.code, retryable: err.retryable, unconfigured: false };
  }
  if (err instanceof LlmError) {
    return { source, error: err.message, code: err.code, retryable: err.retryable, unconfigured: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { source, error: message, code: "provider", retryable: false, unconfigured: false };
}

/** Most specific code wins: blocked, then a code shared by every real failure, then provider. */
function failureResult(failures: Failure[]) {
  const real = failures.filter((f) => !f.unconfigured);
  const basis = real.length > 0 ? real : failures;
  let code: ErrorCode;
  if (basis.some((f) => f.code === "blocked")) code = "blocked";
  else if (basis.every((f) => f.code === (basis[0] as Failure).code)) code = (basis[0] as Failure).code;
  else code = "provider";
  const retryable = code !== "blocked" && basis.some((f) => f.retryable);
  const message =
    failures.length === 1
      ? `${(failures[0] as Failure).source}: ${(failures[0] as Failure).error}`
      : `No flight source answered. ${failures.map((f) => `${f.source}: ${f.error}`).join("; ")}`;
  return toolError(code, message, retryable, {
    sources_failed: failures.map((f) => ({ source: f.source, error: f.error })),
  });
}

/**
 * Group by currency, sort each group by price (ties by id), put the requested
 * currency first and the rest in order of first appearance, cap at MAX_OFFERS.
 */
function mergeOffers(offers: FlightOffer[], currency: string): { merged: FlightOffer[]; omitted: number } {
  const groups = new Map<string, FlightOffer[]>();
  for (const o of offers) {
    const g = groups.get(o.price.currency);
    if (g === undefined) groups.set(o.price.currency, [o]);
    else g.push(o);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => Number(b === currency) - Number(a === currency));
  const flat = ordered.flatMap(([, g]) => g.sort((x, y) => x.price.amount - y.price.amount || x.id.localeCompare(y.id)));
  return { merged: flat.slice(0, MAX_OFFERS), omitted: Math.max(0, flat.length - MAX_OFFERS) };
}

function buildCaveats(c: {
  query: NormalizedFlightsQuery;
  merged: FlightOffer[];
  omitted: number;
  used: FlightSource[];
  providerCaveats: string[];
}): string[] {
  const out: string[] = [];
  const currencies = [...new Set(c.merged.map((o) => o.price.currency))];
  if (currencies.some((cur) => cur !== c.query.currency)) {
    out.push(
      `Offers are priced in more than one currency (${currencies.join(", ")}); the requested currency is ${c.query.currency}. Offers are grouped by currency with ${c.query.currency} first and sorted by price within each group. No conversion is applied, so do not compare prices across groups.`,
    );
  }
  if (c.query.max_stops === undefined && c.used.includes("google_flights") && c.used.includes("duffel")) {
    out.push(
      "max_stops was not set: Google Flights lists itineraries with any number of stops while Duffel returns at most 1 connection by default, so the sources are not directly comparable. Set max_stops to align them.",
    );
  }
  if (c.merged.some((o) => o.itinerary === "outbound_only")) {
    out.push(
      'Google Flights shows only the outbound flight of a round trip. Those offers carry one slice and itinerary "outbound_only"; the price is the round-trip total and the return flight is chosen in a second step on Google Flights.',
    );
  }
  if (c.merged.some((o) => o.slices.some((s) => s.segments.some((seg) => seg.flight_number === undefined)))) {
    out.push("Flight numbers are not shown by Google Flights, so those offers have no flight_number.");
  }
  out.push(...c.providerCaveats);
  if (c.omitted > 0) {
    out.push(`${c.omitted} further offer(s) were left out to stay within the ${MAX_OFFERS}-offer limit.`);
  }
  if (c.merged.length === 0) out.push("No offers were found for this search.");
  out.push("Prices are quotes at fetch time and can change before booking.");
  return out;
}
