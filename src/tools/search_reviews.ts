import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import type { Cache } from "../core/cache/index.js";
import { LlmError } from "../core/llm/types.js";
import { createReviewsService, ReviewsSearchError } from "../core/reviews/index.js";
import { buildAllReviewSources } from "../core/reviews/sources/index.js";
import type { ReviewSourceProvider } from "../core/reviews/types.js";
import { toolError } from "../schemas/error.js";
import { SearchReviewsInputSchema, SearchReviewsOutputSchema, type ReviewSource } from "../schemas/reviews.js";
import { jsonResult } from "../schemas/result.js";
import { dailyCapResult, runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Reviews of a place, business, product or app from review sites, with the subject each site matched. Sources: App Store (keyless feed), Trustpilot (public page; falls back to the browser and the Claude API when the site serves a bot-wall challenge), Google Maps, Google Play and Amazon (read through the real browser; Amazon may need a connected account, see the accounts tool). " +
  "Takes a name or a product, place or app URL, an optional kind (place, business, product, app) that picks the default sources, rating and recency filters, a sort and per-source limits; returns reviews with rating (1 to 5), title, text, date, author, version and the owner's reply where the site shows them, plus each source's subject with average rating and review count (Google Maps adds the address and the weekly opening hours, Monday first; when its search lists several places, a caveat names the one it opened). " +
  "summarize: true adds a short themed summary (needs a model backend: ANTHROPIC_API_KEY or the claude CLI; capped by max_cost_usd). This tool reads only: it never writes reviews, logs in, likes or posts. " +
  "For personal, low-volume use: reading Google Maps, Google Play and Amazon automatically is against their terms of service, and doing so through the owner's account can get it rate-limited. " +
  "A source that fails is listed in sources_failed (needs_login says when an account is required) while the others still answer; results are cached for 1 hour per source and subject. The whole call is capped at 180 seconds; past that it returns error code timeout (retryable).";

export interface SearchReviewsToolOptions {
  /** Replaces the real sources. For tests. */
  sources?: (deps: Deps) => ReviewSourceProvider[];
  /** Overrides the per-source timeouts. For tests. */
  timeoutsMs?: Partial<Record<ReviewSource, number>>;
  /** Overrides the 180 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

/** When `buildDeps` has not run (tests), nothing is remembered. */
const NO_CACHE: Cache = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
};

export function registerSearchReviewsTool(server: McpServer, deps: Deps, options: SearchReviewsToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.search_reviews;
  const makeSources =
    options.sources ??
    ((d: Deps): ReviewSourceProvider[] =>
      buildAllReviewSources(d.config, {
        ...(d.browser !== undefined && { browser: d.browser }),
        ...(d.llm !== undefined && { llm: d.llm }),
        ...(d.fetch !== undefined && { fetch: d.fetch }),
      }));

  server.registerTool(
    "search_reviews",
    {
      title: "Search reviews",
      description: DESCRIPTION,
      inputSchema: SearchReviewsInputSchema,
      outputSchema: SearchReviewsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("search_reviews", capMs, async (wallSignal) => {
        try {
          const parsed = SearchReviewsInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const input = parsed.data;
          if (input.summarize) {
            const overDailyCap = dailyCapResult(deps);
            if (overDailyCap !== undefined) return overDailyCap;
          }

          const service = createReviewsService({
            sources: makeSources(deps),
            cache: deps.cache ?? NO_CACHE,
            ...(deps.llm !== undefined && { llm: deps.llm }),
            log: deps.log,
            ...(options.timeoutsMs !== undefined && { timeoutsMs: options.timeoutsMs }),
          });
          const signal = AbortSignal.any([extra.signal, wallSignal]);
          let output;
          try {
            output = await service.search(input, signal);
          } catch (err) {
            if (err instanceof ReviewsSearchError) return toolError(err.code, err.message, err.retryable, err.details);
            if (err instanceof LlmError) return toolError(err.code, err.message, err.retryable, err.details);
            throw err;
          }

          const checked = SearchReviewsOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("search_reviews produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "search_reviews produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          // Anything that escapes the per-source handling (a throwing source factory, a merge bug).
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("search_reviews failed unexpectedly", { error: message });
          return toolError("internal", `search_reviews failed: ${message}`, false);
        }
      }),
  );
}
