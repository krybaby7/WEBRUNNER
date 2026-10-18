import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "../../../src/config.js";
import { resolveModel, ROLE_DEFAULTS } from "../../../src/core/llm/models.js";
import { ROLES } from "../../../src/core/llm/types.js";
import { makeConfig } from "./helpers.js";

describe("resolveModel", () => {
  it("returns the routing table defaults", () => {
    const config = makeConfig({ models: { ...DEFAULT_MODELS } });
    expect(resolveModel("planner", config)).toBe("claude-opus-5-5");
    expect(resolveModel("scorer", config)).toBe("claude-haiku-5-5");
    expect(resolveModel("extractor", config)).toBe("claude-sonnet-5-5");
    expect(resolveModel("writer", config)).toBe("claude-opus-5-5");
  });

  it("honors config.models overrides, per role", () => {
    const config = makeConfig({
      models: { planner: "claude-fable-5-1", scorer: "claude-sonnet-5-5", extractor: "x-extractor", writer: "x-writer" },
    });
    expect(resolveModel("planner", config)).toBe("claude-fable-5-1");
    expect(resolveModel("scorer", config)).toBe("claude-sonnet-5-5");
    expect(resolveModel("extractor", config)).toBe("x-extractor");
    expect(resolveModel("writer", config)).toBe("x-writer");
  });
});

describe("ROLE_DEFAULTS", () => {
  it("matches the routing table", () => {
    expect(ROLE_DEFAULTS.planner).toEqual({ effort: "high", maxTokens: 8192 });
    expect(ROLE_DEFAULTS.scorer).toEqual({ effort: "low", maxTokens: 8192 });
    expect(ROLE_DEFAULTS.extractor).toEqual({ effort: "medium", maxTokens: 8192 });
    expect(ROLE_DEFAULTS.writer).toEqual({ effort: "high", maxTokens: 32000 });
  });

  it("covers every role", () => {
    expect(Object.keys(ROLE_DEFAULTS).sort()).toEqual([...ROLES].sort());
  });
});
