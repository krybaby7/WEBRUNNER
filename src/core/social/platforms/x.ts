import { isXUrl, xSearchRecipe } from "../../browser/recipes/x-search.js";
import type { SocialRecipe } from "../../browser/recipes/social-common.js";
import { BrowserSocialProvider, type BrowserSocialProviderOptions } from "./shared-browser.js";

export interface XProviderOptions extends BrowserSocialProviderOptions {
  /** For tests. Defaults to the live X recipe. */
  recipe?: SocialRecipe;
}

/** X (Twitter) through the browser and `core/browser/recipes/x-search.ts`. Login required (PLAN.md 14.5). */
export class XProvider extends BrowserSocialProvider {
  readonly name = "x" as const;
  protected readonly siteName = "X";

  constructor(options: XProviderOptions = {}) {
    super(options.recipe ?? xSearchRecipe, options);
  }

  ownsUrl(url: string): boolean {
    return isXUrl(url);
  }
}
