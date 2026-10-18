import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectFetcher } from "../../../src/core/fetch/fast/direct.js";
import { FirecrawlFetcher } from "../../../src/core/fetch/fast/firecrawl.js";
import { JinaFetcher } from "../../../src/core/fetch/fast/jina.js";
import { MAX_BODY_BYTES, MAX_PDF_BYTES } from "../../../src/core/fetch/fast/shared.js";
import { FetchError } from "../../../src/core/fetch/types.js";
import { OPTS, jsonResponse, mockFetch, neverAborted } from "./helpers.js";

const SAMPLE = new Uint8Array(readFileSync(fileURLToPath(new URL("../../fixtures/fetch/sample.pdf", import.meta.url))));

const pdfResponse = (body: BodyInit = SAMPLE, contentType = "application/pdf", headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType, ...headers } });

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchError);
    return err as FetchError;
  }
  throw new Error("expected the fetch to reject");
}

function fetchPdf(url: string, response: () => Response, opts = OPTS) {
  const { fetchImpl } = mockFetch(response);
  return new DirectFetcher({ fetchImpl }).fetch(url, opts, neverAborted());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sample fixture", () => {
  it("is a small hand-written PDF", () => {
    expect(SAMPLE.byteLength).toBeLessThan(2048);
    expect(new TextDecoder("latin1").decode(SAMPLE.subarray(0, 8))).toBe("%PDF-1.4");
  });
});

describe("DirectFetcher with PDFs", () => {
  it("returns the text of every page as Markdown with --- between pages", async () => {
    const result = await fetchPdf("https://example.com/files/report.pdf", () => pdfResponse());
    expect(result.method).toBe("direct");
    expect(result.botWall).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.url).toBe("https://example.com/files/report.pdf");
    expect(result.final_url).toBe("https://example.com/files/report.pdf");
    expect(result.markdown).toBe(
      "# Quarterly Sample Report\n\nAlpha page one: the quick brown fox.\n\n---\n\nBeta page two: jumps over the lazy dog.",
    );
    expect(new Date(result.fetched_at).toISOString()).toBe(result.fetched_at);
  });

  it("uses the document title as the page title and heading", async () => {
    const result = await fetchPdf("https://example.com/files/report.pdf", () => pdfResponse());
    expect(result.title).toBe("Quarterly Sample Report");
    expect(result.markdown.startsWith("# Quarterly Sample Report\n")).toBe(true);
  });

  it("falls back to the file name when the PDF has no title", async () => {
    // The fixture's Info dictionary is dropped by renaming its Title key, keeping every offset valid.
    const text = new TextDecoder("latin1").decode(SAMPLE).replace("/Title (", "/Titel (");
    const untitled = new Uint8Array(Buffer.from(text, "latin1"));
    const result = await fetchPdf("https://example.com/files/annual%20report.pdf?download=1", () => pdfResponse(untitled));
    expect(result.title).toBe("annual report.pdf");
    expect(result.markdown.startsWith("# annual report.pdf\n\nAlpha page one")).toBe(true);
  });

  it("detects a PDF by its magic bytes when the content type is generic or missing", async () => {
    for (const contentType of ["application/octet-stream", ""]) {
      const result = await fetchPdf("https://example.com/download", () => pdfResponse(SAMPLE, contentType));
      expect(result.markdown).toContain("Alpha page one");
      expect(result.markdown).toContain("Beta page two");
    }
  });

  it("follows redirects to a PDF and reports the final URL", async () => {
    const { fetchImpl } = mockFetch((url) =>
      url.endsWith("/latest")
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/q3.pdf" } })
        : pdfResponse(),
    );
    const result = await new DirectFetcher({ fetchImpl }).fetch("https://example.com/latest", OPTS, neverAborted());
    expect(result.final_url).toBe("https://cdn.example.com/q3.pdf");
    expect(result.markdown).toContain("Alpha page one");
  });

  it("honors max_chars and flags the truncation", async () => {
    const result = await fetchPdf("https://example.com/r.pdf", () => pdfResponse(), { ...OPTS, maxChars: 66 });
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(66);
    expect(result.markdown.startsWith("# Quarterly Sample Report")).toBe(true);
    expect(result.markdown).toContain("Alpha page one");
    expect(result.markdown).not.toContain("Beta page two");
  });

  it("does not flag truncation when max_chars fits exactly", async () => {
    const full = await fetchPdf("https://example.com/r.pdf", () => pdfResponse());
    const fits = await fetchPdf("https://example.com/r.pdf", () => pdfResponse(), { ...OPTS, maxChars: full.markdown.length });
    expect(fits.truncated).toBe(false);
    expect(fits.markdown).toBe(full.markdown);
  });

  it("writes nothing to stdout while parsing, valid or not", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, "write");
    await fetchPdf("https://example.com/r.pdf", () => pdfResponse());
    await fetchPdf("https://example.com/bad.pdf", () => pdfResponse("%PDF-1.4\nnot really")).catch(() => undefined);
    expect(log).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  describe("size limit", () => {
    it("allows PDFs well above the ordinary 8 MB body limit", () => {
      expect(MAX_PDF_BYTES).toBe(25 * 1024 * 1024);
      expect(MAX_PDF_BYTES).toBeGreaterThan(MAX_BODY_BYTES);
    });

    it("refuses a PDF whose Content-Length is over 25 MB without reading it", async () => {
      const err = await failure(
        fetchPdf("https://example.com/huge.pdf", () => pdfResponse(SAMPLE, "application/pdf", { "content-length": String(MAX_PDF_BYTES + 1) })),
      );
      expect(err.code).toBe("invalid_input");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/PDF is larger than the 25 MB limit/);
    });

    it("refuses a PDF that streams past 25 MB", async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > 26) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(chunk);
        },
      });
      const err = await failure(fetchPdf("https://example.com/huge.pdf", () => pdfResponse(body)));
      expect(err.code).toBe("invalid_input");
      expect(err.message).toMatch(/PDF is larger than the 25 MB limit/);
      expect(sent).toBeLessThan(28);
    });

    it("keeps the 8 MB limit for other content", async () => {
      const err = await failure(
        fetchPdf("https://example.com/big.html", () =>
          pdfResponse("<p>x</p>", "text/html", { "content-length": String(MAX_BODY_BYTES + 1) }),
        ),
      );
      expect(err.code).toBe("invalid_input");
    });

    it("refuses a non-PDF body of generic type that is over 8 MB", async () => {
      const big = new Uint8Array(MAX_BODY_BYTES + 10);
      big.fill(0x61);
      const err = await failure(fetchPdf("https://example.com/blob", () => pdfResponse(big, "application/octet-stream")));
      expect(err.code).toBe("invalid_input");
      expect(err.message).toMatch(/larger than/);
    });
  });

  describe("failures", () => {
    it("a document with no text layer is invalid_input with a clear message", async () => {
      const text = new TextDecoder("latin1").decode(SAMPLE).replaceAll("Tj", "  ");
      const blank = new Uint8Array(Buffer.from(text, "latin1"));
      const err = await failure(fetchPdf("https://example.com/scan.pdf", () => pdfResponse(blank)));
      expect(err.code).toBe("invalid_input");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/no extractable text/);
    });

    it("a corrupt PDF is invalid_input, not an internal error", async () => {
      const err = await failure(fetchPdf("https://example.com/bad.pdf", () => pdfResponse("%PDF-1.7 this is not a pdf")));
      expect(err.code).toBe("invalid_input");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/Could not read the PDF/);
    });

    it("a non-2xx response for a PDF is a provider error, not a parse attempt", async () => {
      const err = await failure(fetchPdf("https://example.com/gone.pdf", () => new Response("%PDF-1.4", { status: 404, headers: { "content-type": "application/pdf" } })));
      expect(err.code).toBe("provider");
      expect(err.status).toBe(404);
      expect(err.retryable).toBe(false);
    });
  });
});

