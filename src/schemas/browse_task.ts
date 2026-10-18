import { z } from "zod";

/** `browse_task` input and output, PLAN.md section 3.4. */

export const DEFAULT_MAX_STEPS = 15;
export const MAX_STEPS_LIMIT = 40;
export const DEFAULT_BROWSE_MAX_COST_USD = 1;

export const BROWSE_OUTCOMES = ["completed", "partial", "blocked"] as const;
export const BLOCKED_REASONS = ["captcha", "login_required", "bot_wall", "timeout", "max_steps"] as const;

export const BrowseTaskInputSchema = z.object({
  goal: z.string().trim().min(1).describe("What to find out or extract, in natural language."),
  start_url: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe("Page to open first (http or https). Omit to let the agent navigate on its own."),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(MAX_STEPS_LIMIT)
    .default(DEFAULT_MAX_STEPS)
    .describe(`Maximum number of decisions the agent may take (default ${DEFAULT_MAX_STEPS}, max ${MAX_STEPS_LIMIT}).`),
  extract_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "JSON Schema object describing the data to return. Supported: object, array, string, number, integer, boolean, enum, required, nullable. When given, `extracted` conforms to it.",
    ),
  allow_navigation_off_domain: z
    .boolean()
    .default(false)
    .describe("Allow the agent to leave the start domain. Default false: such navigations are refused."),
  max_cost_usd: z
    .number()
    .positive()
    .default(DEFAULT_BROWSE_MAX_COST_USD)
    .describe(`Hard cap on Claude API spend for this run, in USD (default ${DEFAULT_BROWSE_MAX_COST_USD.toFixed(2)}).`),
});
/** What a caller passes (defaults not yet applied). */
export type BrowseTaskInput = z.input<typeof BrowseTaskInputSchema>;

export const BrowseTaskOutputSchema = z.object({
  goal: z.string(),
  outcome: z.enum(BROWSE_OUTCOMES),
  summary: z.string(),
  extracted: z.unknown().optional(),
  final_url: z.string(),
  steps_taken: z.number().int().min(0),
  blocked_reason: z.enum(BLOCKED_REASONS).optional(),
  screenshots: z.array(z.string()).optional(),
});
export type BrowseTaskOutput = z.infer<typeof BrowseTaskOutputSchema>;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
