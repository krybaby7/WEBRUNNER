import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HANDOFF_REASONS,
  HandoffSchema,
  PAUSED_DESCRIPTION_SENTENCE,
  PausedOutputSchema,
  ResumeInputSchema,
  ResumeOutputObjectSchema,
  pausedOrOutput,
  withPausedOutput,
} from "../../src/schemas/handoff.js";

/** PLAN.md section 16: the `paused` shape, the `resume` input and the SDK-1.32 object wrapper. */

const HANDOFF = {
  id: "h_7f3a9c1e",
  tool: "social_search",
  site: "x",
  url: "https://x.com/i/flow/login",
  reason: "login_required",
  what_to_do: "Sign in to X in the browser window; webrunner never types.",
  expires_at: "2026-11-04T19:10:00.000Z",
  step: "search results",
};

const Normal = z.object({ items: z.array(z.string()), count: z.number().int() });

describe("handoff schemas", () => {
  it("lists the six reasons of PLAN.md 16.1", () => {
    expect([...HANDOFF_REASONS]).toEqual(["captcha", "checkpoint", "login_required", "consent", "mfa", "unknown_wall"]);
    expect(HandoffSchema.safeParse(HANDOFF).success).toBe(true);
    expect(HandoffSchema.safeParse({ ...HANDOFF, reason: "bot_wall" }).success).toBe(false);
  });

  it("the paused result needs paused: true and a complete handoff", () => {
    expect(PausedOutputSchema.safeParse({ paused: true, handoff: HANDOFF }).success).toBe(true);
    expect(PausedOutputSchema.safeParse({ paused: false, handoff: HANDOFF }).success).toBe(false);
    expect(PausedOutputSchema.safeParse({ paused: true, handoff: { ...HANDOFF, what_to_do: "" } }).success).toBe(false);
  });

  it("resume takes a handoff id, a wait of 0 to 300 s (default 60) and cancel (default false)", () => {
    expect(ResumeInputSchema.parse({ handoff_id: "h_1" })).toEqual({ handoff_id: "h_1", wait_seconds: 60, cancel: false });
    expect(ResumeInputSchema.safeParse({ handoff_id: "h_1", wait_seconds: 300 }).success).toBe(true);
    expect(ResumeInputSchema.safeParse({ handoff_id: "h_1", wait_seconds: 301 }).success).toBe(false);
    expect(ResumeInputSchema.safeParse({ handoff_id: "h_1", wait_seconds: -1 }).success).toBe(false);
    expect(ResumeInputSchema.safeParse({ handoff_id: " " }).success).toBe(false);
    expect(ResumeInputSchema.parse({ handoff_id: "h_1", cancel: true }).cancel).toBe(true);
  });

  it("resume advertises a loose object that accepts any tool output, the paused shape and cancelled", () => {
    expect(ResumeOutputObjectSchema.safeParse({ goal: "x", outcome: "completed", steps_taken: 2 }).success).toBe(true);
    expect(ResumeOutputObjectSchema.safeParse({ paused: true, handoff: HANDOFF }).success).toBe(true);
    expect(ResumeOutputObjectSchema.safeParse({ cancelled: true, handoff_id: "h_1" }).success).toBe(true);
    expect(ResumeOutputObjectSchema.safeParse({ paused: true, handoff: { id: "h_1" } }).success).toBe(false);
  });

  describe("withPausedOutput", () => {
    const advertised = withPausedOutput(Normal);
    const real = pausedOrOutput(Normal);

    it("is a plain object schema, as MCP SDK 1.32 requires, with every normal field optional", () => {
      expect(advertised instanceof z.ZodType).toBe(true);
      const json = z.toJSONSchema(advertised) as { type?: string; required?: string[]; properties?: Record<string, unknown> };
      expect(json.type).toBe("object");
      expect(json.required ?? []).toEqual([]);
      expect(Object.keys(json.properties ?? {}).sort()).toEqual(["count", "handoff", "items", "paused"]);
    });

    it.each([
      ["a normal output", { items: ["a"], count: 1 }, true],
      ["a paused output", { paused: true, handoff: HANDOFF }, true],
      ["a normal output missing a required field", { items: ["a"] }, false],
      ["paused without a handoff", { paused: true }, false],
      ["a handoff without paused", { handoff: HANDOFF }, false],
      ["a mix of both", { paused: true, handoff: HANDOFF, items: [], count: 0 }, true],
      ["an empty object", {}, false],
    ])("accepts exactly what the real union accepts: %s", (_name, value, ok) => {
      expect(real.safeParse(value).success).toBe(ok);
      expect(advertised.safeParse(value).success).toBe(ok);
    });
  });

  it("names the sentence every pausing tool's description carries", () => {
    expect(PAUSED_DESCRIPTION_SENTENCE).toMatch(/paused/);
    expect(PAUSED_DESCRIPTION_SENTENCE).toMatch(/what_to_do/);
    expect(PAUSED_DESCRIPTION_SENTENCE).toMatch(/`resume`/);
  });
});
