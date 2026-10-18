import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Success result shape, PLAN.md section 3: the JSON payload as a single text
 * block plus `structuredContent` for clients that support it. Every tool uses
 * this for success and `toolError()` from ./error.js for failure.
 */
export function jsonResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
