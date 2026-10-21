import { describe, expect, it } from "vitest";
import { FetchServiceError } from "../../../src/core/fetch/index.js";
import { CostMeter } from "../../../src/core/llm/cost.js";
import type { LlmRequest } from "../../../src/core/llm/types.js";
import { APPROXIMATE_DATE_CAVEAT } from "../../../src/core/reviews/normalize.js";
import type { Page } from "playwright";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { bareDomain, parseJsonLd, parseNextData, TrustpilotSource, type TrustpilotExtraction } from "../../../src/core/reviews/sources/trustpilot.js";
import { ReviewSourceError } from "../../../src/core/reviews/types.js";
import { ReviewSchema, ReviewSubjectSchema, type NormalizedReviewsQuery } from "../../../src/schemas/reviews.js";
import { scriptedLlm, userText } from "../research/helpers.js";
import { BASE_QUERY, fakeFetch, fakeFetchService, htmlResponse, NOW, readFixture, type RecordedCall } from "./helpers.js";

/**
 * The embedded-JSON fixtures (`trustpilot-next-data.html`, `trustpilot-jsonld.html`)
 * are FROM DOCS, UNVERIFIED; `trustpilot-waf-challenge.html` is the real AWS WAF
 * challenge recorded live on 2026-10-18 (HTTP 403).
 */
const nextDataHtml = readFixture("trustpilot-next-data.html");
const jsonLdHtml = readFixture("trustpilot-jsonld.html");
const wafHtml = readFixture("trustpilot-waf-challenge.html");
const searchHtml = readFixture("trustpilot-search.html");
const pageMarkdown = readFixture("trustpilot-page.md");
/** The notion.so review page as Chromium rendered it past the WAF on 2026-10-21 (trimmed, names pseudonymized). */
const liveHtml = readFixture("trustpilot-review-live.html");

const BASE = "https://www.trustpilot.com";
const PAGE = `${BASE}/review/acme-travel.example`;
const Q: NormalizedReviewsQuery = { ...BASE_QUERY, subject: "https://www.acme-travel.example/deals", subject_url: "https://www.acme-travel.example/deals", sources: ["trustpilot"] };
const signal = (): AbortSignal => new AbortController().signal;

/** What a careful model returns for the Markdown fixture. */
const EXTRACTION: TrustpilotExtraction = {
  subject: { name: "Acme Travel", rating_avg: 3.6, review_count: 1284, categories: ["Travel Agency", "Hotel"] },
  reviews: [
    {
      url: `${BASE}/reviews/6711a0c1e3f2a90012ab0001`,
      author: "Marta K",
      rating: 5,
      title: "Smooth booking, quick support",
      text: "Booked a week in Lisbon through Acme. The confirmation came through in minutes and the hotel matched the photos. Customer service answered my change request within the hour.",
      date: "Oct 2, 2026",
      verified: true,
      language: null,
      response: "Thank you, Marta! We are glad the change went smoothly.",
    },
    {
      url: `${BASE}/reviews/6710b2d2e3f2a90012ab0002`,
      author: "Daniel O",
      rating: 2,
      title: "Refund took far too long",
      text: "Flight was cancelled by the airline and Acme took three weeks to process the refund. Every call meant repeating the whole story. The money did arrive in the end.",
      date: "2 weeks ago",
      verified: false,
      language: null,
      response: null,
    },
    { url: null, author: "Claire B", rating: 3, title: "Correct mais perfectible", text: "Prix corrects, mais l'application plante souvent au moment du paiement.", date: "Sep 20, 2026", verified: true, language: "fr", response: null },
  ],
};

function wafFetch(): ReturnType<typeof fakeFetch> {
  return fakeFetch(() => htmlResponse(wafHtml, 403, { server: "CloudFront" }));
}

function routed(over: Partial<Record<"review" | "search", (call: RecordedCall) => Response>> = {}) {
  return fakeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname.startsWith("/review/")) return (over.review ?? (() => htmlResponse(nextDataHtml)))(call);
    if (url.pathname === "/search") return (over.search ?? (() => htmlResponse(searchHtml)))(call);
    return new Response("not found", { status: 404 });
  });
}

