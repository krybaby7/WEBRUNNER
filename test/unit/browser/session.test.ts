import { createServer } from "node:net";
import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_PAGES,
  cookieDomainMatches,
  cookieDomainPattern,
  createBrowserSession,
  resolveHeadless,
} from "../../../src/core/browser/session.js";
import { makeConfig, makeTempDir, probeChromium, removeDir, startFixtureServer, type FixtureServer } from "./helpers.js";

const probe = await probeChromium();

/** Resolves to "pending" if the promise has not settled after a short tick. */
async function settled(p: Promise<unknown>): Promise<"pending" | "settled"> {
  return Promise.race([p.then(() => "settled" as const, () => "settled" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), 150))]);
}

describe("resolveHeadless (no browser needed)", () => {
  const base = makeConfig("/unused");
  const unset = { ...base, browser: { profile_dir: "/unused" } };

  it("honors the config override in both directions", () => {
    expect(resolveHeadless({ ...base, browser: { profile_dir: "/x", headless: true } }, { DISPLAY: ":0" }, "linux")).toBe(true);
    expect(resolveHeadless({ ...base, browser: { profile_dir: "/x", headless: false } }, {}, "linux")).toBe(false);
  });

  it("is headful on Linux only when DISPLAY or WAYLAND_DISPLAY is set", () => {
    expect(resolveHeadless(unset, {}, "linux")).toBe(true);
    expect(resolveHeadless(unset, { DISPLAY: "" }, "linux")).toBe(true);
    expect(resolveHeadless(unset, { DISPLAY: ":0" }, "linux")).toBe(false);
    expect(resolveHeadless(unset, { WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
  });

  it("is headful on macOS and Windows", () => {
    expect(resolveHeadless(unset, {}, "darwin")).toBe(false);
    expect(resolveHeadless(unset, {}, "win32")).toBe(false);
  });
});

describe("cookie domain matching (no browser needed)", () => {
  it("matches the same host, a leading-dot parent and subdomains, ignoring case and dots on either side", () => {
    for (const filter of ["reddit.com", ".reddit.com", "Reddit.COM"]) {
      expect(cookieDomainMatches("reddit.com", filter)).toBe(true);
      expect(cookieDomainMatches(".reddit.com", filter)).toBe(true);
      expect(cookieDomainMatches("www.reddit.com", filter)).toBe(true);
      expect(cookieDomainMatches(".old.reddit.com", filter)).toBe(true);
      expect(cookieDomainMatches("notreddit.com", filter)).toBe(false);
      expect(cookieDomainMatches("reddit.com.evil.test", filter)).toBe(false);
    }
    expect(cookieDomainMatches("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(cookieDomainMatches("anything", "")).toBe(false);
  });

  it("builds the equivalent RegExp for Playwright, with metacharacters escaped", () => {
    const re = cookieDomainPattern("reddit.com");
    expect(re.test("reddit.com")).toBe(true);
    expect(re.test(".reddit.com")).toBe(true);
    expect(re.test("www.reddit.com")).toBe(true);
    expect(re.test("notreddit.com")).toBe(false);
    expect(re.test("redditXcom")).toBe(false);
    expect(cookieDomainPattern("127.0.0.1").test("127.0.0.1")).toBe(true);
    expect(cookieDomainPattern("127.0.0.1").test("127a0b0c1")).toBe(false);
  });
});

describe.skipIf(!probe.available)(`BrowserSession${probe.available ? "" : ` (${probe.reason})`}`, () => {
  const dirs: string[] = [];
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer();
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    for (const d of dirs) await removeDir(d);
  }, 30_000);

  async function newSession(opts: { dir?: string } = {}) {
    const dir = opts.dir ?? (await makeTempDir());
    if (opts.dir === undefined) dirs.push(dir);
    return { dir, session: createBrowserSession(makeConfig(dir)) };
  }

  it("launches lazily on first acquire, creating a missing profile directory", async () => {
    const parent = await makeTempDir();
    dirs.push(parent);
    const dir = `${parent}/does/not/exist/yet`;
    const { session } = await newSession({ dir });
    try {
      expect(session.isOpen()).toBe(false);
      expect(session.stats()).toMatchObject({ mode: null, open: false, closed: false, activePages: 0, maxPages: 3, totalAcquired: 0 });

      const page = await session.acquire();
      expect(session.isOpen()).toBe(true);
      expect(session.stats()).toMatchObject({ mode: "persistent", open: true, headless: true, activePages: 1, totalAcquired: 1 });
      expect(session.stats().launchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      await page.goto(`${server.url}/article.html`);
      expect(await page.title()).toContain("Tides");
      await session.release(page);
      expect(session.stats().activePages).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("gives each caller a fresh page sharing one context", async () => {
    const { session } = await newSession();
    try {
      const a = await session.acquire();
      const b = await session.acquire();
      expect(a).not.toBe(b);
      expect(a.context()).toBe(b.context());
      await session.release(a);
      await session.release(b);
    } finally {
      await session.close();
    }
  });

  it("enforces the 3-page maximum and serves waiters in FIFO order", async () => {
    expect(MAX_CONCURRENT_PAGES).toBe(3);
    const { session } = await newSession();
    try {
      const held = await Promise.all([session.acquire(), session.acquire(), session.acquire()]);
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 0 });

      const order: string[] = [];
      const track = (label: string): Promise<Page> =>
        session.acquire().then((p) => {
          order.push(label);
          return p;
        });
      const w4 = track("w4");
      const w5 = track("w5");
      const w6 = track("w6");

      expect(await settled(w4)).toBe("pending");
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 3 });
      expect(order).toEqual([]);

      await session.release(held[0] as Page);
      const p4 = await w4;
      expect(order).toEqual(["w4"]);
      expect(await settled(w5)).toBe("pending");
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 2 });

      await session.release(held[1] as Page);
      const p5 = await w5;
      expect(order).toEqual(["w4", "w5"]);
      expect(await settled(w6)).toBe("pending");

      await session.release(held[2] as Page);
      const p6 = await w6;
      expect(order).toEqual(["w4", "w5", "w6"]);
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 0, totalAcquired: 6 });

      // Concurrency never exceeded the cap and the pages really are distinct and alive.
      expect(new Set([p4, p5, p6]).size).toBe(3);
      expect(held.every((p) => p.isClosed())).toBe(true);
      expect(p4.isClosed()).toBe(false);

      for (const p of [p4, p5, p6]) await session.release(p);
      expect(session.stats().activePages).toBe(0);
    } finally {
      await session.close();
    }
  }, 40_000);

  it("rejects waiters when the session is closed, and refuses new acquires", async () => {
    const { session } = await newSession();
    await Promise.all([session.acquire(), session.acquire(), session.acquire()]);
    const waiter = session.acquire();
    const rejection = expect(waiter).rejects.toThrow(/closed/);
    await session.close();
    await rejection;
    await expect(session.acquire()).rejects.toThrow(/closed/);
    expect(session.isOpen()).toBe(false);
  });

  it("close is idempotent and release after close does not throw", async () => {
    const { session } = await newSession();
    const page = await session.acquire();
    await session.close();
    await session.close();
    expect(session.isOpen()).toBe(false);
    expect(session.stats()).toMatchObject({ closed: true, open: false, activePages: 0 });
    await expect(session.release(page)).resolves.toBeUndefined();
    await expect(session.release(page)).resolves.toBeUndefined();
  });

  it("close before any acquire is a clean no-op", async () => {
    const { session } = await newSession();
    await session.close();
    await session.close();
    expect(session.stats()).toMatchObject({ closed: true, mode: null });
  });

  it("release of a page it never handed out is ignored", async () => {
    const a = await newSession();
    const b = await newSession();
    try {
      const foreign = await b.session.acquire();
      const mine = await a.session.acquire();
      await a.session.release(foreign);
      expect(foreign.isClosed()).toBe(false);
      expect(a.session.stats().activePages).toBe(1);
      await a.session.release(mine);
      await b.session.release(foreign);
    } finally {
      await a.session.close();
      await b.session.close();
    }
  });

  it("attaches to an already running Chrome over CDP and leaves it running on close", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probeServer = createServer();
      probeServer.once("error", reject);
      probeServer.listen(0, "127.0.0.1", () => {
        const { port: p } = probeServer.address() as { port: number };
        probeServer.close(() => resolve(p));
      });
    });
    const profile = await makeTempDir("webrunner-cdp-owner-");
    dirs.push(profile);
    // The "owner's Chrome": a browser we start ourselves with a debugging port.
    const owner = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    const sessionProfile = await makeTempDir();
    dirs.push(sessionProfile);
    const session = createBrowserSession(makeConfig(sessionProfile, { cdp_url: `http://127.0.0.1:${port}` }));
    try {
      const page = await session.acquire();
      expect(session.stats().mode).toBe("cdp");
      await page.goto(`${server.url}/article.html`);
      expect(await page.title()).toContain("Tides");
      expect(owner.pages().some((p) => p.url().endsWith("/article.html"))).toBe(true);
      // Cookies can be read through the attached Chrome, but never changed (PLAN.md 14.7).
      await page.goto(`${server.url}/set-cookie`);
      await session.release(page);
      expect((await session.cookies()).map((c) => c.name)).toContain("wr_test");
      await expect(session.clearCookies({ domain: "127.0.0.1" })).rejects.toThrow(/never changes the cookies of your own Chrome/);
      expect((await owner.cookies(server.url)).map((c) => c.name)).toContain("wr_test");
      await session.close();
      // Attached sessions disconnect; they never kill the owner's browser.
      expect(owner.browser()?.isConnected()).toBe(true);
      const check = await owner.newPage();
      await check.goto(`${server.url}/article.html`);
      await check.close();
    } finally {
      await session.close();
      await owner.close();
    }
  }, 45_000);

  it("reuses the profile directory across two launches: a cookie persists", async () => {
    const dir = await makeTempDir("webrunner-profile-");
    dirs.push(dir);

    const first = createBrowserSession(makeConfig(dir));
    try {
      const page = await first.acquire();
      await page.goto(`${server.url}/set-cookie`);
      const cookies = await page.context().cookies(server.url);
      expect(cookies.map((c) => c.name)).toContain("wr_test");
      await first.release(page);
    } finally {
      await first.close();
    }

    const second = createBrowserSession(makeConfig(dir));
    try {
      const page = await second.acquire();
      // A page on the same origin that does not set the cookie itself.
      await page.goto(`${server.url}/article.html`);
      const cookie = (await page.context().cookies(server.url)).find((c) => c.name === "wr_test");
      expect(cookie?.value).toBe("persisted-value");
      await second.release(page);
    } finally {
      await second.close();
    }
  }, 45_000);

  it("cookies() launches lazily and reports cookies without a value field", async () => {
    const { session } = await newSession();
    try {
      expect(session.isOpen()).toBe(false);
      expect(await session.cookies()).toEqual([]);
      expect(session.isOpen()).toBe(true);

      const page = await session.acquire();
      await page.goto(`${server.url}/set-cookie`);
      await session.release(page);

      const all = await session.cookies();
      const wr = all.find((c) => c.name === "wr_test");
      expect(wr).toMatchObject({ name: "wr_test", domain: "127.0.0.1", path: "/", httpOnly: false });
      expect(wr?.expires).toBeGreaterThan(Date.now() / 1000);
      for (const c of all) {
        expect(Object.keys(c).sort()).toEqual(["domain", "expires", "httpOnly", "name", "path", "secure"]);
        expect("value" in c).toBe(false);
      }
      expect(JSON.stringify(all)).not.toContain("persisted-value");

      // The URL filter keeps cookies that would be sent to that URL only.
      expect((await session.cookies([server.url])).map((c) => c.name)).toContain("wr_test");
      expect(await session.cookies(["https://elsewhere.example/"])).toEqual([]);
      // Pool accounting is untouched by cookie reads.
      expect(session.stats()).toMatchObject({ activePages: 0, totalAcquired: 1 });
    } finally {
      await session.close();
    }
  });

  it("clearCookies removes the domain, its leading-dot form and subdomains, counts them, and leaves lookalikes", async () => {
    const { session } = await newSession();
    try {
      const page = await session.acquire();
      const ctx = page.context();
      const base = { value: "v", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: false, secure: false, sameSite: "Lax" as const };
      await ctx.addCookies([
        { ...base, name: "a", domain: ".example.test" },
        { ...base, name: "b", domain: "www.example.test" },
        { ...base, name: "c", domain: "example.test" },
        { ...base, name: "d", domain: "notexample.test" },
        { ...base, name: "e", domain: ".example.test.evil.test" },
      ]);
      await session.release(page);
      expect(await session.cookies()).toHaveLength(5);

      expect(await session.clearCookies({ domain: "example.test" })).toBe(3);
      expect((await session.cookies()).map((c) => c.name).sort()).toEqual(["d", "e"]);
      expect(await session.clearCookies({ domain: "example.test" })).toBe(0);
      expect(await session.clearCookies({ domain: ".notexample.test" })).toBe(1);
      expect((await session.cookies()).map((c) => c.name)).toEqual(["e"]);
    } finally {
      await session.close();
    }
  });

  it("openUnpooledPage is outside the pool: not counted, available while the pool is full, closed by release or close", async () => {
    const { session } = await newSession();
    try {
      const held = await Promise.all([session.acquire(), session.acquire(), session.acquire()]);
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 0 });

      // A full pool does not block it.
      const login = await session.openUnpooledPage();
      expect(login.isClosed()).toBe(false);
      expect(login.context()).toBe((held[0] as Page).context());
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 0, totalAcquired: 3 });
      await login.goto(`${server.url}/article.html`);
      expect(await login.title()).toContain("Tides");

      // release() closes it and frees no slot: a waiter still waits.
      const waiter = session.acquire();
      await session.release(login);
      expect(login.isClosed()).toBe(true);
      expect(await settled(waiter)).toBe("pending");
      expect(session.stats()).toMatchObject({ activePages: 3, waiting: 1 });
      await session.release(held[0] as Page);
      await session.release(await waiter);
      for (const p of held.slice(1)) await session.release(p);

      // close() closes a still-open unpooled page.
      const other = await session.openUnpooledPage();
      const closedEvent = new Promise<void>((resolve) => other.once("close", () => resolve()));
      await session.close();
      await closedEvent;
      expect(other.isClosed()).toBe(true);
      await expect(session.openUnpooledPage()).rejects.toThrow(/closed/);
      await expect(session.cookies()).rejects.toThrow(/closed/);
    } finally {
      await session.close();
    }
  }, 40_000);
});
