import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Error envelope, PLAN.md section 3.6. */
export const ERROR_CODES = [
  "config",
  "provider",
  "timeout",
  "blocked",
  "budget_exceeded",
  "invalid_input",
  "internal",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Build an MCP tool result carrying the error envelope with `isError: true`. */
export function toolError(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  details?: unknown,
): CallToolResult {
  const envelope: ErrorEnvelope = {
    error: {
      code,
      message,
      retryable,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}
