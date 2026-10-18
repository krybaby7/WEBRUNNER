import { FetchError, type FetchMethod } from "../types.js";

/** Realistic desktop browser identity for the direct fetcher. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/** Hard cap on bytes read from any response body. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type FetchImpl = typeof fetch;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Cut `markdown` to at most `maxChars`, on a line boundary when one exists in
 * the kept text. Truncation is always reported, never silent.
 */
export function truncateMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };
  const limit = Math.max(0, Math.floor(maxChars));
  // If the character right after the cut starts a new line, the cut already sits on a boundary.
  if (markdown[limit] === "\n") return { markdown: markdown.slice(0, limit).trimEnd(), truncated: true };
  const head = markdown.slice(0, limit);
  const lastNewline = head.lastIndexOf("\n");
  const cut = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  return { markdown: cut.trimEnd(), truncated: true };
}

export interface Deadline {
  /** Aborts on timeout or when the caller's signal aborts. */
  signal: AbortSignal;
  timedOut(): boolean;
  callerAborted(): boolean;
}

/** Combine the caller's signal with a per-attempt timeout. */
export function makeDeadline(signal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return {
    signal: combined,
    timedOut: () => timeoutSignal.aborted,
    callerAborted: () => signal?.aborted === true,
  };
}

/**
 * Translate whatever a failed fetch threw into a FetchError. FetchErrors pass
 * through unchanged.
 */
export function toFetchError(fetcher: FetchMethod, err: unknown, deadline: Deadline, what: string): FetchError {
  if (err instanceof FetchError) return err;
  if (deadline.callerAborted()) {
    return new FetchError(fetcher, "timeout", `${what} was aborted by the caller`, false);
  }
  if (deadline.timedOut()) {
    return new FetchError(fetcher, "timeout", `${what} timed out`, true);
  }
  const detail = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return new FetchError(fetcher, "provider", `${what} failed: ${detail}${cause}`, true);
}

/** Read a response body as bytes, refusing anything over MAX_BODY_BYTES. */
export async function readBodyBytes(fetcher: FetchMethod, res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new FetchError(fetcher, "invalid_input", `Response is too large (${declared} bytes)`, false, res.status);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FetchError(fetcher, "invalid_input", `Response is larger than ${MAX_BODY_BYTES} bytes`, false, res.status);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Error for a non-2xx target status. A bot wall is `blocked` (not retryable);
 * anything else is `provider`, retryable for 429 and 5xx.
 */
export function statusError(fetcher: FetchMethod, status: number, botWall: boolean, url: string): FetchError {
  if (botWall) {
    return new FetchError(fetcher, "blocked", `${url} is protected by a bot wall (HTTP ${status})`, false, status);
  }
  return new FetchError(fetcher, "provider", `${url} returned HTTP ${status}`, isRetryableStatus(status), status);
}

/** Wrap text in a fenced code block whose fence is longer than any backtick run inside it. */
export function fenceText(text: string, lang = ""): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}
