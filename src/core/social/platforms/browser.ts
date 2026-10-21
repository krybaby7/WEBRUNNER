import type { Logger } from "../../../log.js";
import type { BrowserSession } from "../../browser/types.js";
import type { LlmClient } from "../../llm/types.js";
import type { SocialPlatformProvider } from "../types.js";
import { FacebookProvider } from "./facebook.js";
import { RedditBrowserProvider } from "./reddit-browser.js";
import { XProvider } from "./x.js";

/**
 * The browser social platforms (WP18b), built once from the shared session and
 * LLM client. `platforms/index.ts` (WP18a) spreads `x` and `facebook` into its
 * platform list and hands `redditBrowser` to the Reddit API provider as its
 * `fallback`.
 */
export interface BrowserSocialPlatformsOptions {
  browser: BrowserSession;
  llm?: LlmClient;
  log?: Logger;
  /** Per-platform call budget in ms. Default 60000 each (PLAN.md 14.5). */
  timeoutsMs?: Partial<Record<"x" | "facebook" | "reddit", number>>;
}

export interface BrowserSocialPlatforms {
  x: SocialPlatformProvider;
  facebook: SocialPlatformProvider;
  redditBrowser: SocialPlatformProvider;
}

export function buildBrowserSocialPlatforms(opts: BrowserSocialPlatformsOptions): BrowserSocialPlatforms {
  const common = {
    browser: opts.browser,
    ...(opts.llm !== undefined && { llm: opts.llm }),
    ...(opts.log !== undefined && { log: opts.log }),
  };
  const timeout = (p: "x" | "facebook" | "reddit"): { timeoutMs?: number } => {
    const t = opts.timeoutsMs?.[p];
    return t === undefined ? {} : { timeoutMs: t };
  };
  return {
    x: new XProvider({ ...common, ...timeout("x") }),
    facebook: new FacebookProvider({ ...common, ...timeout("facebook") }),
    redditBrowser: new RedditBrowserProvider({ ...common, ...timeout("reddit") }),
  };
}
