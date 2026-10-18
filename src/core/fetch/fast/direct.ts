import { classifyBotWall } from "../botwall.js";
import { FetchError, type FetchOpts, type FetchResult, type Fetcher } from "../types.js";
import { htmlToMarkdown } from "./extract.js";
import {
  BROWSER_ACCEPT,
  BROWSER_USER_AGENT,
  fenceText,
  makeDeadline,
  nowIso,
  readBodyBytes,
  statusError,
  toFetchError,
  truncateMarkdown,
  type FetchImpl,
} from "./shared.js";

/**
 * Plain HTTP GET with browser-like headers, redirects followed by hand (so the
 * final URL is known and the hop count is capped), charset decoded from the
 * headers or the document, then Readability and Turndown.
 */

export const MAX_REDIRECTS = 10;

export interface DirectOptions {
  fetchImpl?: FetchImpl | undefined;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FetchError("direct", "invalid_input", `Not a valid URL: ${raw}`, false);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchError("direct", "invalid_input", `Unsupported URL scheme ${parsed.protocol}`, false);
  }
  return parsed;
}

function charsetFromContentType(contentType: string): string | undefined {
  return /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
}

/** Look for a BOM, then an HTML meta or XML declaration in the first bytes. */
function sniffCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) ?? /^\s*<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  return meta?.[1];
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const candidates = [charsetFromContentType(contentType), sniffCharset(bytes), "utf-8"];
  for (const label of candidates) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown encoding label: try the next candidate.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

const HTML_START = /^\s*(?:<!doctype html|<html|<head|<body|<!--)/i;

type Kind = { type: "html" } | { type: "text"; lang: string } | { type: "pdf" } | { type: "unsupported"; mime: string };

function classifyContent(contentType: string, bytes: Uint8Array): Kind {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") return { type: "html" };
  if (mime === "application/pdf") return { type: "pdf" };
  if (mime === "application/json" || mime.endsWith("+json")) return { type: "text", lang: "json" };
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) return { type: "text", lang: "xml" };
  if (mime.startsWith("text/")) return { type: "text", lang: "" };
  if (mime === "" || mime === "application/octet-stream") {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (head.startsWith("%PDF-")) return { type: "pdf" };
    if (HTML_START.test(head)) return { type: "html" };
    if (mime === "") return { type: "text", lang: "" };
  }
  return { type: "unsupported", mime };
}

export class DirectFetcher implements Fetcher {
  readonly name = "direct" as const;
  private readonly fetchImpl: FetchImpl | undefined;

  constructor(options: DirectOptions = {}) {
    this.fetchImpl = options.fetchImpl;
  }

  isConfigured(): boolean {
    return true;
  }

  async fetch(url: string, opts: FetchOpts, signal: AbortSignal): Promise<FetchResult> {
    let current = parseHttpUrl(url).toString();
    const deadline = makeDeadline(signal, opts.timeoutMs);
    const doFetch = this.fetchImpl ?? fetch;

    let res: Response;
    let bytes: Uint8Array;
    try {
      for (let hop = 0; ; hop++) {
        res = await doFetch(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": BROWSER_USER_AGENT,
            Accept: BROWSER_ACCEPT,
            "Accept-Language": "en-US,en;q=0.9",
            "Upgrade-Insecure-Requests": "1",
          },
          signal: deadline.signal,
        });
        const location = res.headers.get("location");
        if (!REDIRECT_STATUSES.has(res.status) || !location) break;
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) {
          throw new FetchError("direct", "provider", `Too many redirects (more than ${MAX_REDIRECTS})`, false, res.status);
        }
        let next: URL;
        try {
          next = parseHttpUrl(new URL(location, current).toString());
        } catch {
          throw new FetchError("direct", "provider", `Redirect to an invalid location: ${location}`, false, res.status);
        }
        current = next.toString();
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (/^\s*application\/pdf\b/i.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new FetchError(
          "direct",
          "invalid_input",
          "PDF is not supported in the fast path yet",
          false,
          res.status,
        );
      }
      bytes = await readBodyBytes("direct", res);
    } catch (err) {
      throw toFetchError("direct", err, deadline, "Direct fetch");
    }

    const contentType = res.headers.get("content-type") ?? "";
    const kind = classifyContent(contentType, bytes);
    if (kind.type === "pdf") {
      throw new FetchError("direct", "invalid_input", "PDF is not supported in the fast path yet", false, res.status);
    }

    const text = kind.type === "unsupported" ? "" : decodeBody(bytes, contentType);
    const botWall = classifyBotWall(res.status, res.headers, text);

    if (res.status < 200 || res.status >= 300) throw statusError("direct", res.status, botWall, current);

    if (kind.type === "unsupported") {
      throw new FetchError(
        "direct",
        "invalid_input",
        `Unsupported content type ${kind.mime || "(none)"} in the fast path`,
        false,
        res.status,
      );
    }

    let title = "";
    let markdown: string;
    let truncated: boolean;
    if (kind.type === "html") {
      try {
        const page = htmlToMarkdown(text, current);
        title = page.title;
        markdown = page.markdown;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new FetchError("direct", "provider", `Could not parse the HTML of ${current}: ${detail}`, false, res.status);
      }
      const cut = truncateMarkdown(markdown, opts.maxChars);
      markdown = cut.markdown;
      truncated = cut.truncated;
    } else {
      // Truncate the text first so the closing fence is never cut off.
      const overhead = fenceText("x", kind.lang).length - 1;
      const cut = truncateMarkdown(text, Math.max(0, opts.maxChars - overhead));
      markdown = fenceText(cut.markdown, kind.lang);
      truncated = cut.truncated;
    }

    return {
      url,
      final_url: current,
      title,
      markdown,
      truncated,
      method: "direct",
      fetched_at: nowIso(),
      botWall,
    };
  }
}
