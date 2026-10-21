import { facebookSearchRecipe, isFacebookUrl } from "../../browser/recipes/facebook-search.js";
import type { SocialRecipe } from "../../browser/recipes/social-common.js";
import { BrowserSocialProvider, type BrowserSocialProviderOptions } from "./shared-browser.js";

export interface FacebookProviderOptions extends BrowserSocialProviderOptions {
  /** For tests. Defaults to the live Facebook recipe. */
  recipe?: SocialRecipe;
}

/**
 * Facebook through the browser and `core/browser/recipes/facebook-search.ts`.
 * Login required; extraction is LLM-only, so without an LLM client every call
 * fails with code `config` before a page is opened (PLAN.md 14.5).
 */
export class FacebookProvider extends BrowserSocialProvider {
  readonly name = "facebook" as const;
  protected readonly siteName = "Facebook";
  protected override readonly requiresLlm = true;

  constructor(options: FacebookProviderOptions = {}) {
    super(options.recipe ?? facebookSearchRecipe, options);
  }

  ownsUrl(url: string): boolean {
    return isFacebookUrl(url);
  }
}
