import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { vi } from "vitest";
import type { LlmClient, LlmRequest, LlmResponse } from "../../../../src/core/llm/types.js";
import type { Logger } from "../../../../src/log.js";
import type { SocialSearchQuery } from "../../../../src/schemas/social.js";

export const SOCIAL_FIXTURES = fileURLToPath(new URL("../../../fixtures/social/browser/", import.meta.url));

export function readFixture(name: string): string {
  return readFileSync(join(SOCIAL_FIXTURES, name), "utf8");
}

export interface SocialServer {
  url: string;
  /** Base URL for one scenario: the recipe's `baseUrl`. */
  scenario(name: string): string;
  /** Every request seen, as "METHOD /path?query". */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Local stand-in for x.com, www.facebook.com and old.reddit.com. Each scenario
 * is a base URL `/s/<name>` under which the site's own paths are served:
 *
 *   x-ok          /search -> results; /<handle>/status/<id> -> thread page
 *   x-sparse      /search -> two usable posts and a promoted card (LLM fallback)
 *   x-login       /search -> 302 to /i/flow/login -> login page
 *   x-onboarding  /search -> 307 to /i/jf/onboarding/web?...&mode=login (as live curl saw)
 *   x-403         /search -> HTTP 403, empty body (as live headless Chromium saw)
 *   x-empty       /search -> "No results for ..."
 *   fb-ok         /search/posts/ -> results; /<page>/posts/<id> -> post page
 *   fb-live       /search/posts/ -> the live 2026-10-27 layout (virtualised feed, obfuscated dates, an
 *                 advert, permalinks only in page data); POST /api/graphql/ -> one more permalink
 *   fb-login      /search/posts/ -> 302 to /login/ -> login page (from the live capture)
 *   fb-404        /search/posts/ -> HTTP 404 "Not Found" (as live)
 *   fb-checkpoint /search/posts/ -> 302 to /checkpoint/... -> checkpoint page
 *   rd-ok         /search, /r/<subs>/search -> results; /r/<sub>/comments/<id>/... -> thread
 *   rd-over18     /search -> over-18 interstitial; POST /over18?dest= -> 302 to dest (under rd-ok)
 *   rd-login      /search -> 302 to /login/?reason=lor2 -> login form
 *   rd-netsec     /search -> 302 to /login/?reason=lor2 -> HTTP 403 network-security block (as live)
 *   rd-empty      /search -> "there doesn't seem to be anything here"
 *   botwall       anything -> Cloudflare-style challenge
 *   stalled       anything -> a page that never shows results
 *   status-500    anything -> HTTP 500
 */
export async function startSocialServer(): Promise<SocialServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method ?? "GET"} ${u.pathname}${u.search}`);
    const m = /^\/s\/([a-z0-9-]+)(\/.*)?$/.exec(u.pathname);
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    const redirect = (to: string, status = 302): void => {
      res.writeHead(status, { location: to }).end();
    };
    if (m === null) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const scenario = m[1] as string;
    const path = m[2] ?? "/";
    const base = `/s/${scenario}`;
    const dest = encodeURIComponent(`${path}${u.search}`);
    switch (scenario) {
      case "x-ok":
        if (path === "/search") return html(readFixture("x-search-results.html"));
        if (/^\/[A-Za-z0-9_]+\/status\/\d+$/.test(path)) return html(readFixture("x-thread.html"));
        return html(readFixture("x-login-wall.html"));
      case "x-sparse":
        return html(readFixture("x-search-sparse.html"));
      case "x-login":
        if (path === "/search") return redirect(`${base}/i/flow/login?redirect_after_login=${dest}`);
        return html(readFixture("x-login-wall.html"));
      case "x-onboarding":
        if (path === "/search") return redirect(`${base}/i/jf/onboarding/web?redirect_after_login=${dest}&mode=login`, 307);
        return html("<!doctype html><title>X</title><main role='main'><p>Loading</p></main>");
      case "x-403":
        return html("", 403);
      case "x-empty":
        return html('<!doctype html><title>Search / X</title><main role="main"><div>No results for "claude code"</div><p>Try searching for something else</p></main>');
      case "fb-ok":
        if (path === "/search/posts/") return html(readFixture("facebook-search-results.html"));
        if (/\/posts\//.test(path)) return html(readFixture("facebook-post.html"));
        return html("<!doctype html><title>Facebook</title><div role='main'>Not Found</div>", 404);
      case "fb-login":
        if (path.startsWith("/login")) return html(readFixture("facebook-login.html"));
        return redirect(`${base}/login/?next=${dest}`);
      case "fb-404":
        return html("Not Found", 404);
      case "fb-live":
        if (path === "/search/posts/") return html(readFixture("facebook-search-live.html"));
        if (path === "/api/graphql/") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"data":{"node":{"post_id":"9006","permalink_url":"https://www.facebook.com/potatokeebs/posts/pfbid0TestLate"}}}');
          return;
        }
        return html("Not Found", 404);
      case "fb-checkpoint":
        if (path.startsWith("/checkpoint/")) return html(readFixture("facebook-checkpoint.html"));
        return redirect(`${base}/checkpoint/1501092823525282/?next=${dest}`);
      case "rd-ok":
        if (path === "/search" || /^\/r\/[^/]+\/search$/.test(path)) return html(readFixture("old-reddit-search.html"));
        if (/\/comments\/[a-z0-9]+/i.test(path)) return html(readFixture("old-reddit-thread.html"));
        return html("<!doctype html><title>reddit</title><div class='content'>there doesn't seem to be anything here</div>", 404);
      case "rd-over18":
        if (path === "/over18" && req.method === "POST") {
          return redirect(u.searchParams.get("dest") ?? "/s/rd-ok/search");
        }
        return html(
          readFixture("old-reddit-over18.html")
            .replace('action="/over18', `action="${base}/over18`)
            .replace("__DEST__", encodeURIComponent(`/s/rd-ok${path}${u.search}`)),
        );
      case "rd-login":
        if (path.startsWith("/login")) return html(readFixture("old-reddit-login.html"));
        return redirect(`${base}/login/?reason=lor2&dest=${dest}`);
      case "rd-netsec":
        if (path.startsWith("/login")) return html(readFixture("reddit-network-security.html"), 403);
        return redirect(`${base}/login/?reason=lor2&dest=${dest}`);
      case "rd-empty":
        return html("<!doctype html><title>reddit.com: search results</title><div class='content' role='main'><p>there doesn't seem to be anything here</p></div>");
      case "botwall":
        return html(readFixture("bot-wall.html"), 503);
      case "stalled":
        return html(readFixture("stalled.html"));
      case "status-500":
        return html("<title>error</title>", 500);
      default:
        res.writeHead(404, { "content-type": "text/plain" }).end("unknown scenario");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    requests,
    scenario: (name) => `${url}/s/${name}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

export const SEARCH_QUERY: SocialSearchQuery = {
  mode: "search",
  query: "claude code",
  platforms: ["x", "facebook", "reddit"],
  kind: "both",
  sort: "engagement",
  max_results: 30,
  per_platform: 15,
};

export function threadQuery(url: string, over: Partial<SocialSearchQuery> = {}): SocialSearchQuery {
  return { ...SEARCH_QUERY, mode: "thread", url, kind: "comments", ...over };
}

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

/** An LlmClient that fails the test when called: for paths that must stay deterministic. */
export function forbiddenLlm(): ScriptedLlm {
  return scriptedLlm(() => {
    throw new Error("the LLM must not be called on this path");
  });
}

export function promptOf(req: LlmRequest): string {
  const m = req.messages[0];
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
}

// ---------------------------------------------------------------------------
// Page spy: records any call that would type into or submit a page
// ---------------------------------------------------------------------------

/** Playwright methods a read-only recipe must never call, on a Page, Frame, Locator, ElementHandle or Keyboard. */
export const FORBIDDEN_PAGE_METHODS: ReadonlySet<string> = new Set([
  "fill",
  "type",
  "press",
  "pressSequentially",
  "insertText",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "setInputFiles",
  "dragAndDrop",
  "dragTo",
]);

export interface PageSpy {
  /** The proxied page to hand to the recipe. Release the ORIGINAL page with the session. */
  page: Page;
  /** Names of forbidden methods that were called (path-qualified, e.g. "locator.fill"). */
  forbidden: string[];
  /** Every method name called on the page tree, for debugging. */
  calls: string[];
}

function isWrappable(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  // Class instances (Locator, Frame, Keyboard, ...) are wrapped; plain data (probe results) is not.
  return proto !== null && proto !== Object.prototype && !Array.isArray(value) && !(value instanceof Promise);
}

/**
 * Wrap a Playwright page in a Proxy that records every method call and flags
 * the ones in FORBIDDEN_PAGE_METHODS, also on objects reached through it
 * (locators, frames, the keyboard, element handles, promise results).
 */
export function spyPage(real: Page): PageSpy {
  const forbidden: string[] = [];
  const calls: string[] = [];
  const wrapped = new WeakMap<object, object>();

  const wrap = <T extends object>(target: T, path: string): T => {
    const existing = wrapped.get(target);
    if (existing !== undefined) return existing as T;
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver) as unknown;
        if (typeof prop !== "string") return value;
        if (typeof value === "function") {
          const name = `${path}.${prop}`;
          return (...args: unknown[]): unknown => {
            calls.push(name);
            if (FORBIDDEN_PAGE_METHODS.has(prop)) forbidden.push(name);
            const result = (value as (...a: unknown[]) => unknown).apply(t, args);
            if (result instanceof Promise) return result.then((r: unknown) => wrapResult(r, prop));
            return wrapResult(result, prop);
          };
        }
        return isWrappable(value) ? wrap(value, `${path}.${prop}`) : value;
      },
    });
    wrapped.set(target, proxy);
    return proxy;
  };
  const wrapResult = (r: unknown, prop: string): unknown => {
    if (Array.isArray(r)) return r.map((x) => (isWrappable(x) ? wrap(x, prop) : x));
    return isWrappable(r) ? wrap(r, prop) : r;
  };

  return { page: wrap(real, "page"), forbidden, calls };
}
