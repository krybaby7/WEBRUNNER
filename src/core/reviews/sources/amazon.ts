import { amazonReviewsRecipe } from "../../browser/recipes/amazon-reviews.js";
import type { ReviewKind } from "../../../schemas/reviews.js";
import { BrowserReviewSourceBase, kindsDefaultingTo, type BrowserReviewSourceOptions, type ReviewsRecipe } from "./shared-browser.js";

export interface AmazonReviewSourceOptions extends BrowserReviewSourceOptions {
  /** For tests. Defaults to the live Amazon recipe. */
  recipe?: ReviewsRecipe;
}

/**
 * Amazon customer reviews through the browser and `core/browser/recipes/amazon-reviews.ts`
 * (PLAN.md 14.6). Amazon shows the reviews list only to signed-in visitors:
 * the source then fails with `blocked` and `needsLogin` naming `accounts connect amazon`.
 */
export class AmazonReviewSource extends BrowserReviewSourceBase {
  readonly name = "amazon" as const;
  readonly defaultKinds: readonly ReviewKind[] = kindsDefaultingTo("amazon");
  protected readonly site = "Amazon";
  protected readonly recipe: ReviewsRecipe;

  constructor(options: AmazonReviewSourceOptions = {}) {
    super(options);
    this.recipe = options.recipe ?? amazonReviewsRecipe;
  }
}
