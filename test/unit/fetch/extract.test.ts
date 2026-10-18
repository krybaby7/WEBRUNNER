import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../../src/core/fetch/fast/extract.js";
import { fixture } from "./helpers.js";

describe("htmlToMarkdown on the article fixture", () => {
  const page = htmlToMarkdown(fixture("article.html"), "https://example.com/blog/caching");

  it("extracts the title without the site suffix", () => {
    expect(page.title).toBe("Caching Strategies for Web Services");
  });

  it("preserves headings", () => {
    expect(page.markdown).toMatch(/^# Caching Strategies for Web Services$/m);
    expect(page.markdown).toMatch(/^## Choosing a strategy$/m);
    expect(page.markdown).toMatch(/^## Comparison$/m);
    expect(page.markdown).toMatch(/^## Example$/m);
  });

  it("preserves links and resolves relative ones against the page URL", () => {
    expect(page.markdown).toContain("[full caching guide](https://example.com/docs/caching-guide)");
    expect(page.markdown).toContain("[HTTP basics](https://example.com/docs/http-basics)");
  });

  it("preserves list items", () => {
    expect(page.markdown).toMatch(/^-\s+Cache-aside keeps the application in control of reads and writes\.$/m);
    expect(page.markdown).toMatch(/^-\s+Write-through updates the cache and the store together\.$/m);
    expect(page.markdown).toMatch(/^-\s+Write-behind batches writes/m);
  });

  it("preserves table rows as a GFM table", () => {
    expect(page.markdown).toContain("| Strategy | Read latency | Durability |");
    expect(page.markdown).toContain("| --- | --- | --- |");
    expect(page.markdown).toContain("| Cache-aside | Low | High |");
    expect(page.markdown).toContain("| Write-behind | Lowest | Medium |");
  });

  it("preserves the code block as a fenced block with its language", () => {
    expect(page.markdown).toContain("```python\ndef get_user(user_id):\n    cached = cache.get(user_id)");
    expect(page.markdown).toContain("    return user\n```");
  });

  it("drops navigation, sidebar and footer text", () => {
    for (const noise of ["Pricing", "Careers", "Sign in", "Trending now", "Sidebar story", "newsletter", "Copyright 2026", "Privacy policy"]) {
      expect(page.markdown).not.toContain(noise);
    }
    expect(page.markdown).not.toContain("analytics");
  });
});

describe("htmlToMarkdown edge cases", () => {
  it("promotes the first row of a header-less table", () => {
    const html =
      "<html><head><title>T</title></head><body><main><p>" +
      "Filler sentence to give Readability something to chew on. ".repeat(12) +
      "</p><table><tr><td>Name</td><td>Qty</td></tr><tr><td>Apple</td><td>3</td></tr></table></main></body></html>";
    const { markdown } = htmlToMarkdown(html, "https://example.com/");
    expect(markdown).toContain("| Name | Qty |");
    expect(markdown).toContain("| Apple | 3 |");
  });

  it("fences a <pre> without an inner <code> and keeps line breaks", () => {
    const html =
      "<html><body><main><p>" +
      "Some explanatory prose that is long enough to count as the article body. ".repeat(10) +
      "</p><pre>line one<br>line two</pre></main></body></html>";
    expect(htmlToMarkdown(html, "https://example.com/").markdown).toContain("```\nline one\nline two\n```");
  });

  it("keeps the content of a short page that Readability barely recognises", () => {
    const html =
      "<html><head><title>Short</title></head><body><p>Just a few words here.</p><ul><li>One</li><li>Two</li></ul></body></html>";
    const page = htmlToMarkdown(html, "https://example.com/");
    expect(page.title).toBe("Short");
    expect(page.markdown).toContain("Just a few words here.");
    expect(page.markdown).toMatch(/^-\s+One$/m);
  });

  it("returns an empty body for an empty document", () => {
    expect(htmlToMarkdown("", "https://example.com/").markdown).toBe("");
  });
});
