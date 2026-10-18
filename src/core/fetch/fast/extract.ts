import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { THIN_THRESHOLD_CHARS } from "../botwall.js";
import { fenceText } from "./shared.js";

/**
 * HTML to Markdown for the direct fetcher: jsdom builds the DOM (no scripts,
 * no subresources), Readability picks the main content, Turndown converts it.
 */

export interface ExtractedPage {
  title: string;
  markdown: string;
}

const NOISE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "form",
  "nav",
  "footer",
  "aside",
  "header",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  "[hidden]",
].join(",");

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
    linkStyle: "inlined",
  });
  td.use(gfm);
  td.remove(["script", "style", "noscript", "template"]);
  // Any <pre>, with or without an inner <code>, becomes a fenced block. The
  // language comes from the data-lang attribute set in markCodeBlocks().
  td.addRule("fencedPre", {
    filter: "pre",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const lang = el.getAttribute("data-lang") ?? "";
      const text = (el.textContent ?? "").replace(/\r\n?/g, "\n").replace(/^\n+/, "");
      return `\n\n${fenceText(text, lang)}\n\n`;
    },
  });
  return td;
}

/**
 * Readability strips class attributes, so record each code block's language
 * and turn <br> into newlines while the original markup is still there.
 */
function markCodeBlocks(doc: Document): void {
  for (const pre of Array.from(doc.querySelectorAll("pre"))) {
    const holder = pre.querySelector("code") ?? pre;
    const classes = `${pre.getAttribute("class") ?? ""} ${holder.getAttribute("class") ?? ""}`;
    const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(classes)?.[1];
    if (lang !== undefined) pre.setAttribute("data-lang", lang);
    for (const br of Array.from(pre.querySelectorAll("br"))) br.replaceWith(doc.createTextNode("\n"));
  }
}

/** GFM tables need a heading row; promote the first row of header-less tables. */
function promoteTableHeaders(doc: Document): void {
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const firstRow = table.querySelector("tr");
    if (!firstRow) continue;
    const cells = Array.from(firstRow.children);
    const isHeading = firstRow.parentElement?.nodeName === "THEAD" || cells.every((c) => c.nodeName === "TH");
    if (isHeading) continue;
    for (const cell of cells) {
      if (cell.nodeName !== "TD") continue;
      const th = doc.createElement("th");
      th.innerHTML = cell.innerHTML;
      cell.replaceWith(th);
    }
  }
}

function textLength(node: Node | null | undefined): number {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function firstNonEmpty(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const t = c?.replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  return "";
}

function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toMarkdown(td: TurndownService, html: string): string {
  const fragment = new JSDOM(`<!doctype html><body>${html}</body>`, { virtualConsole: new VirtualConsole() });
  try {
    promoteTableHeaders(fragment.window.document);
    return tidy(td.turndown(fragment.window.document.body.innerHTML));
  } finally {
    fragment.window.close();
  }
}

/**
 * Extract the main content of an HTML page as Markdown. `baseUrl` resolves
 * relative links to absolute ones.
 */
export function htmlToMarkdown(html: string, baseUrl: string): ExtractedPage {
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    markCodeBlocks(doc);

    const docTitle = firstNonEmpty(
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content"),
      doc.title,
      doc.querySelector("h1")?.textContent,
    );

    // Readability mutates its input, so keep a pristine copy for the fallback.
    const pristine = doc.cloneNode(true) as Document;
    const article = new Readability(doc).parse();

    const td = createTurndown();
    let markdown = article?.content ? toMarkdown(td, article.content) : "";
    const articleChars = article?.textContent ? article.textContent.replace(/\s+/g, " ").trim().length : 0;

    if (!article || articleChars < THIN_THRESHOLD_CHARS) {
      // Readability found little (listing pages, short pages, app shells). Use
      // the body minus obvious page chrome when that holds clearly more text.
      for (const noise of Array.from(pristine.querySelectorAll(NOISE_SELECTOR))) noise.remove();
      const body = pristine.body;
      if (body && textLength(body) > articleChars * 1.5) {
        const fallback = toMarkdown(td, body.innerHTML);
        if (fallback.length > markdown.length) markdown = fallback;
      }
    }

    const title = firstNonEmpty(article?.title, docTitle);
    // Readability drops the h1 that repeats the page title; put it back so the
    // Markdown reads as a document.
    if (markdown !== "" && title !== "" && !/^#{1,2}\s/.test(markdown)) markdown = `# ${title}\n\n${markdown}`;

    return { title, markdown };
  } finally {
    dom.window.close();
  }
}
