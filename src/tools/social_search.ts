import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";
import type { Cache } from "../core/cache/index.js";
import { LlmError } from "../core/llm/types.js";
import { createSocialService, SocialSearchError, type SocialService } from "../core/social/index.js";
import { buildAllSocialPlatforms } from "../core/social/platforms/index.js";
import type { SocialPlatformProvider } from "../core/social/types.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";
import { SocialSearchInputSchema, SocialSearchOutputSchema } from "../schemas/social.js";
import { getVersion } from "../server.js";
import { dailyCapResult, runWithWallClock, TOOL_WALL_CLOCK_MS } from "./guard.js";

const DESCRIPTION =
  "Search what people are saying about something across social platforms, as posts and comments, or read the comments of one thread. " +
  "Platforms: reddit (public JSON endpoints without keys; the Reddit API with REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET), hackernews and bluesky (no key), " +
  "youtube (needs YOUTUBE_API_KEY; each search costs 100 of the 10,000 daily quota units), x and facebook (read through a real browser with your own connected account: connect one with the accounts tool, otherwise they report needs_login). " +
  "Give `query` to search, or `url` (a Reddit, Hacker News, Bluesky, YouTube, X or Facebook post URL) to get that thread's comments: the first item is the post, the rest are its comments. " +
  "Results are merged across platforms, deduplicated by URL and sorted by engagement (score) or recency; `summarize: true` adds a short 'what people are saying' summary with themes and sentiment (needs a model backend: ANTHROPIC_API_KEY or the claude CLI; capped by max_cost_usd). " +
  "This tool reads only and never posts, likes, follows or replies. For personal, low-volume use: reading X and Facebook automatically through your own account is against their terms of service and can get the account rate-limited or suspended. " +
  "API platforms get 15 seconds each and browser platforms 60; the whole call is capped at 180 seconds; past that it returns error code timeout (retryable).";

export interface SocialSearchToolOptions {
  /** Replaces the real platforms. For tests. */
  platforms?: (deps: Deps) => SocialPlatformProvider[];
  /** Overrides the per-platform timeouts by access kind. For tests. */
  timeoutsMs?: Partial<Record<SocialPlatformProvider["access"], number>>;
  /** Overrides the 180 s wall-clock cap. For tests. */
  wallClockMs?: number;
}

/** Stands in when `deps.cache` is unset (tests): every lookup misses. */
const NO_CACHE: Cache = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
};

export function registerSocialSearchTool(server: McpServer, deps: Deps, options: SocialSearchToolOptions = {}): void {
  const capMs = options.wallClockMs ?? TOOL_WALL_CLOCK_MS.social_search;
  const makePlatforms =
    options.platforms ??
    ((d: Deps): SocialPlatformProvider[] =>
      buildAllSocialPlatforms(d.config, {
        ...(d.browser !== undefined && { browser: d.browser }),
        ...(d.llm !== undefined && { llm: d.llm }),
        version: getVersion(),
      }));

  // Built on first use and kept, so the Reddit token cache outlives one call.
  let service: SocialService | undefined;
  function getService(): SocialService {
    if (service === undefined) {
      const secrets = [deps.config.reddit_client_id, deps.config.reddit_client_secret, deps.config.youtube_api_key].filter(
        (k): k is string => k !== undefined && k !== "",
      );
      service = createSocialService({
        platforms: makePlatforms(deps),
        cache: deps.cache ?? NO_CACHE,
        ...(deps.llm !== undefined && { llm: deps.llm }),
        log: deps.log,
        ...(options.timeoutsMs !== undefined && { timeoutsMs: options.timeoutsMs }),
        secrets,
      });
    }
    return service;
  }

  server.registerTool(
    "social_search",
    {
      title: "Social search",
      description: DESCRIPTION,
      inputSchema: SocialSearchInputSchema,
      outputSchema: SocialSearchOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      runWithWallClock("social_search", capMs, async (wallSignal) => {
        try {
          const parsed = SocialSearchInputSchema.safeParse(args);
          if (!parsed.success) {
            return toolError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), false);
          }
          const input = parsed.data;
          if (input.summarize) {
            const capped = dailyCapResult(deps);
            if (capped !== undefined) return capped;
          }

          const output = await getService().search(input, { signal: AbortSignal.any([extra.signal, wallSignal]) });
          const checked = SocialSearchOutputSchema.safeParse(output);
          if (!checked.success) {
            deps.log.error("social_search produced an invalid result", { issues: checked.error.issues.length });
            return toolError("internal", "social_search produced a result that failed its own schema check", false);
          }
          return jsonResult(checked.data);
        } catch (err) {
          if (err instanceof SocialSearchError) {
            return toolError(err.code, err.message, err.retryable, { platforms_failed: err.platformsFailed });
          }
          if (err instanceof LlmError) return toolError(err.code, err.message, err.retryable, err.details);
          // Anything that escapes the per-platform handling (a throwing platform factory, a merge bug).
          const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
          deps.log.error("social_search failed unexpectedly", { error: message });
          return toolError("internal", `social_search failed: ${message}`, false);
        }
      }),
  );
}
