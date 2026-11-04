import { z } from "zod";

/**
 * Human handoff, PLAN.md section 16. When a browser tool meets a wall the
 * owner can clear by hand (a CAPTCHA, a checkpoint, a consent dialog, a login
 * page, a one-time code), it parks the page in a visible window and returns
 * the `paused` result below instead of a `blocked` error; `resume` continues
 * the run once the owner has cleared it. Owned by WP44.
 */

export const HANDOFF_REASONS = ["captcha", "checkpoint", "login_required", "consent", "mfa", "unknown_wall"] as const;
export const HandoffReasonSchema = z.enum(HANDOFF_REASONS);
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;

/** PLAN.md 16.1: what a paused run tells the caller. Never carries a cookie value or page content. */
export const HandoffSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  site: z.string().min(1),
  url: z.string(),
  reason: HandoffReasonSchema,
  what_to_do: z.string().min(1),
  expires_at: z.string(),
  step: z.string().min(1),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const PausedOutputSchema = z.object({
  paused: z.literal(true),
  handoff: HandoffSchema,
});
export type PausedOutput = z.infer<typeof PausedOutputSchema>;

export const DEFAULT_RESUME_WAIT_S = 60;
export const MAX_RESUME_WAIT_S = 300;

/** PLAN.md 16.2. */
export const ResumeInputSchema = z.object({
  handoff_id: z.string().trim().min(1).describe("The handoff id from a paused result."),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_RESUME_WAIT_S)
    .default(DEFAULT_RESUME_WAIT_S)
    .describe(`How long to wait for the wall to clear, re-probing the page every 2 seconds (0 to ${MAX_RESUME_WAIT_S}, default ${DEFAULT_RESUME_WAIT_S}). 0 probes once.`),
  cancel: z.boolean().default(false).describe("Close the parked page and forget the handoff instead of continuing."),
});
export type ResumeInput = z.input<typeof ResumeInputSchema>;

export const ResumeCancelledOutputSchema = z.object({
  cancelled: z.literal(true),
  handoff_id: z.string().min(1),
});
export type ResumeCancelledOutput = z.infer<typeof ResumeCancelledOutputSchema>;

/**
 * What `resume` advertises. The real output is the continued tool's own output,
 * the `paused` shape or `{ cancelled: true }`; MCP SDK 1.32 cannot express
 * "any tool's output", so this is a loose object and the handler validates the
 * continued run against its own tool's schema.
 */
export const ResumeOutputObjectSchema = z.looseObject({
  paused: z.literal(true).optional(),
  handoff: HandoffSchema.optional(),
  cancelled: z.literal(true).optional(),
  handoff_id: z.string().optional(),
});

/** The real contract of a tool that can pause: its normal output, or the `paused` shape. */
export type WithPaused<T> = T | PausedOutput;

/**
 * Build what a tool that can pause advertises as `outputSchema`.
 *
 * MCP SDK 1.32 takes only a `z.object` as `outputSchema`: a union is dropped
 * from `tools/list` and crashes result validation (PLAN.md 14.10). So the
 * advertised schema is one object with every field of the normal output made
 * optional plus optional `paused` and `handoff`, whose refinement accepts
 * exactly what `z.union([normal, PausedOutputSchema])` accepts. Handlers
 * validate each result against the real union (`pausedOrOutput(normal)`)
 * before returning it.
 */
export function withPausedOutput<Shape extends z.ZodRawShape>(normal: z.ZodObject<Shape>): z.ZodType<Record<string, unknown>> {
  const union = pausedOrOutput(normal);
  return z
    .object({
      ...normal.shape,
      paused: z.literal(true),
      handoff: HandoffSchema,
    })
    .partial()
    .superRefine((value, ctx) => {
      const checked = union.safeParse(value);
      if (checked.success) return;
      for (const issue of checked.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }) as unknown as z.ZodType<Record<string, unknown>>;
}

/** The real union a pausing tool's results are validated against. */
export function pausedOrOutput<Shape extends z.ZodRawShape>(normal: z.ZodObject<Shape>): z.ZodType<WithPaused<z.infer<z.ZodObject<Shape>>>> {
  return z.union([PausedOutputSchema, normal]) as unknown as z.ZodType<WithPaused<z.infer<z.ZodObject<Shape>>>>;
}

/** The one sentence every pausing tool's description carries (PLAN.md 16.1). */
export const PAUSED_DESCRIPTION_SENTENCE =
  "A `paused` result is not an error: tell the user what to do in the browser window (the handoff's what_to_do), then call `resume` with the handoff id.";
