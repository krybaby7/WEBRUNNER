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
 * Firecrawl scrape endpoint. Verified against
 * https://docs.firecrawl.dev/api-reference/endpoint/scrape:
 *   POST https://api.firecrawl.dev/v2/scrape
 *   Authorization: Bearer <key>
 *   { url, formats: ["markdown"], onlyMainContent, timeout (ms) }
 *   -> { success, data: { markdown, metadata: { title, sourceURL, url, statusCode, error } } }
 */

export const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";

export interface FirecrawlOptions {
  apiKey?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
  baseUrl?: string | undefined;
}

interface FirecrawlMetadata {
  title?: unknown;
  sourceURL?: unknown;
  url?: unknown;
  statusCode?: unknown;
  error?: unknown;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (Array.isArray(value)) {
    const first = value.find((v): v is string => typeof v === "string" && v !== "");
    return first;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FirecrawlFetcher implements Fetcher {
  readonly name = "firecrawl" as const;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchImpl | undefined;
  private readonly baseUrl: string;

  constructor(options: FirecrawlOptions = {}) {
    this.apiKey = options.apiKey !== undefined && options.apiKey !== "" ? options.apiKey : undefined;
    this.fetchImpl = options.fetchImpl;
    this.baseUrl = (options.baseUrl ?? FIRECRAWL_BASE_URL).replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  async fetch(url: string, opts: FetchOpts, signal: AbortSignal): Promise<FetchResult> {
    if (this.apiKey === undefined) {
      throw new FetchError("firecrawl", "config", "FIRECRAWL_API_KEY is not set", false);
    }
    const deadline = makeDeadline(signal, opts.timeoutMs);
    const doFetch = this.fetchImpl ?? fetch;

    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await doFetch(`${this.baseUrl}/v2/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          url,
          formats: ["markdown"],
          onlyMainContent: true,
          // Firecrawl's own timeout (1s minimum); finish a little before ours.
          timeout: Math.max(1000, Math.floor(opts.timeoutMs * 0.9)),
        }),
        signal: deadline.signal,
      });
      bytes = await readBodyBytes("firecrawl", res);
    } catch (err) {
      throw toFetchError("firecrawl", err, deadline, "Firecrawl request");
    }

    const text = new TextDecoder("utf-8").decode(bytes);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const errorText = isRecord(json) && typeof json["error"] === "string" ? json["error"] : undefined;

    if (!res.ok) {
      const suffix = errorText !== undefined ? `: ${errorText}` : "";
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new FetchError(
          "firecrawl",
          "config",
          `Firecrawl rejected the request (HTTP ${res.status})${suffix}`,
          false,
          res.status,
        );
      }
      throw new FetchError(
        "firecrawl",
        "provider",
        `Firecrawl returned HTTP ${res.status}${suffix}`,
        isRetryableStatus(res.status),
        res.status,
      );
    }

    if (!isRecord(json) || json["success"] !== true || !isRecord(json["data"])) {
      throw new FetchError(
        "firecrawl",
        "provider",
        `Firecrawl returned an unexpected response${errorText !== undefined ? `: ${errorText}` : ""}`,
        false,
        res.status,
      );
    }
    const data = json["data"];
    const markdown = typeof data["markdown"] === "string" ? data["markdown"] : "";
    const metadata: FirecrawlMetadata = isRecord(data["metadata"]) ? data["metadata"] : {};

    const targetStatus = typeof metadata.statusCode === "number" ? metadata.statusCode : 200;
    const finalUrl = asString(metadata.url) ?? asString(metadata.sourceURL) ?? url;
    // The response headers belong to Firecrawl, not the target, so they are not classified.
    const botWall = classifyBotWall(targetStatus, {}, markdown);

    if (targetStatus >= 400) throw statusError("firecrawl", targetStatus, botWall, finalUrl);

    const cut = truncateMarkdown(markdown, opts.maxChars);
    return {
      url,
      final_url: finalUrl,
      title: asString(metadata.title) ?? "",
      markdown: cut.markdown,
      truncated: cut.truncated,
      method: "firecrawl",
      fetched_at: nowIso(),
      botWall,
    };
  }
}
