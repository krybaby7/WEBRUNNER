import type { BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountsError, checkSession, createAccountsService, type AccountsService } from "../../../src/core/accounts/index.js";
import { ACCOUNT_PLATFORM_TABLE } from "../../../src/core/accounts/platforms.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { AccountsOutputSchema } from "../../../src/schemas/accounts.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../browser/helpers.js";
import { recordingLogger } from "../research/helpers.js";
import {
  COOKIE_VALUE,
  cookie,
  cookieFakeBrowser,
  fakeClock,
  FIXTURE_DOMAIN,
  fixturePlatforms,
  FUTURE,
  startAccountsServer,
  type AccountsServer,
  type CookieFakeBrowser,
} from "./helpers.js";

const probe = await probeChromium();

const LOGIN = "https://login.example.test/";
const NOW = Date.parse("2026-10-18T12:00:00Z");

async function failure(p: Promise<unknown>): Promise<AccountsError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AccountsError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("checkSession", () => {
  const google = ACCOUNT_PLATFORM_TABLE.google;
  const amazon = ACCOUNT_PLATFORM_TABLE.amazon;
  const reddit = ACCOUNT_PLATFORM_TABLE.reddit;

  it("needs every group (google: SID and SAPISID)", () => {
    expect(checkSession(google, [cookie("SID", ".google.com")], NOW).connected).toBe(false);
    expect(checkSession(google, [cookie("SID", ".google.com"), cookie("SAPISID", ".google.com")], NOW).connected).toBe(true);
  });

  it("accepts any name within a group (amazon: x-main or at-main)", () => {
    expect(checkSession(amazon, [cookie("x-main", ".amazon.com")], NOW).connected).toBe(true);
    expect(checkSession(amazon, [cookie("at-main", ".amazon.com")], NOW).connected).toBe(true);
    expect(checkSession(amazon, [cookie("other", ".amazon.com")], NOW).connected).toBe(false);
  });

  it("matches the cookie domain exactly, as a leading-dot parent or as a subdomain, never a lookalike", () => {
    expect(checkSession(reddit, [cookie("reddit_session", "reddit.com")], NOW).connected).toBe(true);
    expect(checkSession(reddit, [cookie("reddit_session", ".reddit.com")], NOW).connected).toBe(true);
    expect(checkSession(reddit, [cookie("reddit_session", "www.reddit.com")], NOW).connected).toBe(true);
    expect(checkSession(reddit, [cookie("reddit_session", "notreddit.com")], NOW).connected).toBe(false);
  });

  it("ignores expired cookies and treats expires -1 (session cookie) as present without an expiry", () => {
    const expired = Math.floor(NOW / 1000) - 1;
    expect(checkSession(reddit, [cookie("reddit_session", ".reddit.com", expired)], NOW).connected).toBe(false);
    expect(checkSession(reddit, [cookie("reddit_session", ".reddit.com", -1)], NOW)).toEqual({ connected: true });
  });

  it("reports the earliest finite expiry among the required cookies, or none when one is a session cookie", () => {
    const sooner = FUTURE - 86_400;
    expect(checkSession(google, [cookie("SID", ".google.com", FUTURE), cookie("SAPISID", ".google.com", sooner)], NOW)).toEqual({
      connected: true,
      expiresAt: new Date(sooner * 1000).toISOString(),
    });
    expect(checkSession(google, [cookie("SID", ".google.com", FUTURE), cookie("SAPISID", ".google.com", -1)], NOW)).toEqual({ connected: true });
  });
});

