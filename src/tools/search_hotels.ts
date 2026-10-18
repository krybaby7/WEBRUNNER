import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { filterAndSortHotels, HotelsInputError, normalizeHotelsInput } from "../core/hotels/normalize.js";
import { buildAllHotelProviders } from "../core/hotels/providers/index.js";
import { HotelProviderError, type HotelProvider, type HotelSearchHooks } from "../core/hotels/types.js";
import { LlmError } from "../core/llm/types.js";
import { toolError, type ErrorCode } from "../schemas/error.js";
import {
  SearchHotelsInputSchema,
  SearchHotelsOutputSchema,
  type HotelResult,
  type HotelSource,
  type NormalizedHotelsQuery,
  type SearchHotelsOutput,
} from "../schemas/hotels.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Search hotel rates and ratings for a destination and dates. Source: Google Hotels, read through a real browser (no API key needed; ANTHROPIC_API_KEY is used only as a fallback when the page layout is not recognised). " +
  "Takes a destination (city, area, landmark or hotel name), check-in and check-out dates, guests, and optional filters (max_price_per_night, min_rating, star_classes) and sort (relevance, price, rating); " +
  "returns hotels with nightly price, stay total when shown, guest rating and review count when shown, star class, type, amenities, badges and the hotel's Google Hotels page. " +
  "Prices are quotes at fetch time; taxes and fees vary by booking site. This tool reads and extracts only: it never opens a booking site and never books. " +
  "For personal, low-volume use: reading Google Hotels automatically is against Google's terms of service, so keep volume low. " +
  "The whole call is capped at 120 seconds; past that it returns error code timeout (retryable).";

/** Per-source time budgets, in ms (PLAN.md 14.1: Google Hotels 90 s). */
const DEFAULT_TIMEOUTS_MS: Record<HotelSource, number> = { google_hotels: 90_000 };

const NOT_CONFIGURED_HINT: Record<HotelSource, string> = {
  google_hotels: "not configured: no browser session is available",
};

export const PRICE_DISCLAIMER = "Prices are quotes at fetch time; taxes and fees vary by booking site and can change before booking.";

/**
 * The input schema as registered with the SDK: the contract's fields without
 * its cross-field refinements (check_out after check_in, at most 30 nights).
 * The SDK validates field types itself; the refinements run in the handler
 * through `SearchHotelsInputSchema`, so their failures come back as the
 * `invalid_input` envelope instead of the SDK's generic error text. The
 * published JSON Schema is identical either way.
 */
const RegisteredInputSchema = z.object(SearchHotelsInputSchema.shape);

export interface SearchHotelsToolOptions {
  /** Replaces the real providers. For tests. */
  providers?: (deps: Deps) => HotelProvider[];
  /** Overrides the per-source timeouts. For tests. */
  timeoutsMs?: Partial<Record<HotelSource, number>>;
  /** Overrides the 120 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

interface Failure {
  source: HotelSource;
  error: string;
  code: ErrorCode;
  retryable: boolean;
  /** True for "not configured"; such entries do not decide the error code when a real failure exists. */
  unconfigured: boolean;
}

export function registerSearchHotelsTool(server: McpServer, deps: Deps, options: SearchHotelsToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.search_hotels;
  const makeProviders =
    options.providers ??
    ((d: Deps): HotelProvider[] =>
      buildAllHotelProviders(d.config, {
        ...(d.browser !== undefined && { browser: d.browser }),
        ...(d.llm !== undefined && { llm: d.llm }),
      }));

  server.registerTool(
    "search_hotels",
    {
      title: "Search hotels",
      description: DESCRIPTION,
      inputSchema: RegisteredInputSchema,
      outputSchema: SearchHotelsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("search_hotels", capMs, async (wallSignal) => {
        try {
          const parsed = SearchHotelsInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const input = parsed.data;

          const all = makeProviders(deps);
          const configured = all.filter((p) => p.isConfigured());
          if (input.sources === undefined && configured.length === 0) {
            return toolError(
              "config",
              "No hotel source is configured. Google Hotels needs the browser (set BROWSER_CDP_URL or let the server launch its own Chromium).",
              false,
            );
          }

          let query: NormalizedHotelsQuery;
          try {
            query = normalizeHotelsInput(input, deps.config, { defaultSources: configured.map((p) => p.name) });
          } catch (err) {
            if (err instanceof HotelsInputError) return toolError("invalid_input", err.message, false);
            throw err;
          }

          const failures: Failure[] = [];
          const used: HotelSource[] = [];
          const found: HotelResult[] = [];
          const providerCaveats: string[] = [];
          const hooks: HotelSearchHooks = { caveats: providerCaveats, ...(deps.dailyCap !== undefined && { meter: deps.dailyCap }) };

          await Promise.all(
            query.sources.map(async (source) => {
              const provider = all.find((p) => p.name === source);
              if (provider === undefined || !provider.isConfigured()) {
                failures.push({ source, error: NOT_CONFIGURED_HINT[source], code: "config", retryable: false, unconfigured: true });
                return;
              }
              const timeoutMs = options.timeoutsMs?.[source] ?? DEFAULT_TIMEOUTS_MS[source];
              const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), extra.signal, wallSignal]);
              try {
                const hotels = await raceAbort(provider.search(query, signal, hooks), signal, source, timeoutMs);
                used.push(source);
                found.push(...hotels);
              } catch (err) {
                const f = classify(err, source);
                deps.log.warn("hotel source failed", { source, code: f.code, error: f.error });
                failures.push(f);
              }
            }),
          );

          if (used.length === 0) {
            return failureResult(failures);
          }

          const outcome = filterAndSortHotels(found, query);
          const caveats = buildCaveats({ query, found, kept: outcome.hotels, omitted: outcome.omitted, providerCaveats });

          const output: SearchHotelsOutput = {
            query,
            hotels: outcome.hotels,
            sources_used: query.sources.filter((s) => used.includes(s)),
            sources_failed: query.sources
              .map((s) => failures.find((f) => f.source === s))
              .filter((f): f is Failure => f !== undefined)
              .map((f) => ({ source: f.source, error: f.error })),
            fetched_at: new Date().toISOString(),
            caveats,
          };
          const checked = SearchHotelsOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("search_hotels produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "search_hotels produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          // Anything that escapes the per-source handling above (a throwing provider factory, a merge bug).
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("search_hotels failed unexpectedly", { error: message });
          return toolError("internal", `search_hotels failed: ${message}`, false);
        }
      }),
  );
}

