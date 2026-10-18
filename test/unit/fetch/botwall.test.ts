import { describe, expect, it } from "vitest";
import {
  BOT_WALL_SIGNATURES,
  THIN_THRESHOLD_CHARS,
  classifyBotWall,
  detectBotWall,
  isThin,
  visibleText,
} from "../../../src/core/fetch/botwall.js";
import { fixture } from "./helpers.js";

const longArticleMentioningDenial =
  "<html><body><article><h1>Handling errors</h1>" +
  "<p>When a request fails you might see an Access denied page, or a message saying please enable JavaScript. ".repeat(40) +
  "</p></article></body></html>";

interface Case {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  expected: boolean;
  signature?: string;
}

const cases: Case[] = [
  { name: "article page", status: 200, headers: {}, body: fixture("article.html"), expected: false },
  {
    name: "cloudflare challenge, 403 with cf-mitigated header",
    status: 403,
    headers: { "cf-mitigated": "challenge" },
    body: fixture("cloudflare-challenge.html"),
    expected: true,
    signature: "cloudflare-mitigated-header",
  },
  {
    name: "cloudflare challenge, 503 body only",
    status: 503,
    headers: {},
    body: fixture("cloudflare-challenge.html"),
    expected: true,
  },
  {
    name: "cloudflare challenge served with HTTP 200",
    status: 200,
    headers: {},
    body: fixture("cloudflare-challenge.html"),
    expected: true,
  },
  {
    name: "cf-mitigated header alone, long body",
    status: 200,
    headers: { "CF-Mitigated": "challenge" },
    body: fixture("article.html"),
    expected: true,
    signature: "cloudflare-mitigated-header",
  },
  {
    name: "please enable JavaScript page",
    status: 200,
    headers: {},
    body: fixture("enable-javascript.html"),
    expected: true,
    signature: "enable-javascript",
  },
  { name: "akamai 403", status: 403, headers: {}, body: fixture("akamai-403.html"), expected: true },
  { name: "perimeterx 403", status: 403, headers: {}, body: fixture("perimeterx.html"), expected: true },
  {
    name: "perimeterx served with HTTP 200",
    status: 200,
    headers: {},
    body: fixture("perimeterx.html"),
    expected: true,
    signature: "perimeterx",
  },
  { name: "plain text", status: 200, headers: {}, body: fixture("plain.txt"), expected: false },
  { name: "bare 403", status: 403, headers: {}, body: "Forbidden", expected: true, signature: "http-403-short-body" },
  {
    name: "bare 429 with JSON body",
    status: 429,
    headers: { "retry-after": "30" },
    body: '{"error":"rate limited"}',
    expected: true,
    signature: "http-429-short-body",
  },
  { name: "403 with a long normal page", status: 403, headers: {}, body: fixture("article.html"), expected: false },
  { name: "404 short body", status: 404, headers: {}, body: "<h1>Not found</h1>", expected: false },
  { name: "500 short body", status: 500, headers: {}, body: "Internal error", expected: false },
  {
    name: "thin 200 page without signatures",
    status: 200,
    headers: {},
    body: "<html><body><p>Hello.</p></body></html>",
    expected: false,
  },
  { name: "empty 200 body", status: 200, headers: {}, body: "", expected: false },
  {
    name: "long article that merely mentions the phrases",
    status: 200,
    headers: {},
    body: longArticleMentioningDenial,
    expected: false,
  },
  {
    name: "markdown from a reader service",
    status: 200,
    headers: {},
    body: "Title: Just a moment...\n\nJust a moment...\n\nChecking if the site connection is secure",
    expected: true,
  },
  {
    name: "short plain 'Access denied'",
    status: 200,
    headers: {},
    body: "Access denied",
    expected: true,
    signature: "access-denied",
  },
];

describe("classifyBotWall", () => {
  it.each(cases)("$name", ({ status, headers, body, expected, signature }) => {
    expect(classifyBotWall(status, headers, body)).toBe(expected);
    if (signature !== undefined) expect(detectBotWall(status, headers, body)).toBe(signature);
  });

  it("accepts a Headers instance as well as a plain record", () => {
    const headers = new Headers({ "cf-mitigated": "challenge" });
    expect(classifyBotWall(403, headers, "")).toBe(true);
    expect(classifyBotWall(200, new Headers({ "content-type": "text/html" }), fixture("article.html"))).toBe(false);
  });

  it("keeps its signatures in a table with unique ids", () => {
    const ids = BOT_WALL_SIGNATURES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(10);
    for (const sig of BOT_WALL_SIGNATURES) expect(sig.header ?? sig.body).toBeDefined();
  });
});

describe("isThin", () => {
  it("is true at or under the threshold and false above it", () => {
    expect(isThin("")).toBe(true);
    expect(isThin("a".repeat(THIN_THRESHOLD_CHARS))).toBe(true);
    expect(isThin("a".repeat(THIN_THRESHOLD_CHARS + 1))).toBe(false);
  });

  it("measures visible text, not Markdown or HTML syntax", () => {
    const syntax = "[link](https://example.com/" + "x".repeat(600) + ") ![img](https://example.com/i.png)";
    expect(isThin(syntax)).toBe(true);
    expect(isThin("<div class='" + "c".repeat(600) + "'>hi</div>")).toBe(true);
    expect(isThin("| a | b |\n| --- | --- |\n" + "word ".repeat(120))).toBe(false);
  });

  it("does not treat a thin 200 page as a bot wall", () => {
    const thin = "<html><body><p>Short but real.</p></body></html>";
    expect(isThin(thin)).toBe(true);
    expect(classifyBotWall(200, {}, thin)).toBe(false);
  });

  it("visibleText collapses whitespace and entities", () => {
    expect(visibleText("<p>Fish&nbsp;&amp;   chips</p>\n\n<script>var x = 1;</script>")).toBe("Fish & chips");
  });
});
