import type { Recipe } from "./types.js";

/** Registry of site recipes, keyed by `Recipe.site`. */
export interface RecipeRegistry {
  /** Throws when a recipe for the same site is already registered. */
  register<TParams, TResult>(recipe: Recipe<TParams, TResult>): void;
  get<TParams = unknown, TResult = unknown>(site: string): Recipe<TParams, TResult> | undefined;
  list(): Array<Recipe<unknown, unknown>>;
}

export function createRecipeRegistry(): RecipeRegistry {
  const recipes = new Map<string, Recipe<unknown, unknown>>();
  return {
    register(recipe) {
      if (recipes.has(recipe.site)) {
        throw new Error(`a recipe for site "${recipe.site}" is already registered`);
      }
      recipes.set(recipe.site, recipe as unknown as Recipe<unknown, unknown>);
    },
    get<TParams, TResult>(site: string) {
      return recipes.get(site) as unknown as Recipe<TParams, TResult> | undefined;
    },
    list() {
      return [...recipes.values()];
    },
  };
}