describe("accounts service with a fake browser", () => {
  function make(browser: CookieFakeBrowser, over: Partial<Parameters<typeof createAccountsService>[0]> = {}) {
    const { logger, lines } = recordingLogger();
    const clock = fakeClock(NOW);
    const service = createAccountsService({
      browser,
      config: makeConfig("/unused"),
      log: logger,
      platforms: fixturePlatforms(LOGIN),
      now: clock.now,
      sleep: clock.sleep,
      assumeDisplay: true,
      ...over,
    });
    return { service, lines, clock };
  }

  it("connectedPlatforms returns [] on a never-launched browser without launching it", async () => {
    const browser = cookieFakeBrowser({ cookies: [cookie("reddit_session", FIXTURE_DOMAIN)] });
    const { service } = make(browser);
    expect(await service.connectedPlatforms()).toEqual([]);
    expect(browser.calls).toEqual([]);
    expect(browser.isOpen()).toBe(false);
  });

  it("connectedPlatforms names the connected platforms once the browser is open", async () => {
    const browser = cookieFakeBrowser({
      open: true,
      cookies: [cookie("reddit_session", FIXTURE_DOMAIN), cookie("SID", ".google.com"), cookie("SAPISID", ".google.com"), cookie("li_at", ".linkedin.com", -1)],
    });
    const { service } = make(browser);
    expect(await service.connectedPlatforms()).toEqual(["reddit", "google", "linkedin"]);
  });

  it("list reports every platform with its connection state, domains, used_by and expiry", async () => {
    const browser = cookieFakeBrowser({ cookies: [cookie("reddit_session", FIXTURE_DOMAIN), cookie("x-main", ".amazon.com", -1)] });
    const { service } = make(browser);
    const out = await service.list();
    expect(AccountsOutputSchema.safeParse(out).success).toBe(true);
    expect(out.mode).toBe("persistent");
    expect(out.profile_dir).toBe("/unused");
    expect(out.accounts.map((a) => [a.platform, a.connected])).toEqual([
      ["reddit", true],
      ["x", false],
      ["facebook", false],
      ["instagram", false],
      ["google", false],
      ["amazon", true],
      ["linkedin", false],
    ]);
    const reddit = out.accounts.find((a) => a.platform === "reddit");
    expect(reddit).toMatchObject({ domains: [FIXTURE_DOMAIN], used_by: ["social_search (reddit)"], checked_at: new Date(NOW).toISOString() });
    expect(reddit?.expires_at).toBe(new Date(FUTURE * 1000).toISOString());
    expect(out.accounts.find((a) => a.platform === "amazon")?.expires_at).toBeUndefined();
    expect(out.caveats.join(" ")).toMatch(/never returned or logged/);
  });

  it("list in CDP mode reports mode cdp and no profile_dir", async () => {
    const { service } = make(cookieFakeBrowser(), { config: makeConfig("/unused", { cdp_url: "http://127.0.0.1:9222" }) });
    const out = await service.list();
    expect(out.mode).toBe("cdp");
    expect(out.profile_dir).toBeUndefined();
    expect(out.caveats.join(" ")).toMatch(/your own Chrome/);
  });

  it("connect in headless persistent mode fails with config and names both ways out", async () => {
    const browser = cookieFakeBrowser();
    const { service } = make(browser, { assumeDisplay: false, config: makeConfig("/unused", { headless: true }) });
    const err = await failure(service.connect("reddit", 5));
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/BROWSER_HEADLESS=false/);
    expect(err.message).toMatch(/BROWSER_CDP_URL/);
    expect(browser.calls).toEqual([]);
  });

  it("connect in CDP mode is not gated on a display and opens the login page as a tab", async () => {
    const browser = cookieFakeBrowser();
    const { service } = make(browser, { assumeDisplay: false, config: makeConfig("/unused", { headless: true, cdp_url: "http://127.0.0.1:9222" }) });
    const out = await service.connect("reddit", 0);
    expect(out.status).toBe("pending");
    expect(browser.opened).toHaveLength(1);
    expect(browser.opened[0]?.state.url).toBe(LOGIN);
    expect(out.caveats.join(" ")).toMatch(/tab in your own Chrome/);
  });

  it("connect returns already_connected without opening a page when the cookies are there", async () => {
    const browser = cookieFakeBrowser({ cookies: [cookie("reddit_session", FIXTURE_DOMAIN)] });
    const { service } = make(browser);
    const out = await service.connect("reddit", 30);
    expect(out).toMatchObject({ action: "connect", platform: "reddit", status: "already_connected", login_url: LOGIN, waited_s: 0 });
    expect(browser.opened).toHaveLength(0);
  });

  it("connect with wait_seconds 0 opens the login page, checks once and returns pending with the page left open", async () => {
    const browser = cookieFakeBrowser();
    const { service, clock } = make(browser);
    const out = await service.connect("reddit", 0);
    expect(out).toMatchObject({ status: "pending", waited_s: 0, login_url: LOGIN });
    expect(out.instructions).toMatch(/log in there yourself/i);
    expect(out.instructions).toMatch(/connect/);
    expect(clock.sleeps).toEqual([]);
    expect(browser.opened).toHaveLength(1);
    expect(browser.opened[0]?.state).toEqual({ closed: false, url: LOGIN });
  });

  it("connect polls every 2 s until the cookies appear, closes the page and reports the wait", async () => {
    const browser = cookieFakeBrowser();
    const { service, clock } = make(browser);
    clock.onSleep = (n) => {
      if (n === 3) browser.store.push(cookie("reddit_session", FIXTURE_DOMAIN));
    };
    const out = await service.connect("reddit", 120);
    expect(out).toMatchObject({ status: "connected", waited_s: 6 });
    expect(clock.sleeps).toEqual([2000, 2000, 2000]);
    expect(browser.opened[0]?.state.closed).toBe(true);
  });

  it("connect gives up at wait_seconds, never sleeping past the deadline", async () => {
    const browser = cookieFakeBrowser();
    const { service, clock } = make(browser);
    const out = await service.connect("reddit", 5);
    expect(out).toMatchObject({ status: "pending", waited_s: 5 });
    expect(clock.sleeps).toEqual([2000, 2000, 1000]);
  });

  it("a later connect reuses the pending page without navigating again, and a later list that finds the login done closes it", async () => {
    const browser = cookieFakeBrowser();
    const { service } = make(browser);
    await service.connect("reddit", 0);
    const first = browser.opened[0];
    expect(first?.state.closed).toBe(false);

    const again = await service.connect("reddit", 0);
    expect(again.status).toBe("pending");
    expect(browser.opened).toHaveLength(1);
    expect(browser.calls.filter((c) => c === "openUnpooledPage")).toHaveLength(1);

    browser.store.push(cookie("reddit_session", FIXTURE_DOMAIN));
    const listed = await service.list();
    expect(listed.accounts.find((a) => a.platform === "reddit")?.connected).toBe(true);
    expect(first?.state.closed).toBe(true);

    // list already closed the page, so nothing was pending any more: the session was simply there.
    const done = await service.connect("reddit", 0);
    expect(done.status).toBe("already_connected");
  });

  it("a connect that finds a pending login finished reports connected and closes the page", async () => {
    const browser = cookieFakeBrowser();
    const { service } = make(browser);
    await service.connect("reddit", 0);
    browser.store.push(cookie("reddit_session", FIXTURE_DOMAIN));
    const done = await service.connect("reddit", 0);
    expect(done).toMatchObject({ status: "connected", waited_s: 0 });
    expect(done.instructions).toMatch(/login page has been closed/);
    expect(browser.opened[0]?.state.closed).toBe(true);
  });

  it("closes a pending login page on its own after the TTL, with a timer that does not hold the process", async () => {
    const browser = cookieFakeBrowser();
    const { service } = make(browser, { pendingPageTtlMs: 30 });
    await service.connect("reddit", 0);
    expect(browser.opened[0]?.state.closed).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(browser.opened[0]?.state.closed).toBe(true);
  });

  it("connect reports a login page that could not be opened as a retryable provider error and closes the page", async () => {
    const browser = cookieFakeBrowser({ gotoFails: true });
    const { service } = make(browser);
    const err = await failure(service.connect("reddit", 0));
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/could not open/);
    expect(browser.opened[0]?.state.closed).toBe(true);
  });

  it("the google caveat recommends CDP attach; facebook and x mention checkpoints", async () => {
    const { service } = make(cookieFakeBrowser());
    const google = await service.connect("google", 0);
    expect(google.caveats.join(" ")).toMatch(/BROWSER_CDP_URL/);
    expect(google.caveats.join(" ")).toMatch(/may not be secure/);
    for (const p of ["facebook", "x"] as const) {
      expect((await service.connect(p, 0)).caveats.join(" ")).toMatch(/checkpoint/);
    }
    expect((await service.connect("reddit", 0)).caveats.join(" ")).not.toMatch(/checkpoint|may not be secure/);
  });

  it("disconnect clears every domain of the platform and reports the count, or not_connected", async () => {
    const browser = cookieFakeBrowser({
      cookies: [cookie("auth_token", ".x.com"), cookie("other", "twitter.com"), cookie("keep", ".notx.com")],
    });
    const { service } = make(browser);
    const out = await service.disconnect("x");
    expect(out).toMatchObject({ action: "disconnect", platform: "x", status: "disconnected", cookies_cleared: 2 });
    expect(browser.calls).toEqual(["clearCookies:x.com", "clearCookies:twitter.com"]);
    expect(browser.store.map((c) => c.name)).toEqual(["keep"]);
    expect(await service.disconnect("x")).toMatchObject({ status: "not_connected", cookies_cleared: 0 });
  });

  it("disconnect also closes a pending login page for that platform", async () => {
    const browser = cookieFakeBrowser();
    const { service } = make(browser);
    await service.connect("reddit", 0);
    await service.disconnect("reddit");
    expect(browser.opened[0]?.state.closed).toBe(true);
  });

  it("disconnect in CDP mode refuses with config and never touches cookies", async () => {
    const browser = cookieFakeBrowser({ cookies: [cookie("reddit_session", FIXTURE_DOMAIN)] });
    const { service } = make(browser, { config: makeConfig("/unused", { cdp_url: "http://127.0.0.1:9222" }) });
    const err = await failure(service.disconnect("reddit"));
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/never changes the cookies of your own Chrome/);
    expect(browser.calls).toEqual([]);
  });
});

