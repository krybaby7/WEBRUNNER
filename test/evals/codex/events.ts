/**
 * Reads the `codex exec --json` event stream of one run (WP55): the final
 * answer, token use, errors, and every tool call the agent made, so a run can
 * be checked for what it actually did (searched, opened pages, which tools).
 *
 * Codex's event shapes are not a stable contract, so everything is read
 * defensively: an unknown item type is counted under its own name, a line that
 * is not JSON is counted and skipped.
 */

type Json = Record<string, unknown>;

export interface ToolCall {
  /** "web_search" for Codex's own search, "mcp" for an MCP tool, else the item type. */
  kind: string;
  /** For "mcp": "<server>.<tool>". For "web_search": the query, when given. */
  name?: string;
  /** "completed", "failed", ... when Codex reports one. */
  status?: string;
  /** The MCP call's error message, if it failed. */
  error?: string;
}

export interface RunEvents {
  /** The last agent message. */
  answer?: string;
  /** Usage summed over every `turn.completed` event. */
  usage: Record<string, number>;
  toolCalls: ToolCall[];
  /** Messages of `turn.failed`, `error` and error items. */
  errors: string[];
  /** Lines that were not JSON. */
  badLines: number;
}

/** Item types that are the agent's own output, not a tool call. */
const NOT_TOOLS = new Set(["agent_message", "reasoning", "error", "todo_list"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function errorText(v: unknown): string | undefined {
  if (typeof v === "string") return str(v);
  if (typeof v === "object" && v !== null) return str((v as Json)["message"]);
  return undefined;
}

export function readEvents(stdout: string): RunEvents {
  const out: RunEvents = { usage: {}, toolCalls: [], errors: [], badLines: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      event = parsed as Json;
    } catch {
      out.badLines += 1;
      continue;
    }
    const type = event["type"];
    if (type === "turn.completed") {
      const usage = event["usage"];
      if (typeof usage === "object" && usage !== null) {
        for (const [k, v] of Object.entries(usage as Json)) {
          if (typeof v === "number") out.usage[k] = (out.usage[k] ?? 0) + v;
        }
      }
    } else if (type === "turn.failed" || type === "error") {
      // Codex reports a failed turn twice, as an `error` event and as `turn.failed`, with the same message.
      const message = errorText(event["error"]) ?? errorText(event["message"]);
      if (message !== undefined && !out.errors.includes(message)) out.errors.push(message);
    } else if (type === "item.completed") {
      readItem(event["item"], out);
    }
  }
  return out;
}

function readItem(raw: unknown, out: RunEvents): void {
  if (typeof raw !== "object" || raw === null) return;
  const item = raw as Json;
  const type = str(item["type"]);
  if (type === undefined) return;
  if (type === "agent_message") {
    const text = str(item["text"]);
    if (text !== undefined) out.answer = text;
    return;
  }
  if (type === "error") {
    const message = errorText(item["message"]);
    if (message !== undefined) out.errors.push(message);
    return;
  }
  if (NOT_TOOLS.has(type)) return;

  const call: ToolCall = { kind: type === "mcp_tool_call" ? "mcp" : type };
  if (type === "mcp_tool_call") {
    call.name = `${str(item["server"]) ?? "?"}.${str(item["tool"]) ?? "?"}`;
    const error = errorText(item["error"]);
    if (error !== undefined) call.error = error;
  } else if (type === "web_search") {
    const query = str(item["query"]);
    if (query !== undefined) call.name = query;
  } else if (type === "command_execution") {
    const command = str(item["command"]);
    if (command !== undefined) call.name = command;
  }
  const status = str(item["status"]);
  if (status !== undefined) call.status = status;
  out.toolCalls.push(call);
}

/** Tool calls counted by tool: "web_search" (Codex's own), "webrunner.fetch_page", ... */
export function countTools(calls: readonly ToolCall[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of calls) {
    const key = c.kind === "mcp" ? (c.name ?? "mcp") : c.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
