import { describe, expect, it } from "vitest";
import { jsonResult } from "../../src/schemas/result.js";

describe("jsonResult", () => {
  it("returns the payload as JSON text and as structuredContent", () => {
    const r = jsonResult({ a: 1, b: "x" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ a: 1, b: "x" });
    expect(r.content).toHaveLength(1);
    const block = r.content[0];
    expect(block?.type).toBe("text");
    expect(JSON.parse((block as { text: string }).text)).toEqual({ a: 1, b: "x" });
  });
});
