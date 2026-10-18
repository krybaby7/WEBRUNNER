import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRecipeRegistry } from "../../../src/core/browser/recipes/registry.js";
import { googleFlightsRecipe } from "../../../src/core/browser/recipes/google-flights.js";
import { RecipeError, type Recipe } from "../../../src/core/browser/recipes/types.js";

function recipe(site: string): Recipe<{ q: string }, string[]> {
  return {
    site,
    paramsSchema: z.object({ q: z.string() }),
    resultSchema: z.array(z.string()),
    run: async (_page, params) => [params.q],
  };
}

describe("recipe registry", () => {
  it("registers, gets and lists recipes by site", () => {
    const reg = createRecipeRegistry();
    expect(reg.list()).toEqual([]);
    expect(reg.get("a")).toBeUndefined();
    const a = recipe("a");
    const b = recipe("b");
    reg.register(a);
    reg.register(b);
    expect(reg.get("a")).toBe(a);
    expect(reg.get("b")).toBe(b);
    expect(reg.list().map((r) => r.site)).toEqual(["a", "b"]);
  });

  it("rejects a second recipe for the same site", () => {
    const reg = createRecipeRegistry();
    reg.register(recipe("a"));
    expect(() => reg.register(recipe("a"))).toThrow(/already registered/);
  });

  it("holds the Google Flights recipe", () => {
    const reg = createRecipeRegistry();
    reg.register(googleFlightsRecipe);
    expect(reg.get("google_flights")).toBe(googleFlightsRecipe);
  });

  it("registries are independent", () => {
    const one = createRecipeRegistry();
    const two = createRecipeRegistry();
    one.register(recipe("a"));
    expect(two.get("a")).toBeUndefined();
  });
});

describe("RecipeError", () => {
  it("carries a code and a default retryable flag", () => {
    expect(new RecipeError("blocked", "x")).toMatchObject({ code: "blocked", retryable: false, name: "RecipeError" });
    expect(new RecipeError("timeout", "x").retryable).toBe(true);
    expect(new RecipeError("provider", "x").retryable).toBe(true);
    expect(new RecipeError("config", "x").retryable).toBe(false);
    expect(new RecipeError("invalid_input", "x").retryable).toBe(false);
    expect(new RecipeError("provider", "x", { retryable: false }).retryable).toBe(false);
    const cause = new Error("inner");
    expect(new RecipeError("provider", "x", { cause }).cause).toBe(cause);
  });
});
