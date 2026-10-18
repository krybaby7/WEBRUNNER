import { classifyBotWall } from "../botwall.js";
import { FetchError, type FetchOpts, type FetchResult, type Fetcher } from "../types.js";
import {
  isRetryableStatus,
  makeDeadline,
  nowIso,
  readBodyBytes,
  statusError,
  toFetchError,
  truncateMarkdown,
  type FetchImpl,
} from "./shared.js";

/**
 * Jina Reader. Documented at https://jina.ai/reader and
 * https://github.com/jina-ai/reader:
 *   GET https://r.jina.ai/<url>
 *   Accept: application/json        -> JSON envelope instead of plain text
 *   Authorization: Bearer <key>     -> higher rate limit (optional)
 * `X-Return-Format: markdown` is deliberately not sent: live calls showed it
 * returns the full page chrome, while the default output is cleaner Markdown.
 * The JSON envelope shape (data.title, data.url, data.content, data.httpStatus,
 * and { data: null, code, name, message } on failure) was confirmed against the
 * live service when this was written.
 */

export const JINA_BASE_URL = "https://r.jina.ai";

export interface JinaOptions {
  apiKey?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
  baseUrl?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JinaFetcher implements Fetcher {
  readonly name = "jina" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchImpl | undefined;
  private readonly baseUrl: string;

  constructor(options: JinaOptions = {}) {
    this.apiKey = options.apiKey !== undefined && options.apiKey !== "" ? options.apiKey : undefined;
    this.fetchImpl = options.fetchImpl;
    this.baseUrl = (options.baseUrl ?? JINA_BASE_URL).replace(/\/+$/, "");
  }

  /** Jina Reader works unauthenticated (rate-limited), so it is always usable. */
  isConfigured(): boolean {
    return true;
  }

  async fetch(url: string, opts: FetchOpts, signal: AbortSignal): Promise<FetchResult> {
    const deadline = makeDeadline(signal, opts.timeoutMs);
    const doFetch = this.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey !== undefined) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await doFetch(`${this.baseUrl}/${url}`, { method: "GET", headers, signal: deadline.signal });
      bytes = await readBodyBytes("jina", res);
    } catch (err) {
      throw toFetchError("jina", err, deadline, "Jina Reader request");
    }

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const message = isRecord(json) && typeof json["message"] === "string" ? `: ${json["message"]}` : "";
      if (res.status === 401 || res.status === 402) {
        const hint = this.apiKey === undefined ? " (set JINA_API_KEY)" : "";
        throw new FetchError(
          "jina",
          "config",
          `Jina Reader requires authentication${hint}${message}`,
          false,
          res.status,
        );
      }
      throw new FetchError(
        "jina",
        "provider",
        `Jina Reader returned HTTP ${res.status}${message}`,
        isRetryableStatus(res.status),
        res.status,
      );
    }

    const data = isRecord(json) ? json["data"] : undefined;
    if (!isRecord(data) || typeof data["content"] !== "string") {
      throw new FetchError("jina", "provider", "Jina Reader returned an unexpected response", false, res.status);
    }
    const content = data["content"];
    const finalUrl = typeof data["url"] === "string" && data["url"] !== "" ? data["url"] : url;
    const title = typeof data["title"] === "string" ? data["title"] : "";
    const targetStatus = typeof data["httpStatus"] === "number" ? data["httpStatus"] : 200;
    const botWall = classifyBotWall(targetStatus, {}, `${title}\n${content}`);

    if (targetStatus >= 400) throw statusError("jina", targetStatus, botWall, finalUrl);

    const cut = truncateMarkdown(content, opts.maxChars);
    return {
      url,
      final_url: finalUrl,
      title,
      markdown: cut.markdown,
      truncated: cut.truncated,
      method: "jina",
      fetched_at: nowIso(),
      botWall,
    };
  }
}
