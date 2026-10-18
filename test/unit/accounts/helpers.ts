import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright";
import { ACCOUNT_PLATFORM_TABLE, type AccountPlatformSpec, type AccountPlatformTable } from "../../../src/core/accounts/platforms.js";
import { cookieDomainMatches } from "../../../src/core/browser/session.js";
import type { BrowserCookie, BrowserSession } from "../../../src/core/browser/types.js";

/** A value that must never show up in a tool result or a log line. */
export const COOKIE_VALUE = "SECRET-cookie-value-0042-never-leaks";
/** The fixture server's host, which is also the cookie domain Chromium stores for it. */
export const FIXTURE_DOMAIN = "127.0.0.1";

export interface AccountsServer {
  url: string;
  close(): Promise<void>;
}

/**
 * A stand-in for a platform's site on 127.0.0.1:
 *   /login                 a login page that sets no cookie (the owner "has not logged in yet")
 *   /login-sets-cookie     a login page that sets reddit_session for an hour (the owner "logged in")
 *   /login-session-cookie  the same without Max-Age, so Chromium reports expires -1
 */
export async function startAccountsServer(): Promise<AccountsServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const html = (title: string): string => `<!doctype html><title>${title}</title><h1>${title}</h1><form><input name="u"><input name="p" type="password"></form>`;
    if (path === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("Log in"));
    } else if (path === "/login-sets-cookie") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `reddit_session=${COOKIE_VALUE}; Max-Age=3600; Path=/` })
        .end(html("Logged in"));
    } else if (path === "/login-session-cookie") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `reddit_session=${COOKIE_VALUE}; Path=/` })
        .end(html("Logged in (session cookie)"));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, FIXTURE_DOMAIN, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${FIXTURE_DOMAIN}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The real table with `reddit` pointed at the fixture: domain 127.0.0.1, login at `loginUrl`. */
export function fixturePlatforms(loginUrl: string, over: Partial<AccountPlatformSpec> = {}): AccountPlatformTable {
  return {
    ...ACCOUNT_PLATFORM_TABLE,
    reddit: {
      ...ACCOUNT_PLATFORM_TABLE.reddit,
      domains: [FIXTURE_DOMAIN],
      loginUrl,
      sessionCookies: { domain: FIXTURE_DOMAIN, required: [["reddit_session"]] },
      ...over,
    },
  };
}

export const FUTURE = Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000);

export function cookie(name: string, domain: string, expires: number = FUTURE): BrowserCookie {
  return { name, domain, path: "/", expires, httpOnly: true, secure: true };
}

export interface FakePageState {
  closed: boolean;
  url?: string;
}

/** The handful of `Page` members the accounts service touches. */
export function makeFakePage(opts: { gotoFails?: boolean } = {}): { page: Page; state: FakePageState } {
  const state: FakePageState = { closed: false };
  const onClose: Array<() => void> = [];
  const page = {
    isClosed: () => state.closed,
    goto: (url: string) => {
      if (opts.gotoFails === true) return Promise.reject(new Error("net::ERR_CONNECTION_REFUSED at " + url));
      state.url = url;
      return Promise.resolve(null);
    },
    once: (_event: string, handler: () => void) => {
      onClose.push(handler);
      return page;
    },
    close: () => {
      if (!state.closed) {
        state.closed = true;
        for (const h of onClose.splice(0)) h();
      }
      return Promise.resolve();
    },
  };
  return { page: page as unknown as Page, state };
}

export interface CookieFakeBrowser extends BrowserSession {
  /** The cookies `cookies()` reports; tests mutate it to simulate a login. */
  store: BrowserCookie[];
  /** Method names in call order, `clearCookies:<domain>` for clears. */
  calls: string[];
  opened: Array<{ page: Page; state: FakePageState }>;
  open: boolean;
}

/** A BrowserSession over an in-memory cookie list. `cookies()` and `openUnpooledPage()` "launch" it. */
export function cookieFakeBrowser(opts: { cookies?: BrowserCookie[]; open?: boolean; gotoFails?: boolean } = {}): CookieFakeBrowser {
  const b: CookieFakeBrowser = {
    store: [...(opts.cookies ?? [])],
    calls: [],
    opened: [],
    open: opts.open ?? false,
    acquire: () => Promise.reject(new Error("cookieFakeBrowser: acquire is not available")),
    release: (page) => (b.opened.some((o) => o.page === page) ? page.close() : Promise.resolve()),
    close: async () => {
      b.open = false;
      await Promise.all(b.opened.map((o) => o.page.close()));
    },
    isOpen: () => b.open,
    stats: () => ({ mode: null, open: b.open, closed: false, headless: true, activePages: 0, waiting: 0, maxPages: 3, totalAcquired: 0 }),
    cookies: () => {
      b.calls.push("cookies");
      b.open = true;
      return Promise.resolve(b.store.map((c) => ({ ...c })));
    },
    clearCookies: ({ domain }) => {
      b.calls.push(`clearCookies:${domain}`);
      const before = b.store.length;
      b.store = b.store.filter((c) => !cookieDomainMatches(c.domain, domain));
      return Promise.resolve(before - b.store.length);
    },
    openUnpooledPage: () => {
      b.calls.push("openUnpooledPage");
      b.open = true;
      const entry = makeFakePage({ ...(opts.gotoFails !== undefined && { gotoFails: opts.gotoFails }) });
      b.opened.push(entry);
      return Promise.resolve(entry.page);
    },
  };
  return b;
}

/** A clock and a sleep that advances it, so polling loops run instantly and `waited_s` is deterministic. */
export function fakeClock(startMs = Date.parse("2026-10-18T12:00:00Z")): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  /** Called on each sleep, before the clock advances; lets a test "log in" after N polls. */
  onSleep?: (count: number) => void;
} {
  let t = startMs;
  const clock = {
    sleeps: [] as number[],
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      clock.sleeps.push(ms);
      clock.onSleep?.(clock.sleeps.length);
      t += ms;
      return Promise.resolve();
    },
    onSleep: undefined as ((count: number) => void) | undefined,
  };
  return clock;
}
