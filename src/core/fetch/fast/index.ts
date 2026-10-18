import type { Config } from "../../../config.js";
import { log } from "../../../log.js";
import { THIN_THRESHOLD_CHARS, visibleTextLength } from "../botwall.js";
import { FetchError, type FetchOpts, type FetchResult, type Fetcher } from "../types.js";
import { DirectFetcher } from "./direct.js";
import { FirecrawlFetcher } from "./firecrawl.js";
import { JinaFetcher } from "./jina.js";
import type { FetchImpl } from "./shared.js";

export { DirectFetcher } from "./direct.js";
export { FirecrawlFetcher } from "./firecrawl.js";
export { JinaFetcher } from "./jina.js";

/**
 * Fast fetchers in priority order: Firecrawl (only when a key is set), Jina
 * Reader, then direct HTTP with Readability.
 */
export function buildFastFetchers(config: Config, fetchImpl?: FetchImpl): Fetcher[] {
  const fetchers: Fetcher[] = [];
  const firecrawl = new FirecrawlFetcher({ apiKey: config.firecrawl_api_key, fetchImpl });
  if (firecrawl.isConfigured()) fetchers.push(firecrawl);
  fetchers.push(new JinaFetcher({ apiKey: config.jina_api_key, fetchImpl }));
  fetchers.push(new DirectFetcher({ fetchImpl }));
  return fetchers;
}

function isGood(result: FetchResult): boolean {
  return !result.botWall && visibleTextLength(result.markdown) > THIN_THRESHOLD_CHARS;
}

/** Real content beats a bot wall; among equals, more visible text wins. */
function isBetter(candidate: FetchResult, current: FetchResult): boolean {
  if (candidate.botWall !== current.botWall) return !candidate.botWall;
  return visibleTextLength(candidate.markdown) > visibleTextLength(current.markdown);
}

/**
 * Try each fetcher in order and stop at the first good result: more than 500
 * visible characters and no bot wall. Otherwise return the best result seen
 * (`botWall` carried through, so the caller can fall back to the browser).
 * Throws the last FetchError only when every fetcher threw.
 */
export async function runFastChain(
  fetchers: readonly Fetcher[],
  url: string,
  opts: FetchOpts,
  signal: AbortSignal,
): Promise<FetchResult> {
  let best: FetchResult | undefined;
  let lastError: FetchError | undefined;

  for (const fetcher of fetchers) {
    if (signal.aborted) break;
    try {
      const result = await fetcher.fetch(url, opts, signal);
      if (isGood(result)) return result;
      log.debug("fast fetcher result not good enough", {
        fetcher: fetcher.name,
        url,
        botWall: result.botWall,
        visible_chars: visibleTextLength(result.markdown),
      });
      if (best === undefined || isBetter(result, best)) best = result;
    } catch (err) {
      lastError =
        err instanceof FetchError
          ? err
          : new FetchError(fetcher.name, "provider", err instanceof Error ? err.message : String(err), false);
      log.debug("fast fetcher failed", { fetcher: fetcher.name, url, code: lastError.code, error: lastError.message });
    }
  }

  if (best !== undefined) return best;
  if (lastError !== undefined) throw lastError;
  if (signal.aborted) throw new FetchError(fetchers[0]?.name ?? "direct", "timeout", "Fetch was aborted", false);
  throw new FetchError("direct", "config", "No fast fetchers are available", false);
}