describe("Jina and Firecrawl pass extracted PDF text through", () => {
  const EXTRACTED = "# Annual report\n\nRevenue grew 12 percent in the year. ".repeat(30);

  it("returns Jina's content for a PDF URL unchanged", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({
        code: 200,
        status: 20000,
        data: { title: "Annual report", url: "https://example.com/annual.pdf", content: EXTRACTED, httpStatus: 200 },
      }),
    );
    const result = await new JinaFetcher({ fetchImpl }).fetch("https://example.com/annual.pdf", OPTS, neverAborted());
    expect(result.method).toBe("jina");
    expect(result.markdown).toBe(EXTRACTED);
    expect(result.final_url).toBe("https://example.com/annual.pdf");
    expect(result.botWall).toBe(false);
  });

  it("returns Firecrawl's markdown for a PDF URL, whatever the content type", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({
        success: true,
        data: {
          markdown: EXTRACTED,
          metadata: { title: "Annual report", sourceURL: "https://example.com/annual.pdf", statusCode: 200, contentType: "application/pdf" },
        },
      }),
    );
    const result = await new FirecrawlFetcher({ apiKey: "fc-test", fetchImpl }).fetch("https://example.com/annual.pdf", OPTS, neverAborted());
    expect(result.method).toBe("firecrawl");
    expect(result.title).toBe("Annual report");
    expect(result.markdown).toContain("Revenue grew 12 percent");
    expect(result.botWall).toBe(false);
  });
});
