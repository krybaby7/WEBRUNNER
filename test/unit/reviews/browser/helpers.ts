import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { vi } from "vitest";
import type { RecipeContext } from "../../../../src/core/browser/recipes/types.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../../../src/core/llm/types.js";
import type { ReviewsRecipe } from "../../../../src/core/reviews/sources/shared-browser.js";
import type { ReviewSearchResult } from "../../../../src/core/reviews/types.js";
import type { Logger } from "../../../../src/log.js";
import type { NormalizedReviewsQuery } from "../../../../src/schemas/reviews.js";

export const BROWSER_FIXTURES = fileURLToPath(new URL("../../../fixtures/reviews/browser/", import.meta.url));

export function readFixture(name: string): string {
  return readFileSync(join(BROWSER_FIXTURES, name), "utf8");
}

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

export function makeQuery(over: Partial<NormalizedReviewsQuery> = {}): NormalizedReviewsQuery {
  return {
    subject: "Hotel Lutetia Paris",
    kind: "any",
    sources: ["google_maps", "google_play", "amazon"],
    max_results: 30,
    per_source: 15,
    sort: "relevance",
    app_store_country: "us",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fixture server: one local stand-in for the three sites
// ---------------------------------------------------------------------------

export interface ReviewsFixtureServer {
  url: string;
  /** Every request as "METHOD path?query", in order. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Routes (all under one origin so the recipes can be pointed at it):
 *   Google Maps   /maps/search/<text>   results list by default; "Direct" the place page itself;
 *                                        "Blocked" the unusual-traffic page; "Stalled" the bare shell
 *                                        that never starts (no app container); "Loading" the started app
 *                                        (a search box) whose place never arrives; "Refused" the shell
 *                                        whose application bundle answers HTTP 403; "Nowhere" the empty
 *                                        result; "Unstructured" the place page whose cards carry no
 *                                        data-review-id (LLM path); "Overview" the live 2026-10-27 layout
 *                                        whose overview shows preview cards that the Reviews tab replaces
 *                 /maps/place/...        the place page (consent dialog first)
 *                 /maps/_/js/...         the application bundle: HTTP 403, as Maps answers cloud IPs
 *   Google Play   /play/search?q=        the Notion search page; "Nothing" the empty result
 *                 /play/details?id=      notion.id the details page; blocked.app; stalled.app;
 *                                        unstructured.app (no data-review-id); missing.app (404 text)
 *   Amazon        /amazon/s?k=           the search page; "Nothing" empty; "Captcha" the CAPTCHA page; "Stalled"
 *                 /amazon/product-reviews/<ASIN>  B0B2FCT81R reviews; B0SIGNIN00 and B0MEDLEY00 302 to /amazon/ap/signin;
 *                 /amazon/dp/<ASIN>      B0MEDLEY00 the live product page with its "Top reviews" medley;
 *                                        any other ASIN a product page without a medley;
 *                                        B0CAPTCHA0 the CAPTCHA page; B0STALLED0; B0UNSTRUCT (no review hooks);
 *                                        B0NOREVIEW (product info, "No customer reviews"); B0STATUS50 (HTTP 503)
 *                 /amazon/ap/signin      the recorded sign-in interstitial
 */
export async function startReviewsServer(): Promise<ReviewsFixtureServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method ?? "GET"} ${u.pathname}${u.search}`);
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    const path = u.pathname;
    const stalled = (): void => html(readFixture("google-maps-stalled.html"));

    if (path.startsWith("/maps/_/js/")) {
      html("<title>403</title><p>Your client does not have permission to get this URL from this server.</p>", 403);
    } else if (path.startsWith("/maps/search/")) {
      const text = decodeURIComponent(path.slice("/maps/search/".length));
      if (/Blocked/.test(text)) html(readFixture("google-maps-blocked.html"));
      else if (/Stalled/.test(text)) stalled();
      else if (/Loading/.test(text)) html(readFixture("google-maps-stalled.html").replace('<div class="spinner"', '<input name="q" aria-label="Search Google Maps"><div class="spinner"'));
      else if (/Refused/.test(text)) html(readFixture("google-maps-script-refused.html"));
      else if (/Nowhere/.test(text)) html(readFixture("google-maps-empty.html"));
      else if (/Unstructured/.test(text)) html(readFixture("google-maps-place.html").replace('el.setAttribute("data-review-id", r.id);', ""));
      else if (/Direct/.test(text)) html(readFixture("google-maps-place.html"));
      else if (/Overview/.test(text)) html(readFixture("google-maps-place-live.html"));
      else html(readFixture("google-maps-results.html"));
    } else if (path.startsWith("/maps/place/")) {
      html(readFixture("google-maps-place.html"));
    } else if (path === "/play/search") {
      const q = u.searchParams.get("q") ?? "";
      if (/Nothing/.test(q)) html(readFixture("google-play-empty.html"));
      else if (/Blocked/.test(q)) html(readFixture("google-maps-blocked.html"));
      else html(readFixture("google-play-search.html"));
    } else if (path === "/play/details") {
      const id = u.searchParams.get("id") ?? "";
      if (id === "blocked.app") html(readFixture("google-maps-blocked.html"));
      else if (id === "stalled.app") stalled();
      else if (id === "unstructured.app") html(readFixture("google-play-details.html").replaceAll('data-review-id="${r.id}"', 'data-card="${r.id}"'));
      else if (id === "missing.app") html("<title>Not Found</title><p>We're sorry, the requested URL was not found on this server.</p>", 404);
      else html(readFixture("google-play-details.html"));
    } else if (path === "/amazon/s") {
      const k = u.searchParams.get("k") ?? "";
      if (/Nothing/.test(k)) html(readFixture("amazon-empty.html"));
      else if (/Captcha/.test(k)) html(readFixture("amazon-captcha.html"));
      else if (/Stalled/.test(k)) stalled();
      else html(readFixture("amazon-search.html"));
    } else if (path.startsWith("/amazon/product-reviews/")) {
      const asin = path.split("/")[3] ?? "";
      if (asin === "B0SIGNIN00" || asin === "B0MEDLEY00") {
        res
          .writeHead(302, { location: `/amazon/ap/signin?openid.return_to=${encodeURIComponent(`http://localhost${path}${u.search}`)}&openid.mode=checkid_setup` })
          .end();
      } else if (asin === "B0CAPTCHA0") html(readFixture("amazon-captcha.html"));
      else if (asin === "B0STALLED0") stalled();
      else if (asin === "B0UNSTRUCT") html(readFixture("amazon-reviews.html").replaceAll('data-hook="review"', 'data-hook="review-card"'));
      else if (asin === "B0NOREVIEW") {
        html(
          '<title>Customer reviews</title><div id="cm_cr-product_info"><a data-hook="product-link" href="/dp/B0NOREVIEW">Unreviewed Gadget</a>' +
            '<span data-hook="rating-out-of-text">0 out of 5</span> <span data-hook="total-review-count">0 global ratings</span></div>' +
            '<div id="cm_cr-review_list"><p>No customer reviews</p></div>',
        );
      } else if (asin === "B0STATUS50") html("<title>503</title>", 503);
      else html(readFixture("amazon-reviews.html"));
    } else if (path.startsWith("/amazon/dp/")) {
      const asin = path.split("/")[3] ?? "";
      if (asin === "B0MEDLEY00") html(readFixture("amazon-product-medley-live.html"));
      else html('<title>Amazon.com: Gadget</title><span id="productTitle">Gadget without a medley</span><span data-hook="rating-out-of-text">4.1 out of 5</span>');
    } else if (path === "/amazon/ap/signin") {
      html(readFixture("amazon-signin.html"));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// LLM stand-ins
// ---------------------------------------------------------------------------

export interface ScriptedLlm extends LlmClient {
  calls: LlmRequest[];
}

/** An LlmClient whose answer is computed from the request. Records every request. */
export function scriptedLlm(respond: (req: LlmRequest) => unknown): ScriptedLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      req.meter?.check();
      const raw = respond(req);
      return {
        parsed: req.schema !== undefined ? req.schema.parse(raw) : raw,
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.01,
        model: "claude-sonnet-5-5",
        stopReason: "end_turn",
      };
    },
  };
}

/** An LlmClient that fails the test when called: the deterministic probe must do the work. */
export function neverLlm(): ScriptedLlm {
  return scriptedLlm(() => {
    throw new Error("the LLM must not be called on this page");
  });
}

/** The user message text of a request. */
export function promptOf(req: LlmRequest): string {
  const m = req.messages[0];
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
}

// ---------------------------------------------------------------------------
// Page spy: the recipes must never type into the page
// ---------------------------------------------------------------------------

/** Playwright methods that type, press keys or change form controls. */
export const FORBIDDEN_PAGE_METHODS = new Set([
  "fill", "type", "press", "pressSequentially", "check", "uncheck", "selectOption", "setInputFiles",
  "insertText", "setChecked", "dragAndDrop", "dragTo",
]);

export interface PageSpy {
  /** The proxied page to hand to the recipe. */
  page: Page;
  /** `method` names of every forbidden call that was attempted. */
  forbidden: string[];
  /** Names of every method called on the page itself (for a rough audit). */
  calls: string[];
}

/**
 * Wraps a Page (and every Frame, Locator, Keyboard and ElementHandle it hands
 * out) so that a forbidden method records itself and throws. Allowed methods
 * pass through to the real object.
 */
export function spyPage(real: Page): PageSpy {
  const forbidden: string[] = [];
  const calls: string[] = [];
  const wrapped = new WeakMap<object, unknown>();

  const wrapValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(wrapValue);
    if (v !== null && typeof v === "object" && isPlaywrightLike(v)) return wrap(v);
    return v;
  };

  const wrap = <T extends object>(target: T): T => {
    const cached = wrapped.get(target);
    if (cached !== undefined) return cached as T;
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof prop !== "string") return value;
        if (typeof value === "function") {
          if (FORBIDDEN_PAGE_METHODS.has(prop)) {
            return (): never => {
              forbidden.push(prop);
              throw new Error(`forbidden page method called: ${prop}`);
            };
          }
          return (...args: unknown[]): unknown => {
            if (t === real) calls.push(prop);
            const result = (value as (...a: unknown[]) => unknown).apply(t, args);
            if (result instanceof Promise) return result.then(wrapValue);
            return wrapValue(result);
          };
        }
        if (prop === "keyboard" || prop === "mouse" || prop === "touchscreen") return wrapValue(value);
        return value;
      },
    });
    wrapped.set(target, proxy);
    return proxy;
  };
  return { page: wrap(real), forbidden, calls };
}

function isPlaywrightLike(v: object): boolean {
  const o = v as Record<string, unknown>;
  return typeof o["click"] === "function" || typeof o["press"] === "function" || typeof o["locator"] === "function" || typeof o["type"] === "function";
}

// ---------------------------------------------------------------------------
// Running a recipe on a real page
// ---------------------------------------------------------------------------

export interface RecipeRun<T = unknown> {
  result?: ReviewSearchResult;
  error?: unknown;
  caveats: string[];
  log: ReturnType<typeof makeLogger>;
  spy: PageSpy;
  after?: T;
}

export async function runRecipe<T = unknown>(
  session: BrowserSession,
  recipe: ReviewsRecipe,
  q: NormalizedReviewsQuery,
  llm: LlmClient,
  over: Partial<RecipeContext> = {},
  after?: (page: Page) => Promise<T>,
): Promise<RecipeRun<T>> {
  const log = makeLogger();
  const caveats: string[] = [];
  const real = await session.acquire();
  const spy = spyPage(real);
  try {
    const ctx: RecipeContext = { llm, log, deadline: Date.now() + 25_000, caveats, ...over };
    const settled: { result?: ReviewSearchResult; error?: unknown } = await recipe.run(spy.page, q, ctx).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const extra = after !== undefined ? await after(real).catch(() => undefined) : undefined;
    return { ...settled, caveats, log, spy, ...(extra !== undefined && { after: extra }) };
  } finally {
    await session.release(real);
  }
}

/** A fake BrowserSession for provider tests: hands out one stub page. */
export function fakeBrowser(): BrowserSession & { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; page: Page & { close: ReturnType<typeof vi.fn> } } {
  const page = { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() } as unknown as Page & { close: ReturnType<typeof vi.fn> };
  return {
    page,
    acquire: vi.fn().mockResolvedValue(page),
    release: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isOpen: () => true,
    stats: () => ({}) as never,
    cookies: () => Promise.resolve([]),
    clearCookies: () => Promise.resolve(0),
    openUnpooledPage: () => Promise.reject(new Error("fakeBrowser: openUnpooledPage is not available")),
  } as never;
}
