import { googleMapsReviewsRecipe } from "../../browser/recipes/google-maps-reviews.js";
import type { ReviewKind } from "../../../schemas/reviews.js";
import { BrowserReviewSourceBase, kindsDefaultingTo, type BrowserReviewSourceOptions, type ReviewsRecipe } from "./shared-browser.js";

export interface GoogleMapsReviewSourceOptions extends BrowserReviewSourceOptions {
  /** For tests. Defaults to the live Google Maps recipe. */
  recipe?: ReviewsRecipe;
}

/** Google Maps place reviews through the browser and `core/browser/recipes/google-maps-reviews.ts` (PLAN.md 14.6). */
export class GoogleMapsReviewSource extends BrowserReviewSourceBase {
  readonly name = "google_maps" as const;
  readonly defaultKinds: readonly ReviewKind[] = kindsDefaultingTo("google_maps");
  protected readonly site = "Google Maps";
  protected readonly recipe: ReviewsRecipe;

  constructor(options: GoogleMapsReviewSourceOptions = {}) {
    super(options);
    this.recipe = options.recipe ?? googleMapsReviewsRecipe;
  }
}
