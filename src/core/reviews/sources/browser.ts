import type { Logger } from "../../../log.js";
import type { BrowserSession } from "../../browser/types.js";
import type { LlmClient } from "../../llm/types.js";
import type { ReviewSourceProvider } from "../types.js";
import { AmazonReviewSource } from "./amazon.js";
import { GoogleMapsReviewSource } from "./google-maps.js";
import { GooglePlayReviewSource } from "./google-play.js";

export type BrowserReviewSourceName = "google_maps" | "google_play" | "amazon";

export interface BrowserReviewSourcesOptions {
  /** The shared browser session. Without it the three sources exist but report themselves unconfigured. */
  browser?: BrowserSession;
  /** For the schema-driven fallback extraction. Optional: the deterministic probes work without it. */
  llm?: LlmClient;
  log?: Logger;
  /** Per-source budget override in ms (default 60 s each, PLAN.md 14.6). */
  timeoutsMs?: Partial<Record<BrowserReviewSourceName, number>>;
}

/**
 * The three browser-based review sources (PLAN.md 14.6): google_maps,
 * google_play and amazon. `src/core/reviews/sources/index.ts` spreads this
 * list into `buildAllReviewSources`.
 */
export function buildBrowserReviewSources(opts: BrowserReviewSourcesOptions = {}): ReviewSourceProvider[] {
  const shared = {
    ...(opts.browser !== undefined && { browser: opts.browser }),
    ...(opts.llm !== undefined && { llm: opts.llm }),
    ...(opts.log !== undefined && { log: opts.log }),
  };
  const timeout = (name: BrowserReviewSourceName): { timeoutMs?: number } => {
    const ms = opts.timeoutsMs?.[name];
    return ms !== undefined ? { timeoutMs: ms } : {};
  };
  return [
    new GoogleMapsReviewSource({ ...shared, ...timeout("google_maps") }),
    new GooglePlayReviewSource({ ...shared, ...timeout("google_play") }),
    new AmazonReviewSource({ ...shared, ...timeout("amazon") }),
  ];
}
