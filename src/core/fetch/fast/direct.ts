import { classifyBotWall } from "../botwall.js";
import { FetchError, type FetchOpts, type FetchResult, type Fetcher } from "../types.js";
import { htmlToMarkdown } from "./extract.js";
import {
  BROWSER_ACCEPT,
  BROWSER_USER_AGENT,
  MAX_BODY_BYTES,
  MAX_PDF_BYTES,
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
/** Pages read from one PDF. A longer document is cut here and flagged `truncated`. */
export const MAX_PDF_PAGES = 300;

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

function mimeOf(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Heading for a PDF with no title in its metadata: the file name in the URL, else a generic label. */
function pdfFileName(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last !== undefined) return decodeURIComponent(last);
  } catch {
    // An unparseable URL or escape sequence: use the generic label.
  }
  return "PDF document";
}

interface PdfText {
  title: string;
  markdown: string;
  truncated: boolean;
}

/**
 * PDF text with `pdf-parse` (loaded on first use, so the server starts without
 * pdf.js): `# <title or file name>`, then the text of each page with `---`
 * between pages. Pages without text are skipped. A document with no text layer
 * (scanned images) is `invalid_input`: there is nothing to return.
 */
async function pdfToMarkdown(bytes: Uint8Array, finalUrl: string, maxChars: number, status: number): Promise<PdfText> {
  let pdfParse: typeof import("pdf-parse");
  try {
    pdfParse = await import("pdf-parse");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new FetchError("direct", "provider", `The PDF reader could not be loaded: ${detail}`, false, status);
  }
  // Verbosity 0: pdf.js prints its warnings with console.log, which would corrupt the MCP stdout channel.
  const parser = new pdfParse.PDFParse({ data: bytes, verbosity: pdfParse.VerbosityLevel.ERRORS });
  try {
    const info = await parser.getInfo();
    const metaTitle = typeof info.info?.Title === "string" ? info.info.Title.trim() : "";
    const total = info.total;
    const pageCount = Math.min(total, MAX_PDF_PAGES);
    const text = await parser.getText({ first: pageCount });
    const pages = text.pages.map((p) => p.text.trim()).filter((t) => t !== "");
    if (pages.length === 0) {
      throw new FetchError(
        "direct",
        "invalid_input",
        "The PDF has no extractable text (it may be scanned images, which are not supported)",
        false,
        status,
      );
    }
    const title = metaTitle !== "" ? metaTitle : pdfFileName(finalUrl);
    const overPageCap = total > pageCount;
    const note = overPageCap ? `\n\n---\n\n_Only the first ${pageCount} of ${total} pages were read._` : "";
    const full = `# ${title}\n\n${pages.join("\n\n---\n\n")}${note}`;
    const cut = truncateMarkdown(full, maxChars);
    return { title, markdown: cut.markdown, truncated: cut.truncated || overPageCap };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new FetchError("direct", "invalid_input", `Could not read the PDF: ${detail}`, false, status);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
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

      // A PDF may be larger than other bodies. Without a content type the body is read up to the PDF
      // limit too, since the bytes decide; a non-PDF over the ordinary limit is refused below.
      const mime = mimeOf(res.headers.get("content-type") ?? "");
      const isPdfMime = mime === "application/pdf";
      bytes = await readBodyBytes(
        "direct",
        res,
        isPdfMime
          ? { maxBytes: MAX_PDF_BYTES, label: "PDF" }
          : mime === "" || mime === "application/octet-stream"
            ? { maxBytes: MAX_PDF_BYTES }
            : {},
      );
    } catch (err) {
      throw toFetchError("direct", err, deadline, "Direct fetch");
    }

    const contentType = res.headers.get("content-type") ?? "";
    const kind = classifyContent(contentType, bytes);
    if (kind.type !== "pdf" && bytes.byteLength > MAX_BODY_BYTES) {
      throw new FetchError("direct", "invalid_input", `Response is larger than ${MAX_BODY_BYTES} bytes`, false, res.status);
    }
    if (kind.type === "pdf") {
      if (res.status < 200 || res.status >= 300) throw statusError("direct", res.status, false, current);
      const pdf = await pdfToMarkdown(bytes, current, opts.maxChars, res.status);
      return {
        url,
        final_url: current,
        title: pdf.title,
        markdown: pdf.markdown,
        truncated: pdf.truncated,
        method: "direct",
        fetched_at: nowIso(),
        botWall: false,
      };
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
