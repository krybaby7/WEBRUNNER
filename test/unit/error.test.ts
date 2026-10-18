import { describe, expect, it } from "vitest";
import { ERROR_CODES, ErrorEnvelopeSchema, toolError } from "../../src/schemas/error.js";

describe("toolError", () => {
  it("returns an MCP tool result with isError and the envelope as JSON text", () => {
    const result = toolError("provider", "Brave returned 500", true, { status: 500 });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block).toMatchObject({ type: "text" });
    const parsed = ErrorEnvelopeSchema.parse(JSON.parse((block as { text: string }).text));
    expect(parsed).toEqual({
      error: { code: "provider", message: "Brave returned 500", retryable: true, details: { status: 500 } },
    });
    expect(result.structuredContent).toEqual(parsed);
  });

  it("omits details when none are given", () => {
    const result = toolError("invalid_input", "bad url", false);
    const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
    expect(envelope.error).toEqual({ code: "invalid_input", message: "bad url", retryable: false });
    expect("details" in envelope.error).toBe(false);
  });

  it("supports every code in PLAN.md 3.6", () => {
    expect([...ERROR_CODES]).toEqual([
      "config",
      "provider",
      "timeout",
      "blocked",
      "budget_exceeded",
      "invalid_input",
      "internal",
    ]);
    for (const code of ERROR_CODES) {
      expect(ErrorEnvelopeSchema.safeParse(toolError(code, "m", false).structuredContent).success).toBe(true);
    }
  });

  it("rejects an unknown code in the schema", () => {
    expect(
      ErrorEnvelopeSchema.safeParse({ error: { code: "nope", message: "m", retryable: false } }).success,
    ).toBe(false);
  });
});
