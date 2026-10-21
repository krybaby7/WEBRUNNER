import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import { createMarketService, MarketQuoteError, type MarketService } from "../core/markets/index.js";
import { buildAllMarketProviders } from "../core/markets/providers/index.js";
import type { MarketProvider } from "../core/markets/types.js";
import { toolError } from "../schemas/error.js";
import { MarketQuoteInputSchema, MarketQuoteOutputSchema, type MarketSource } from "../schemas/markets.js";
import { jsonResult } from "../schemas/result.js";
import { runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Current prices, and optionally OHLCV price history, for stocks, ETFs, indices and crypto assets. " +
  "Takes 1 to 10 tickers (AAPL, VOD.L, ^GSPC, BTC-USD) or names (Apple, bitcoin); names are looked up first and the best match is quoted, with the other matches named in caveats. " +
  "Sources, tried in turn per symbol: Yahoo Finance (no key; quotes, history and lookup; equity quotes typically delayed 15 minutes), " +
  "Finnhub (needs FINNHUB_API_KEY; US equities, no history), CoinGecko (no key; crypto prices, 24 h change, market cap, history at its own bar size), " +
  "and Google Finance (no key; read through a real browser as the fallback when Yahoo rate-limits; quote only). Crypto goes to CoinGecko first, everything else to Yahoo, then Finnhub, then Google Finance. " +
  "Stocks are quoted in their listing currency; crypto in `currency` (default WEBRUNNER_CURRENCY). History is capped at 1000 bars. " +
  "Each source gets 10 seconds per symbol and the whole call is capped at 30 seconds; past that it returns error code timeout (retryable). " +
  "Quotes may be delayed and are not investment advice. Reading Google Finance automatically is against Google's terms of service; personal use only.";

export interface MarketQuoteToolOptions {
  /** Replaces the real providers. For tests. */
  providers?: (deps: Deps) => MarketProvider[];
  /** Replaces the service built over the providers. For tests. */
  service?: (deps: Deps, providers: MarketProvider[]) => MarketService;
  /** Overrides the per-source timeouts. For tests. */
  timeoutsMs?: Partial<Record<MarketSource, number>>;
  /** Overrides the 30 s wall-clock cap. For tests. */
  wallClockMs?: number;
  /** Clock. For tests. */
  now?: () => number;
}

export function registerMarketQuoteTool(server: McpServer, deps: Deps, options: MarketQuoteToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.market_quote;
  const makeProviders =
    options.providers ??
    ((d: Deps): MarketProvider[] =>
      buildAllMarketProviders(d.config, {
        ...(d.browser !== undefined && { browser: d.browser }),
        ...(d.llm !== undefined && { llm: d.llm }),
      }));
  const makeService =
    options.service ??
    ((d: Deps, providers: MarketProvider[]): MarketService =>
      createMarketService({
        providers,
        ...(d.cache !== undefined && { cache: d.cache }),
        log: d.log,
        ...(options.timeoutsMs !== undefined && { timeoutsMs: options.timeoutsMs }),
        ...(options.now !== undefined && { now: options.now }),
        secrets: [d.config.finnhub_api_key].filter((k): k is string => k !== undefined && k !== ""),
      }));

  server.registerTool(
    "market_quote",
    {
      title: "Market quote",
      description: DESCRIPTION,
      inputSchema: MarketQuoteInputSchema,
      outputSchema: MarketQuoteOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("market_quote", capMs, async (wallSignal) => {
        try {
          const parsed = MarketQuoteInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const input = parsed.data;

          const providers = makeProviders(deps);
          const configured = providers.filter((p) => p.isConfigured()).map((p) => p.name);
          const usable = input.sources === undefined ? configured : configured.filter((s) => input.sources?.includes(s));
          if (usable.length === 0) {
            return toolError(
              "config",
              input.sources === undefined
                ? "No market source is configured. Yahoo Finance and CoinGecko need no key; Finnhub needs FINNHUB_API_KEY; Google Finance needs the browser."
                : `None of the requested sources is configured (${input.sources.join(", ")}). Finnhub needs FINNHUB_API_KEY; Google Finance needs the browser.`,
              false,
            );
          }

          const service = makeService(deps, providers);
          const signal = AbortSignal.any([extra.signal, wallSignal]);
          const output = await service.quote(
            {
              symbols: input.symbols,
              ...(input.history !== undefined && { history: input.history }),
              ...(input.sources !== undefined && { sources: input.sources }),
              currency: input.currency ?? deps.config.currency,
            },
            signal,
          );
          const checked = MarketQuoteOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("market_quote produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "market_quote produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          if (err instanceof MarketQuoteError) return toolError(err.code, err.message, err.retryable, err.details);
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("market_quote failed unexpectedly", { error: message });
          return toolError("internal", `market_quote failed: ${message}`, false);
        }
      }),
  );
}