/** Reject when `signal` aborts, even if the provider ignores it. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, source: HotelSource, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new HotelProviderError(`${source} did not answer within ${Math.round(timeoutMs / 1000)}s (timed out or cancelled)`, {
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

function classify(err: unknown, source: HotelSource): Failure {
  if (err instanceof HotelProviderError) {
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
      : `No hotel source answered. ${failures.map((f) => `${f.source}: ${f.error}`).join("; ")}`;
  return toolError(code, message, retryable, {
    sources_failed: failures.map((f) => ({ source: f.source, error: f.error })),
  });
}

function buildCaveats(c: {
  query: NormalizedHotelsQuery;
  found: HotelResult[];
  kept: HotelResult[];
  omitted: number;
  providerCaveats: string[];
}): string[] {
  const out: string[] = [];
  const q = c.query;
  const hidden = c.found.length - c.kept.length - c.omitted;
  if (hidden > 0) {
    const filters = [
      q.max_price_per_night !== undefined ? `max_price_per_night ${q.max_price_per_night} ${q.currency}` : undefined,
      q.min_rating !== undefined ? `min_rating ${q.min_rating}` : undefined,
      q.star_classes !== undefined ? `star_classes ${q.star_classes.join(", ")}` : undefined,
    ].filter((f): f is string => f !== undefined);
    out.push(`${hidden} hotel(s) were hidden by the filters (${filters.join("; ")}); a hotel that does not show the filtered field is hidden too.`);
  }
  const currencies = [...new Set(c.kept.map((h) => h.price_per_night?.currency).filter((x): x is string => x !== undefined))];
  if (currencies.some((cur) => cur !== q.currency)) {
    out.push(
      `Some prices are not in the requested currency ${q.currency} (seen: ${currencies.join(", ")}); no conversion is applied, so compare only prices in the same currency.`,
    );
  }
  const perNightOnly = c.kept.filter((h) => h.price_per_night !== undefined && h.total_price === undefined).length;
  if (perNightOnly > 0) {
    out.push(
      `${perNightOnly} hotel(s) show a per-night price only; the stay total is ${q.nights} night(s) times the nightly rate, before taxes and fees.`,
    );
  }
  if (c.kept.some((h) => h.total_price !== undefined)) {
    out.push("total_price is the stay total as the page printed it (Google Hotels prints it with taxes and fees for the whole stay).");
  }
  if (c.kept.some((h) => h.price_per_night === undefined)) {
    out.push(`${c.kept.filter((h) => h.price_per_night === undefined).length} hotel(s) showed no price (sold out or "View prices" only); they have no price_per_night.`);
  }
  if (q.sort === "price" && c.kept.some((h) => h.price_per_night === undefined)) out.push("Sorted by nightly price ascending; hotels without a price are last.");
  if (q.sort === "rating" && c.kept.some((h) => h.rating === undefined)) out.push("Sorted by guest rating descending; hotels without a rating are last.");
  for (const note of c.providerCaveats) if (!out.includes(note)) out.push(note);
  if (c.omitted > 0) {
    out.push(`${c.omitted} further hotel(s) were left out to stay within max_results (${q.max_results}).`);
  }
  if (c.kept.length === 0) out.push("No hotels were found for this search.");
  out.push(PRICE_DISCLAIMER);
  return out;
}
