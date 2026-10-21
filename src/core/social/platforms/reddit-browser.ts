import { isRedditUrl, redditSearchRecipe } from "../../browser/recipes/reddit-search.js";
import type { SocialRecipe } from "../../browser/recipes/social-common.js";
import { BrowserSocialProvider, type BrowserSocialProviderOptions } from "./shared-browser.js";

export interface RedditBrowserProviderOptions extends BrowserSocialProviderOptions {
  /** For tests. Defaults to the live old.reddit recipe. */
  recipe?: SocialRecipe;
}

/**
 * Reddit through the browser on old.reddit.com and
 * `core/browser/recipes/reddit-search.ts`: the third step of the Reddit access
 * chain (PLAN.md 14.5), handed to the API provider as its `fallback`. Works
 * without an LLM (deterministic markup) and anonymously where Reddit allows it.
 */
export class RedditBrowserProvider extends BrowserSocialProvider {
  readonly name = "reddit" as const;
  protected readonly siteName = "Reddit";

  constructor(options: RedditBrowserProviderOptions = {}) {
    super(options.recipe ?? redditSearchRecipe, options);
  }

  ownsUrl(url: string): boolean {
    return isRedditUrl(url);
  }
}
