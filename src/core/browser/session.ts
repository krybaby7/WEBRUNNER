import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Config } from "../../config.js";
import { log } from "../../log.js";
import type { BrowserCookie, BrowserSession, BrowserSessionOptions, BrowserSessionStats } from "./types.js";

export type { BrowserCookie, BrowserSession, BrowserSessionOptions, BrowserSessionStats } from "./types.js";

/** PLAN.md 4.3: one context, pages pooled, at most 3 concurrent pages. */
export const MAX_CONCURRENT_PAGES = 3;

const VIEWPORT = { width: 1366, height: 768 } as const;

/**
 * Headful when a display exists, headless otherwise, overridden by
 * `config.browser.headless` (BROWSER_HEADLESS). macOS and Windows always
 * have a display; on Linux it is detected from DISPLAY or WAYLAND_DISPLAY.
 */
export function resolveHeadless(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (config.browser.headless !== undefined) return config.browser.headless;
  if (platform !== "linux") return false;
  const hasDisplay = [env["DISPLAY"], env["WAYLAND_DISPLAY"]].some((v) => v !== undefined && v.trim() !== "");
  return !hasDisplay;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

class PlaywrightBrowserSession implements BrowserSession {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private mode: "persistent" | "cdp" | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private launchedAt: string | undefined;

  /** Pages handed out to callers. */
  private readonly leased = new Set<Page>();
  /** Long-lived interactive pages (login windows), outside the pool. */
  private readonly unpooled = new Set<Page>();
  /** Slots reserved for callers whose page is still being created. */
  private creating = 0;
  private readonly waiters: Waiter[] = [];
  private totalAcquired = 0;

  private readonly headless: boolean;

  constructor(
    private readonly config: Config,
    private readonly opts: BrowserSessionOptions,
  ) {
    this.headless = resolveHeadless(config);
  }

  isOpen(): boolean {
    return !this.closed && this.context !== null;
  }

  stats(): BrowserSessionStats {
    return {
      mode: this.mode,
      open: this.isOpen(),
      closed: this.closed,
      headless: this.mode === "cdp" ? false : this.headless,
      activePages: this.leased.size + this.creating,
      waiting: this.waiters.length,
      maxPages: MAX_CONCURRENT_PAGES,
      totalAcquired: this.totalAcquired,
      ...(this.launchedAt !== undefined && { launchedAt: this.launchedAt }),
    };
  }

  async acquire(): Promise<Page> {
    if (this.closed) throw new Error("browser session is closed");
    await this.takeSlot();
    try {
      const ctx = await this.ensureContext();
      const page = await ctx.newPage();
      if (this.closed) {
        await page.close().catch(() => undefined);
        throw new Error("browser session is closed");
      }
      this.creating--;
      this.leased.add(page);
      this.totalAcquired++;
      return page;
    } catch (err) {
      this.creating--;
      this.passSlot();
      throw err;
    }
  }

  async release(page: Page): Promise<void> {
    // An unpooled page holds no slot: closing it is all there is to do.
    if (this.unpooled.delete(page)) {
      await page.close().catch(() => undefined);
      return;
    }
    // A page we did not hand out, or one already released or swept up by
    // close(), is a no-op. Release must never throw.
    if (!this.leased.delete(page)) return;
    try {
      await page.close();
    } catch {
      // Already closed (browser gone, tab crashed): nothing left to free.
    }
    this.passSlot();
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  // -- cookies and unpooled pages (PLAN.md 14.8) ---------------------------

  async cookies(urls?: string[]): Promise<BrowserCookie[]> {
    if (this.closed) throw new Error("browser session is closed");
    const ctx = await this.ensureContext();
    const raw = urls === undefined ? await ctx.cookies() : await ctx.cookies(urls);
    // Drop `value` (and everything else Playwright adds) so no caller can ever
    // see, return or log a cookie value: the profile is the owner's secret.
    return raw.map(({ name, domain, path, expires, httpOnly, secure }) => ({ name, domain, path, expires, httpOnly, secure }));
  }

  async clearCookies(filter: { domain: string }): Promise<number> {
    if (this.closed) throw new Error("browser session is closed");
    // Refuse before attaching: there is no reason to connect to Chrome just to say no.
    if (this.config.browser.cdp_url !== undefined || this.mode === "cdp") {
      throw new Error("webrunner never changes the cookies of your own Chrome (BROWSER_CDP_URL is set); log out there instead");
    }
    const ctx = await this.ensureContext();
    const matches = (c: { domain: string }): boolean => cookieDomainMatches(c.domain, filter.domain);
    const before = (await ctx.cookies()).filter(matches).length;
    if (before === 0) return 0;
    await ctx.clearCookies({ domain: cookieDomainPattern(filter.domain) });
    // Count by diffing rather than trusting the filter: what matters is what is really gone.
    const after = (await ctx.cookies()).filter(matches).length;
    return Math.max(0, before - after);
  }

  async openUnpooledPage(): Promise<Page> {
    if (this.closed) throw new Error("browser session is closed");
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    if (this.closed) {
      await page.close().catch(() => undefined);
      throw new Error("browser session is closed");
    }
    this.unpooled.add(page);
    // The owner may close the window by hand; forget it then so close() does not wait on a dead page.
    page.once("close", () => this.unpooled.delete(page));
    return page;
  }

  // -- pool ---------------------------------------------------------------

  private async takeSlot(): Promise<void> {
    if (this.waiters.length === 0 && this.leased.size + this.creating < MAX_CONCURRENT_PAGES) {
      this.creating++;
      return;
    }
    // The releasing side reserves the slot (creating++) before resolving, so a
    // newcomer can never jump the queue between the release and our wake-up.
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private passSlot(): void {
    const next = this.waiters.shift();
    if (next === undefined) return;
    this.creating++;
    next.resolve();
  }

  // -- lifecycle ----------------------------------------------------------

  private ensureContext(): Promise<BrowserContext> {
    if (this.context !== null) return Promise.resolve(this.context);
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    const cdpUrl = this.config.browser.cdp_url;
    const ctx = cdpUrl !== undefined ? await this.attach(cdpUrl) : await this.launchPersistent();
    if (this.closed) {
      await this.shutdown(ctx).catch(() => undefined);
      throw new Error("browser session is closed");
    }
    this.context = ctx;
    this.launchedAt = new Date().toISOString();
    // If the browser dies or the owner closes Chrome, the next acquire() launches or attaches again.
    ctx.on("close", () => {
      if (this.context === ctx) {
        this.context = null;
        this.browser = null;
        if (!this.closed) log.warn("browser context closed unexpectedly; it will be relaunched on next use");
      }
    });
    return ctx;
  }

  private async launchPersistent(): Promise<BrowserContext> {
    const profileDir = this.config.browser.profile_dir;
    await mkdir(profileDir, { recursive: true });
    const intl = Intl.DateTimeFormat().resolvedOptions();
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: this.headless,
        viewport: { ...VIEWPORT },
        locale: intl.locale,
        timezoneId: intl.timeZone,
        ...(this.opts.executablePath !== undefined && { executablePath: this.opts.executablePath }),
      });
      this.mode = "persistent";
      log.info("browser launched", { mode: "persistent", headless: this.headless, profile_dir: profileDir });
      return ctx;
    } catch (err) {
      throw new Error(
        `failed to launch Chromium with profile ${profileDir}: ${errorMessage(err)}. ` +
          "If another instance is using this profile, close it or set WEBRUNNER_BROWSER_PROFILE_DIR.",
        { cause: err },
      );
    }
  }

  private async attach(cdpUrl: string): Promise<BrowserContext> {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (err) {
      throw new Error(`failed to attach to Chrome at ${cdpUrl}: ${errorMessage(err)}`, { cause: err });
    }
    const ctx = browser.contexts()[0];
    if (ctx === undefined) {
      await browser.close().catch(() => undefined);
      throw new Error(`Chrome at ${cdpUrl} exposes no default browser context`);
    }
    this.browser = browser;
    this.mode = "cdp";
    log.info("browser attached", { mode: "cdp", cdp_url: cdpUrl });
    return ctx;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(new Error("browser session is closed"));

    // Let an in-flight launch finish so it can be torn down cleanly.
    if (this.launching !== null) await this.launching.catch(() => undefined);

    const pages = [...this.leased, ...this.unpooled];
    this.leased.clear();
    this.unpooled.clear();
    await Promise.all(pages.map((p) => p.close().catch(() => undefined)));

    const ctx = this.context;
    const wasMode = this.mode;
    this.context = null;
    if (ctx !== null) await this.shutdown(ctx).catch((err: unknown) => {
      log.warn("error while closing browser", { error: errorMessage(err) });
    });
    this.browser = null;
    log.info("browser session closed", { mode: wasMode });
  }

  /** Persistent: close the context (and with it Chromium). CDP: disconnect, leaving the owner's Chrome running. */
  private async shutdown(ctx: BrowserContext): Promise<void> {
    if (this.mode === "cdp" && this.browser !== null) {
      await this.browser.close();
    } else {
      await ctx.close();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `.reddit.com` and `reddit.com` are the same site for our purposes; cookie domains store the dot, filters usually do not. */
function stripLeadingDots(domain: string): string {
  return domain.replace(/^\.+/, "").toLowerCase();
}

/**
 * True when a stored cookie domain belongs to `filter`: the same host, or a
 * subdomain of it. Leading dots are ignored on both sides, so a filter of
 * `reddit.com` (or `.reddit.com`) matches cookies on `.reddit.com`,
 * `reddit.com` and `www.reddit.com`, and never `notreddit.com`.
 */
export function cookieDomainMatches(cookieDomain: string, filter: string): boolean {
  const host = stripLeadingDots(cookieDomain);
  const want = stripLeadingDots(filter);
  return want !== "" && (host === want || host.endsWith(`.${want}`));
}

/** The same rule as `cookieDomainMatches`, as the RegExp Playwright's `clearCookies({ domain })` accepts. */
export function cookieDomainPattern(filter: string): RegExp {
  const escaped = stripLeadingDots(filter).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:.*\\.)?${escaped}$`, "i");
}

/**
 * Create a lazy browser session. Nothing is launched until the first `acquire()`.
 * Default: a persistent Chromium context in `config.browser.profile_dir`.
 * With `config.browser.cdp_url`: attach to the owner's Chrome over CDP.
 */
export function createBrowserSession(config: Config, opts: BrowserSessionOptions = {}): BrowserSession {
  return new PlaywrightBrowserSession(config, opts);
}