/**
 * A browser whose pages "render" a URL into the given HTML and final navigation
 * status, or fail to (an Error). Records the URLs visited; never types or clicks.
 */
function fakeBrowser(render: (url: string) => { html: string; status?: number } | Error): BrowserSession & { visited: string[]; released: number } {
  const visited: string[] = [];
  const state = { released: 0 };
  const makePage = (): Page => {
    let current = "about:blank";
    let result: { html: string; status?: number } | Error = { html: "" };
    const listeners: Array<(res: unknown) => void> = [];
    const mainFrame = {};
    const page = {
      on: (event: string, fn: (res: unknown) => void) => {
        if (event === "response") listeners.push(fn);
        return page;
      },
      off: () => page,
      mainFrame: () => mainFrame,
      url: () => current,
      close: async () => undefined,
      goto: async (url: string) => {
        visited.push(url);
        current = url;
        result = render(url);
        if (!(result instanceof Error)) {
          const status = result.status ?? 200;
          for (const fn of listeners) fn({ status: () => status, frame: () => mainFrame, request: () => ({ isNavigationRequest: () => true }) });
        }
        return null;
      },
      waitForSelector: async () => {
        if (result instanceof Error) throw result;
        return null;
      },
      content: async () => (result instanceof Error ? "" : result.html),
    };
    return page as unknown as Page;
  };
  return {
    visited,
    get released() {
      return state.released;
    },
    acquire: async () => makePage(),
    release: async () => {
      state.released++;
    },
  } as unknown as BrowserSession & { visited: string[]; released: number };
}

async function failure(p: Promise<unknown>): Promise<ReviewSourceError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReviewSourceError);
  return err as ReviewSourceError;
}

describe("parseNextData", () => {
  it("maps the embedded JSON to the subject and reviews", () => {
    const out = parseNextData(nextDataHtml, PAGE);
    expect(out).toBeDefined();
    expect(ReviewSubjectSchema.safeParse(out?.subject).success).toBe(true);
    expect(out?.subject).toEqual({
      source: "trustpilot",
      name: "Acme Travel",
      url: PAGE,
      rating_avg: 3.6,
      review_count: 1284,
      rating_distribution: { "1": 312, "2": 96, "3": 120, "4": 236, "5": 520 },
      categories: ["Travel Agency", "Hotel"],
    });
    expect(out?.reviews).toHaveLength(4);
    for (const r of out?.reviews ?? []) expect(ReviewSchema.safeParse(r).success).toBe(true);
    expect(out?.reviews[0]).toEqual({
      id: "trustpilot:6711a0c1e3f2a90012ab0001",
      source: "trustpilot",
      url: `${BASE}/reviews/6711a0c1e3f2a90012ab0001`,
      author: "Marta K",
      rating: 5,
      title: "Smooth booking, quick support",
      text: expect.stringMatching(/^Booked a week in Lisbon/) as string,
      truncated: false,
      created_at: "2026-10-02T10:11:12.000Z",
      helpful_votes: 3,
      verified: true,
      language: "en",
      response: { text: "Thank you, Marta! We are glad the change went smoothly.", created_at: "2026-10-03T08:00:00.000Z" },
    });
    expect(out?.reviews[1]).toMatchObject({ rating: 2, verified: false, helpful_votes: 11 });
    expect(out?.reviews[1]?.response).toBeUndefined();
    expect(out?.reviews[2]).toMatchObject({ language: "fr", rating: 3 });
    // An empty review body is still a review.
    expect(out?.reviews[3]).toMatchObject({ text: "", title: "Avoid", rating: 1 });
    expect(out?.reviews[3]?.helpful_votes).toBeUndefined();
  });

  it("is undefined when the page carries no __NEXT_DATA__ or no reviews", () => {
    expect(parseNextData(jsonLdHtml, PAGE)).toBeUndefined();
    expect(parseNextData(wafHtml, PAGE)).toBeUndefined();
    expect(parseNextData('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>', PAGE)).toBeUndefined();
    expect(parseNextData('<script id="__NEXT_DATA__" type="application/json">not json</script>', PAGE)).toBeUndefined();
  });

  it("reads the histogram from the filters block when the business unit only has a total", () => {
    const html = nextDataHtml.replace(
      /"numberOfReviews":\{[^}]*\}/,
      '"numberOfReviews":1284',
    );
    const out = parseNextData(html, PAGE);
    expect(out?.subject.review_count).toBe(1284);
    expect(out?.subject.rating_distribution).toEqual({ "1": 312, "2": 96, "3": 120, "4": 236, "5": 520 });
  });
});

