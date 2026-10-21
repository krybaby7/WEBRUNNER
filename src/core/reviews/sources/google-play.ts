import { googlePlayReviewsRecipe } from "../../browser/recipes/google-play-reviews.js";
import type { ReviewKind } from "../../../schemas/reviews.js";
import { BrowserReviewSourceBase, kindsDefaultingTo, type BrowserReviewSourceOptions, type ReviewsRecipe } from "./shared-browser.js";

export interface GooglePlayReviewSourceOptions extends BrowserReviewSourceOptions {
  /** For tests. Defaults to the live Google Play recipe. */
  recipe?: ReviewsRecipe;
}

/** Google Play app reviews through the browser and `core/browser/recipes/google-play-reviews.ts` (PLAN.md 14.6). */
export class GooglePlayReviewSource extends BrowserReviewSourceBase {
  readonly name = "google_play" as const;
  readonly defaultKinds: readonly ReviewKind[] = kindsDefaultingTo("google_play");
  protected readonly site = "Google Play";
  protected readonly recipe: ReviewsRecipe;

  constructor(options: GooglePlayReviewSourceOptions = {}) {
    super(options);
    this.recipe = options.recipe ?? googlePlayReviewsRecipe;
  }
}
