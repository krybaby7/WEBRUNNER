import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { resolveHeadless } from "../core/browser/session.js";
import { buildFastFetchers } from "../core/fetch/fast/index.js";
import { buildAllFlightProviders } from "../core/flights/providers/index.js";
import { buildProviders } from "../core/search/providers/index.js";
import type { Deps } from "../deps.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";
import { getVersion } from "../server.js";

const DESCRIPTION =
  "Report the server's own status: version, uptime, which providers and fetchers are configured (names only, never key values), " +
  "the model routing, the browser mode and session state, the disk cache size and the registered tool names. " +
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
    currency: z.string(),
    models: z.object({ planner: z.string(), scorer: z.string(), extractor: z.string(), writer: z.string() }),
    cache_dir: z.string(),
    browser: z.object({
      mode: z.enum(["persistent", "cdp"]),
      profile_dir: z.string().optional(),
      cdp_url: z.string().optional(),
      headless_default: z.boolean(),
    }),
  }),
  browser: BrowserStatsSchema.nullable(),
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
        return jsonResult({
          version: getVersion(),
          uptime_s: Math.round(process.uptime()),
          config: {
            anthropic_api_key: config.anthropic_api_key !== undefined,
            search_providers: buildProviders(config).map((p) => p.name),
            fast_fetchers: buildFastFetchers(config).map((f) => f.name),
            flight_sources: buildAllFlightProviders(config, {
              ...(browser !== undefined && { browser }),
              ...(deps.llm !== undefined && { llm: deps.llm }),
            })
              .filter((p) => p.isConfigured())
              .map((p) => p.name),
            currency: config.currency,
            models: { ...config.models },
            cache_dir: config.cache_dir,
            browser: browserConfig(config),
          },
          browser: browser === undefined ? null : { ...browser.stats(), is_open: browser.isOpen() },
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