describe("parseJsonLd", () => {
  it("maps Review items and the business's aggregate rating", () => {
    const out = parseJsonLd(jsonLdHtml, PAGE);
    expect(out).toBeDefined();
    expect(out?.subject).toEqual({ source: "trustpilot", name: "Acme Travel", url: PAGE, rating_avg: 3.6, review_count: 1284 });
    expect(out?.reviews).toHaveLength(2);
    for (const r of out?.reviews ?? []) expect(ReviewSchema.safeParse(r).success).toBe(true);
    expect(out?.reviews[0]).toMatchObject({
      id: "trustpilot:6711a0c1e3f2a90012ab0001",
      url: `${BASE}/reviews/6711a0c1e3f2a90012ab0001`,
      author: "Marta K",
      rating: 5,
      title: "Smooth booking, quick support",
      created_at: "2026-10-02T10:11:12.000Z",
      language: "en",
    });
    expect(out?.reviews[1]).toMatchObject({ rating: 2, author: "Daniel O" });
  });

  it("is undefined without Review items and skips malformed blocks", () => {
    expect(parseJsonLd(wafHtml, PAGE)).toBeUndefined();
    expect(parseJsonLd('<script type="application/ld+json">{oops</script>', PAGE)).toBeUndefined();
  });
});

describe("TrustpilotSource", () => {
  it("is keyless and answers for business, product and any", () => {
    const src = new TrustpilotSource();
    expect(src.isConfigured()).toBe(true);
    expect(src.defaultKinds).toEqual(["business", "product", "any"]);
  });

  it("turns a subject URL into /review/<host> (www. stripped) and parses the embedded JSON", async () => {
    const f = routed();
    const out = await new TrustpilotSource({ fetchImpl: f.fetchImpl }).search(Q, signal());
    expect(f.calls.map((c) => c.url)).toEqual([PAGE]);
    expect(f.calls[0]?.headers["user-agent"]).toMatch(/Mozilla/);
    expect(out.subject.name).toBe("Acme Travel");
    expect(out.reviews).toHaveLength(4);
  });

  it("uses a trustpilot.com/review URL as is, drops its query, and rejects other Trustpilot URLs", async () => {
    const f = routed();
    const src = new TrustpilotSource({ fetchImpl: f.fetchImpl });
    const url = `${BASE}/review/acme-travel.example?page=2&stars=1`;
    await src.search({ ...Q, subject: url, subject_url: url }, signal());
    expect(f.calls[0]?.url).toBe(PAGE);
    const bad = `${BASE}/categories/travel`;
    expect((await failure(src.search({ ...Q, subject: bad, subject_url: bad }, signal()))).code).toBe("invalid_input");
  });

  it("resolves a name through the search page and takes the first /review/ link", async () => {
    const f = routed();
    const caveats: string[] = [];
    const out = await new TrustpilotSource({ fetchImpl: f.fetchImpl }).search({ ...BASE_QUERY, subject: "acme travel", sources: ["trustpilot"] }, signal(), { caveats });
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/search?query=acme%20travel`, PAGE]);
    expect(out.subject.url).toBe(PAGE);
    expect(caveats[0]).toMatch(/matched "acme travel" to the first search result, acme-travel.example/);
  });

  it("is not_found when the search page has no company link or the review page is a 404", async () => {
    const noHit = routed({ search: () => htmlResponse("<html><body><p>No results</p></body></html>") });
    const err = await failure(new TrustpilotSource({ fetchImpl: noHit.fetchImpl }).search({ ...BASE_QUERY, subject: "zzzz", sources: ["trustpilot"] }, signal()));
    expect(err).toMatchObject({ code: "not_found", retryable: false });

    const gone = routed({ review: () => htmlResponse("<html><body>Page not found</body></html>", 404) });
    expect((await failure(new TrustpilotSource({ fetchImpl: gone.fetchImpl }).search(Q, signal()))).code).toBe("not_found");
  });

  it("falls back to JSON-LD when there is no __NEXT_DATA__, and cuts at per_source", async () => {
    const f = routed({ review: () => htmlResponse(jsonLdHtml) });
    const out = await new TrustpilotSource({ fetchImpl: f.fetchImpl }).search({ ...Q, per_source: 1 }, signal());
    expect(out.reviews).toHaveLength(1);
    expect(out.reviews[0]?.id).toBe("trustpilot:6711a0c1e3f2a90012ab0001");
  });

  it("tries a bare domain as /review/<domain>, and searches when Trustpilot has no page for it", async () => {
    const f = routed();
    const out = await new TrustpilotSource({ fetchImpl: f.fetchImpl }).search({ ...BASE_QUERY, subject: "www.Acme-Travel.example", sources: ["trustpilot"] }, signal());
    expect(f.calls.map((c) => c.url)).toEqual([PAGE]);
    expect(out.subject.name).toBe("Acme Travel");

    const g = routed({ review: (call) => (call.url.endsWith("/review/node.js") ? htmlResponse("<html><body>Page not found</body></html>", 404) : htmlResponse(nextDataHtml)) });
    await new TrustpilotSource({ fetchImpl: g.fetchImpl }).search({ ...BASE_QUERY, subject: "Node.js", sources: ["trustpilot"] }, signal());
    expect(g.calls.map((c) => c.url)).toEqual([`${BASE}/review/node.js`, `${BASE}/search?query=Node.js`, PAGE]);

    expect(bareDomain("notion.so")).toBe("notion.so");
    expect(bareDomain("amazon.co.uk")).toBe("amazon.co.uk");
    expect(bareDomain("Hotel Lutetia Paris")).toBeUndefined();
    expect(bareDomain("Sony WH-1000XM5")).toBeUndefined();
  });

  describe("past the WAF challenge through the browser (live 2026-10-21)", () => {
    const noModel = scriptedLlm({});
    const noFetch = fakeFetchService(() => new Error("the Markdown path must not be needed"));

    it("parses the rendered page's embedded JSON with no model call", async () => {
      const browser = fakeBrowser(() => ({ html: liveHtml }));
      const caveats: string[] = [];
      const out = await new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, browser, fetch: noFetch, llm: noModel, now: () => NOW }).search(
        { ...BASE_QUERY, subject: "notion.so", sources: ["trustpilot"] },
        signal(),
        { caveats },
      );
      expect(browser.visited).toEqual([`${BASE}/review/notion.so`]);
      expect(browser.released).toBe(1);
      expect(noModel.requests).toHaveLength(0);
      expect(noFetch.calls).toHaveLength(0);
      expect(ReviewSubjectSchema.safeParse(out.subject).success).toBe(true);
      expect(out.subject).toMatchObject({ name: "Notion", rating_avg: 2.2, review_count: 440, rating_distribution: { "1": 193, "2": 35, "3": 23, "4": 47, "5": 142 } });
      expect(out.reviews).toHaveLength(5);
      for (const r of out.reviews) expect(ReviewSchema.safeParse(r).success).toBe(true);
      expect(out.reviews[0]).toMatchObject({ id: "trustpilot:6ad7520a11259b84c22e22b3", author: "Reviewer A", rating: 2, created_at: "2026-10-20T13:35:38.000Z", verified: false, language: "en" });
      expect(caveats.some((c) => /LLM/.test(c))).toBe(false);
    });

    it("resolves a walled search through the rendered search page", async () => {
      const browser = fakeBrowser((url) => ({ html: url.includes("/search?") ? searchHtml : liveHtml }));
      const out = await new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, browser, fetch: noFetch, llm: noModel, now: () => NOW }).search(
        { ...BASE_QUERY, subject: "acme travel", sources: ["trustpilot"] },
        signal(),
      );
      expect(browser.visited).toEqual([`${BASE}/search?query=acme%20travel`, PAGE]);
      expect(out.reviews).toHaveLength(5);
    });

    it("a rendered 404 is not_found, so a bare domain falls back to the search", async () => {
      const browser = fakeBrowser((url) => (url.endsWith("/review/node.js") ? { html: "<script id=\"__NEXT_DATA__\">{}</script>", status: 404 } : { html: url.includes("/search?") ? searchHtml : liveHtml }));
      await new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, browser, fetch: noFetch, llm: noModel }).search({ ...BASE_QUERY, subject: "node.js", sources: ["trustpilot"] }, signal());
      expect(browser.visited).toEqual([`${BASE}/review/node.js`, `${BASE}/search?query=node.js`, PAGE]);
      const err = await failure(new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, browser: fakeBrowser(() => ({ html: "", status: 404 })) }).search(Q, signal()));
      expect(err.code).toBe("not_found");
    });

    it("falls back to the Markdown and model path when the render fails", async () => {
      const browser = fakeBrowser(() => new Error("Timeout 25000ms exceeded"));
      const fetchService = fakeFetchService(() => pageMarkdown);
      const llm = scriptedLlm({ extractor: [EXTRACTION] });
      const out = await new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, browser, fetch: fetchService, llm, now: () => NOW }).search(Q, signal());
      expect(browser.visited).toEqual([PAGE]);
      expect(fetchService.calls).toHaveLength(1);
      expect(llm.requests).toHaveLength(1);
      expect(out.reviews).toHaveLength(3);
    });
  });

  describe("on the recorded WAF challenge", () => {
    it("falls back to the fetch service and schema-driven LLM extraction, validated in code", async () => {
      const f = wafFetch();
      const fetchService = fakeFetchService(() => pageMarkdown);
      const llm = scriptedLlm({ extractor: [EXTRACTION], costPerCall: 0.02 });
      const caveats: string[] = [];
      const meter = new CostMeter({ maxCostUsd: 0.5 });
      const src = new TrustpilotSource({ fetchImpl: f.fetchImpl, fetch: fetchService, llm, now: () => NOW });
      const out = await src.search(Q, signal(), { caveats, meter });

      expect(fetchService.calls).toEqual([{ url: PAGE, mode: "auto", max_chars: 60_000 }]);
      expect(llm.requests).toHaveLength(1);
      const req = llm.requests[0] as LlmRequest;
      expect(req.role).toBe("extractor");
      expect(req.schema).toBeDefined();
      expect(req.maxTokens).toBe(16_000);
      expect(req.meter).toBe(meter);
      expect(req.signal).toBeDefined();
      expect(userText(req)).toContain("Marta K");
      expect(userText(req)).toContain(PAGE);
      expect(meter.totalCostUsd).toBeCloseTo(0.02);

      expect(ReviewSubjectSchema.safeParse(out.subject).success).toBe(true);
      expect(out.subject).toEqual({ source: "trustpilot", name: "Acme Travel", url: PAGE, rating_avg: 3.6, review_count: 1284, categories: ["Travel Agency", "Hotel"] });
      expect(out.reviews).toHaveLength(3);
      for (const r of out.reviews) expect(ReviewSchema.safeParse(r).success).toBe(true);
      expect(out.reviews[0]).toMatchObject({
        id: "trustpilot:6711a0c1e3f2a90012ab0001",
        url: `${BASE}/reviews/6711a0c1e3f2a90012ab0001`,
        author: "Marta K",
        rating: 5,
        verified: true,
        response: { text: "Thank you, Marta! We are glad the change went smoothly." },
      });
      expect(out.reviews[0]?.created_at).toBe(new Date(Date.parse("Oct 2, 2026")).toISOString());
      // "2 weeks ago" is approximated from the clock and flagged.
      expect(out.reviews[1]?.created_at).toBe(new Date(NOW - 14 * 86_400_000).toISOString());
      expect(caveats).toContain(APPROXIMATE_DATE_CAVEAT);
      expect(caveats.some((c) => /LLM extractor/.test(c))).toBe(true);
      // No URL for the third review: a hashed id and no url field.
      expect(out.reviews[2]?.id).toMatch(/^trustpilot:[0-9a-f]{12}$/);
      expect(out.reviews[2]?.url).toBeUndefined();
      expect(out.reviews[2]?.language).toBe("fr");
    });

    it("is blocked without an LLM, before touching the fetch service", async () => {
      const fetchService = fakeFetchService(() => pageMarkdown);
      const err = await failure(new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, fetch: fetchService }).search(Q, signal()));
      expect(err).toMatchObject({ code: "blocked", retryable: false, needsLogin: false });
      expect(err.message).toMatch(/bot-wall challenge \(http-403-short-body, HTTP 403\)/);
      expect(err.message).toContain("ANTHROPIC_API_KEY");
      expect(fetchService.calls).toHaveLength(0);
    });

    it("is blocked without a fetch service", async () => {
      const llm = scriptedLlm({ extractor: [EXTRACTION] });
      const err = await failure(new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, llm }).search(Q, signal()));
      expect(err.code).toBe("blocked");
      expect(err.message).toContain("fetch service is not available");
      expect(llm.requests).toHaveLength(0);
    });

    it("maps a fetch service failure: blocked stays blocked, timeout stays timeout, config is blocked", async () => {
      const llm = scriptedLlm({ extractor: [EXTRACTION] });
      for (const [code, expected] of [
        ["blocked", "blocked"],
        ["timeout", "timeout"],
        ["config", "blocked"],
        ["provider", "provider"],
      ] as const) {
        const fetchService = fakeFetchService(() => new FetchServiceError({ code, message: `fetch ${code}`, retryable: code === "timeout" }));
        const err = await failure(new TrustpilotSource({ fetchImpl: wafFetch().fetchImpl, fetch: fetchService, llm }).search(Q, signal()));
        expect(err.code).toBe(expected);
        expect(err.message).toContain(`fetch ${code}`);
      }
    });

    it("also takes the rendered path for a 200 page without embedded JSON", async () => {
      const f = routed({ review: () => htmlResponse("<html><body>" + "<p>Acme Travel reviews rendered client-side.</p>".repeat(40) + "</body></html>") });
      const fetchService = fakeFetchService(() => pageMarkdown);
      const llm = scriptedLlm({ extractor: [EXTRACTION] });
      const out = await new TrustpilotSource({ fetchImpl: f.fetchImpl, fetch: fetchService, llm, now: () => NOW }).search(Q, signal());
      expect(fetchService.calls).toHaveLength(1);
      expect(out.reviews).toHaveLength(3);
    });

    it("resolves a name through the rendered search page when the search is walled", async () => {
      const f = wafFetch();
      const fetchService = fakeFetchService((input) =>
        input.url.includes("/search?") ? `# Results\n\n[Acme Travel](${BASE}/review/acme-travel.example)\n[Acme Tours](${BASE}/review/acme-tours.example)` : pageMarkdown,
      );
      const llm = scriptedLlm({ extractor: [EXTRACTION] });
      const out = await new TrustpilotSource({ fetchImpl: f.fetchImpl, fetch: fetchService, llm, now: () => NOW }).search({ ...BASE_QUERY, subject: "acme travel", sources: ["trustpilot"] }, signal());
      expect(fetchService.calls.map((c) => c.url)).toEqual([`${BASE}/search?query=acme%20travel`, PAGE]);
      expect(out.subject.url).toBe(PAGE);
    });
  });
});