describe.skipIf(!probe.available)(`accounts service on real Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: AccountsServer;
  const dirs: string[] = [];
  const sessions: BrowserSession[] = [];

  beforeAll(async () => {
    server = await startAccountsServer();
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    for (const d of dirs) await removeDir(d);
  }, 30_000);

  afterEach(async () => {
    while (sessions.length > 0) await sessions.pop()?.close();
  });

  async function rig(loginPath: string, over: Partial<Parameters<typeof createAccountsService>[0]> = {}) {
    const dir = await makeTempDir("webrunner-accounts-");
    dirs.push(dir);
    const session = createBrowserSession(makeConfig(dir));
    sessions.push(session);
    const { logger, lines } = recordingLogger();
    const service: AccountsService = createAccountsService({
      browser: session,
      config: makeConfig(dir),
      log: logger,
      platforms: fixturePlatforms(`${server.url}${loginPath}`),
      assumeDisplay: true,
      pollMs: 100,
      ...over,
    });
    return { session, service, lines, dir };
  }

  /** Watch the shared context for pages the service opens. */
  async function watchPages(session: BrowserSession): Promise<{ context: BrowserContext; pages: Page[] }> {
    const probePage = await session.acquire();
    const context = probePage.context();
    await session.release(probePage);
    const pages: Page[] = [];
    context.on("page", (p) => pages.push(p));
    return { context, pages };
  }

  it("list reports connected after the fixture sets the cookie, disconnect clears it, and list reports not connected", async () => {
    const { session, service, lines } = await rig("/login-sets-cookie");

    const before = await service.list();
    expect(before.mode).toBe("persistent");
    expect(before.accounts.find((a) => a.platform === "reddit")?.connected).toBe(false);

    // "The owner logs in": visit the page that sets reddit_session.
    const page = await session.acquire();
    await page.goto(`${server.url}/login-sets-cookie`);
    await session.release(page);

    const after = await service.list();
    const reddit = after.accounts.find((a) => a.platform === "reddit");
    expect(reddit?.connected).toBe(true);
    expect(Date.parse(reddit?.expires_at ?? "")).toBeGreaterThan(Date.now());
    expect(await service.connectedPlatforms()).toEqual(["reddit"]);

    const cleared = await service.disconnect("reddit");
    expect(cleared).toMatchObject({ status: "disconnected", cookies_cleared: 1 });

    const gone = await service.list();
    expect(gone.accounts.find((a) => a.platform === "reddit")?.connected).toBe(false);
    expect(await service.connectedPlatforms()).toEqual([]);
    expect(await service.disconnect("reddit")).toMatchObject({ status: "not_connected", cookies_cleared: 0 });

    // The cookie value appears nowhere: not in any result, not in any log line.
    for (const out of [before, after, cleared, gone]) expect(JSON.stringify(out)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(lines)).not.toContain(COOKIE_VALUE);
  }, 45_000);

  it("connect with wait_seconds 0 returns pending and leaves an unpooled page that close() cleans up", async () => {
    const { session, service } = await rig("/login");
    const { pages } = await watchPages(session);

    const out = await service.connect("reddit", 0);
    expect(out).toMatchObject({ status: "pending", waited_s: 0, login_url: `${server.url}/login` });
    expect(pages).toHaveLength(1);
    const loginPage = pages[0] as Page;
    expect(loginPage.isClosed()).toBe(false);
    expect(loginPage.url()).toBe(`${server.url}/login`);
    // Outside the pool: nothing leased, nothing counted.
    expect(session.stats()).toMatchObject({ activePages: 0, waiting: 0 });

    await session.close();
    expect(loginPage.isClosed()).toBe(true);
  }, 45_000);

  it("connect returns connected when the login page sets the cookie on load, and closes the page", async () => {
    const { session, service, lines } = await rig("/login-sets-cookie");
    const { pages } = await watchPages(session);

    const out = await service.connect("reddit", 10);
    expect(out).toMatchObject({ action: "connect", platform: "reddit", status: "connected" });
    expect(out.waited_s).toBeLessThanOrEqual(10);
    expect(pages).toHaveLength(1);
    expect((pages[0] as Page).isClosed()).toBe(true);
    expect(session.stats().activePages).toBe(0);

    expect(await service.connect("reddit", 0)).toMatchObject({ status: "already_connected", waited_s: 0 });
    expect(JSON.stringify(out)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(lines)).not.toContain(COOKIE_VALUE);
  }, 45_000);

  it("a pending login finished by the owner is picked up by the next connect, which closes the page", async () => {
    const { session, service } = await rig("/login");
    const { pages } = await watchPages(session);

    expect((await service.connect("reddit", 0)).status).toBe("pending");
    const loginPage = pages[0] as Page;
    // The owner completes the login in the window webrunner opened.
    await loginPage.goto(`${server.url}/login-session-cookie`);

    const done = await service.connect("reddit", 0);
    expect(done.status).toBe("connected");
    expect(loginPage.isClosed()).toBe(true);
    // A session cookie (no Max-Age) counts as present and carries no expiry.
    const listed = await service.list();
    const reddit = listed.accounts.find((a) => a.platform === "reddit");
    expect(reddit?.connected).toBe(true);
    expect(reddit?.expires_at).toBeUndefined();
    expect(session.stats().activePages).toBe(0);
  }, 45_000);
});
