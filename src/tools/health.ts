import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { createAccountsService } from "../core/accounts/index.js";
import { resolveHeadless } from "../core/browser/session.js";
import { buildFastFetchers } from "../core/fetch/fast/index.js";
import { buildAllFlightProviders } from "../core/flights/providers/index.js";
import { buildAllHotelProviders } from "../core/hotels/providers/index.js";
import { buildAllMarketProviders } from "../core/markets/providers/index.js";
import { buildAllReviewSources } from "../core/reviews/sources/index.js";
import { buildProviders } from "../core/search/providers/index.js";
import { buildAllSocialPlatforms } from "../core/social/platforms/index.js";
import { modelBackend, type Deps } from "../deps.js";
import { AccountPlatformSchema } from "../schemas/accounts.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";
import { getVersion } from "../server.js";

const DESCRIPTION =
  "Report the server's own status: version, uptime, which providers, fetchers, flight, hotel, market, social and review sources are configured (names only, never key values), " +
  "which optional keys are set, the model routing, the browser mode and session state, which account platforms are connected in an already-open browser (names only), the disk cache size and the registered tool names. " +
  "Read-only, takes no input, and never starts a browser or makes a network call. Use it to find out why a tool returns a `config` error.";

const BrowserStatsSchema = z.object({
  mode: z.enum(["persistent", "cdp"]).nullable(),
  open: z.boolean(),
  closed: z.boolean(),
  headless: z.boolean(),
  activePages: z.number(),
  waiting: z.number(),
  maxPages: z.number(),
  totalAcquired: z.number(),
  launchedAt: z.string().optional(),
  is_open: z.boolean(),
});

const HealthOutputSchema = z.object({
  version: z.string(),
  uptime_s: z.number(),
  config: z.object({
    anthropic_api_key: z.boolean(),
    search_providers: z.array(z.string()),
    fast_fetchers: z.array(z.string()),
    flight_sources: z.array(z.string()),
    hotel_sources: z.array(z.string()),
    market_sources: z.array(z.string()),
    social_platforms: z.array(z.object({ name: z.string(), access: z.enum(["api", "browser"]) })),
    review_sources: z.array(z.string()),
    reddit_api: z.boolean(),
    youtube_api_key: z.boolean(),
    finnhub_api_key: z.boolean(),
    currency: z.string(),
    models: z.object({ planner: z.string(), scorer: z.string(), extractor: z.string(), writer: z.string() }),
    llm: z.object({ backend: z.enum(["api", "claude-cli", "none"]), fallback: z.enum(["codex-cli", "none"]) }),
    cache_dir: z.string(),
    browser: z.object({
      mode: z.enum(["persistent", "cdp"]),
      profile_dir: z.string().optional(),
      cdp_url: z.string().optional(),
      headless_default: z.boolean(),
    }),
  }),
  browser: BrowserStatsSchema.nullable(),
  /** Platforms whose session cookies are present, read only from a browser that is already open; null when none is. */
  accounts: z.object({ connected: z.array(AccountPlatformSchema).nullable() }),
  cache: z.object({ dir: z.string(), entries: z.number(), bytes: z.number() }),
  tools: z.array(z.string()),
});

/** A CDP URL can carry credentials, a token query or a per-browser id in its path; report scheme and host only. */
function redactCdpUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid URL)";
  }
}

/** Count `.json` entry files and their total size under `dir`. A missing or unreadable directory counts as empty. */
export async function measureCache(dir: string): Promise<{ entries: number; bytes: number }> {
  let entries = 0;
  let bytes = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const path = join(current, item.name);
      if (item.isDirectory()) {
        pending.push(path);
      } else if (item.isFile() && item.name.endsWith(".json")) {
        try {
          bytes += (await stat(path)).size;
          entries += 1;
        } catch {
          // Removed while walking (expiry, concurrent clear): not an entry any more.
        }
      }
    }
  }
  return { entries, bytes };
}

function browserConfig(config: Config) {
  const cdpUrl = config.browser.cdp_url;
  return cdpUrl !== undefined
    ? { mode: "cdp" as const, cdp_url: redactCdpUrl(cdpUrl), headless_default: resolveHeadless(config) }
    : { mode: "persistent" as const, profile_dir: config.browser.profile_dir, headless_default: resolveHeadless(config) };
}

/**
 * Account platforms connected in the shared browser, by name. Read only when
 * the browser is already open: `health` must never launch Chromium, and
 * `BrowserSession.cookies()` would. `null` says "not checked", which is
 * different from "none connected".
 */
async function connectedAccounts(deps: Deps): Promise<string[] | null> {
  const { browser } = deps;
  if (browser === undefined || !browser.isOpen()) return null;
  const service = createAccountsService({ browser, config: deps.config, log: deps.log });
  return service.connectedPlatforms();
}

/**
 * `toolNames` is the list of registered tools (`TOOL_NAMES` in ./index.ts);
 * passing it in avoids an import cycle with the registry.
 */
export function registerHealthTool(server: McpServer, deps: Deps, toolNames: readonly string[] = []): void {
  server.registerTool(
    "health",
    {
      title: "Health",
      description: DESCRIPTION,
      outputSchema: HealthOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const { config, browser } = deps;
        const cacheStats = await measureCache(config.cache_dir);
        // Every builder takes the same optional services; none of them touches the browser or the network when building.
        const services = {
          ...(browser !== undefined && { browser }),
          ...(deps.llm !== undefined && { llm: deps.llm }),
        };
        const configured = <T extends { name: string; isConfigured(): boolean }>(list: T[]): T[] => list.filter((p) => p.isConfigured());
        const names = (list: Array<{ name: string }>): string[] => list.map((p) => p.name);
        return jsonResult({
          version: getVersion(),
          uptime_s: Math.round(process.uptime()),
          config: {
            anthropic_api_key: config.anthropic_api_key !== undefined,
            search_providers: names(buildProviders(config)),
            fast_fetchers: names(buildFastFetchers(config)),
            flight_sources: names(configured(buildAllFlightProviders(config, services))),
            hotel_sources: names(configured(buildAllHotelProviders(config, services))),
            market_sources: names(configured(buildAllMarketProviders(config, services))),
            social_platforms: configured(buildAllSocialPlatforms(config, { ...services, version: getVersion() })).map((p) => ({
              name: p.name,
              access: p.access,
            })),
            review_sources: names(
              configured(buildAllReviewSources(config, { ...services, ...(deps.fetch !== undefined && { fetch: deps.fetch }) })),
            ),
            reddit_api: config.reddit_client_id !== undefined && config.reddit_client_secret !== undefined,
            youtube_api_key: config.youtube_api_key !== undefined,
            finnhub_api_key: config.finnhub_api_key !== undefined,
            currency: config.currency,
            models: { ...config.models },
            llm: { backend: modelBackend(deps), fallback: deps.llmInfo?.fallback ?? "none" },
            cache_dir: config.cache_dir,
            browser: browserConfig(config),
          },
          browser: browser === undefined ? null : { ...browser.stats(), is_open: browser.isOpen() },
          accounts: { connected: await connectedAccounts(deps) },
          cache: { dir: config.cache_dir, ...cacheStats },
          tools: [...toolNames],
        });
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
        deps.log.error("health failed unexpectedly", { error: message });
        return toolError("internal", `health failed: ${message}`, false);
      }
    },
  );
}
