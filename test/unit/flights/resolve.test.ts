import { describe, expect, it, vi } from "vitest";
import { resolvePlace } from "../../../src/core/flights/resolve.js";
import { LlmError, type LlmClient } from "../../../src/core/llm/types.js";
import { FlightsInputError } from "../../../src/schemas/flights.js";
import { promptOf, scriptedLlm } from "./gf-helpers.js";

describe("resolvePlace", () => {
  it("resolves from the static table without calling the model", async () => {
    const llm = scriptedLlm(() => ({ iata: "XXX", confidence: "high" }));
    await expect(resolvePlace("London", llm)).resolves.toBe("LON");
    await expect(resolvePlace("lhr", llm)).resolves.toBe("LHR");
    await expect(resolvePlace("  Heathrow ", llm)).resolves.toBe("LHR");
    expect(llm.calls).toHaveLength(0);
  });

  it("works without a model when the table suffices", async () => {
    await expect(resolvePlace("Tokyo", undefined)).resolves.toBe("TYO");
  });

  it("asks the model when the table has no answer, and accepts a high-confidence code", async () => {
    const llm = scriptedLlm(() => ({ iata: "tll", confidence: "high" }));
    await expect(resolvePlace("the capital of Estonia", llm)).resolves.toBe("TLL");
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    expect(req.role).toBe("extractor");
    expect(req.effort).toBe("low");
    expect(req.schema).toBeDefined();
    expect(promptOf(req)).toContain("the capital of Estonia");
  });

  it.each([
    ["medium confidence", { iata: "TLL", confidence: "medium", note: "could also be Tampere" }, /medium confidence/],
    ["low confidence", { iata: "TLL", confidence: "low" }, /low confidence/],
    ["no code", { iata: null, confidence: "high" }, /no code/],
    ["a code of the wrong shape", { iata: "TALLINN", confidence: "high" }, /not certain enough/],
    ["an unusable answer", { nonsense: true }, /usable answer/],
  ])("refuses %s with a message listing what was tried", async (_name, answer, tried) => {
    const llm = scriptedLlm(() => answer);
    const err = await resolvePlace("Springfield", llm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlightsInputError);
    const message = (err as FlightsInputError).message;
    expect(message).toMatch(/built-in airport table/);
    expect(message).toMatch(tried);
    expect(message).toMatch(/IATA code/);
    expect((err as FlightsInputError).code).toBe("invalid_input");
  });

  it("says so when the model fallback is unavailable", async () => {
    const err = await resolvePlace("Springfield", undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlightsInputError);
    expect((err as Error).message).toMatch(/LLM fallback is not available/);
  });

  it("turns 'no API key' into an input error that names the key", async () => {
    const llm: LlmClient = {
      complete: vi.fn().mockRejectedValue(new LlmError("config", "not_configured", "no key", { retryable: false })),
    };
    const err = await resolvePlace("Springfield", llm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlightsInputError);
    expect((err as Error).message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("lets other model failures through so the tool reports them by their own code", async () => {
    const llm: LlmClient = {
      complete: vi.fn().mockRejectedValue(new LlmError("budget_exceeded", "api", "cap reached", { retryable: false })),
    };
    const err = await resolvePlace("Springfield", llm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("budget_exceeded");
  });
});
