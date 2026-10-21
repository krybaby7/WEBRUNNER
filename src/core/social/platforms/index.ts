import type { Config } from "../../../config.js";
import type { BrowserSession } from "../../browser/types.js";
import type { LlmClient } from "../../llm/types.js";
import type { SocialPlatformProvider } from "../types.js";
import { BlueskyProvider } from "./bluesky.js";
import { buildBrowserSocialPlatforms } from "./browser.js";
import { HackerNewsProvider } from "./hackernews.js";
import { RedditProvider } from "./reddit.js";
import { YouTubeProvider } from "./youtube.js";

export { BlueskyProvider, HackerNewsProvider, RedditProvider, YouTubeProvider };

/** Shared services some platforms need. Browser platforms are left out when there is no browser. */
export interface SocialPlatformDeps {
  browser?: BrowserSession;
  llm?: LlmClient;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Package version, for Reddit's default User-Agent. */
  version: string;
}

/**
 * Every social platform, configured or not, one per `SOCIAL_PLATFORMS` entry
 * where possible (PLAN.md 14.5). `social_search` uses the full list to tell a
 * caller that an explicitly requested platform is unavailable rather than
 * silently ignoring it.
 */
export function buildAllSocialPlatforms(config: Config, deps: SocialPlatformDeps): SocialPlatformProvider[] {
  const fetchImpl = deps.fetchImpl;

  // Browser platforms (WP18b) exist only when there is a browser session; the
  // Reddit browser recipe is the API provider's fallback for 403/429 (PLAN.md 14.5).
  const browserBuilt =
    deps.browser !== undefined
      ? buildBrowserSocialPlatforms({ browser: deps.browser, ...(deps.llm !== undefined && { llm: deps.llm }) })
      : undefined;
  const redditFallback: SocialPlatformProvider | undefined = browserBuilt?.redditBrowser;
  const browserPlatforms: SocialPlatformProvider[] = browserBuilt !== undefined ? [browserBuilt.x, browserBuilt.facebook] : [];

  return [
    new RedditProvider({
      ...(config.reddit_client_id !== undefined && { clientId: config.reddit_client_id }),
      ...(config.reddit_client_secret !== undefined && { clientSecret: config.reddit_client_secret }),
      ...(config.reddit_user_agent !== undefined && { userAgent: config.reddit_user_agent }),
      version: deps.version,
      ...(fetchImpl !== undefined && { fetchImpl }),
      ...(redditFallback !== undefined && { fallback: redditFallback }),
    }),
    new HackerNewsProvider({ ...(fetchImpl !== undefined && { fetchImpl }) }),
    new BlueskyProvider({ ...(fetchImpl !== undefined && { fetchImpl }) }),
    ...browserPlatforms,
    new YouTubeProvider({
      ...(config.youtube_api_key !== undefined && { apiKey: config.youtube_api_key }),
      ...(fetchImpl !== undefined && { fetchImpl }),
    }),
  ];
}

/** Platforms that are configured and ready to search. */
export function buildSocialPlatforms(config: Config, deps: SocialPlatformDeps): SocialPlatformProvider[] {
  return buildAllSocialPlatforms(config, deps).filter((p) => p.isConfigured());
}
