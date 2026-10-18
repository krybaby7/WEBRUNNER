import type { Page } from "playwright";
import type { Config } from "../../config.js";
import type { Logger } from "../../log.js";
import type { ErrorCode } from "../../schemas/error.js";
import type { AccountPlatform, AccountStatus, AccountsOutput } from "../../schemas/accounts.js";
import { cookieDomainMatches, resolveHeadless } from "../browser/session.js";
import type { BrowserCookie, BrowserSession } from "../browser/types.js";
import { ACCOUNT_PLATFORM_TABLE, platformsInOrder, type AccountPlatformSpec, type AccountPlatformTable } from "./platforms.js";

/**
 * The `accounts` service, PLAN.md 14.7: see which platforms the browser
 * profile is logged into, open a login page for the owner to log in by hand,
 * and clear a platform's cookies. It reads cookies only through
 * `BrowserSession.cookies()`, which carries no values, so nothing in here
 * can log or return one. It never types into a page.
 */

export type AccountsListOutput = Extract<AccountsOutput, { action: "list" }>;
export type AccountsConnectOutput = Extract<AccountsOutput, { action: "connect" }>;
export type AccountsDisconnectOutput = Extract<AccountsOutput, { action: "disconnect" }>;

/** A failure the tool turns into an error envelope (3.6) with this code. */
export class AccountsError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AccountsError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AccountsServiceDeps {
  browser: BrowserSession;
  config: Config;
  log: Logger;
  /** Replaces the real platform table. Tests point a platform at a fixture domain. */
  platforms?: AccountPlatformTable;
  /** Clock in ms since the epoch. */
  now?: () => number;
  /** Replaces the real wait between cookie polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Treat the persistent browser as headful even when `resolveHeadless` says otherwise. Tests only. */
  assumeDisplay?: boolean;
  /** Interval between cookie polls during `connect`. Default 2 s. */
  pollMs?: number;
  /** How long a `pending` login page stays open before it is closed automatically. Default 10 minutes. */
  pendingPageTtlMs?: number;
}

export interface AccountsService {
  list(): Promise<AccountsListOutput>;
  connect(platform: AccountPlatform, waitSeconds: number): Promise<AccountsConnectOutput>;
  disconnect(platform: AccountPlatform): Promise<AccountsDisconnectOutput>;
  /**
   * Platforms that are connected right now. Returns `[]` without launching
   * anything when the browser is not open: `health` calls this and must never
   * start a browser.
   */
  connectedPlatforms(): Promise<AccountPlatform[]>;
}

export const CONNECT_POLL_MS = 2_000;
export const PENDING_PAGE_TTL_MS = 10 * 60_000;
/** Navigation budget for the login page itself; the login wait is separate. */
const LOGIN_GOTO_TIMEOUT_MS = 30_000;

const NEVER_VALUES = "Cookie values are never returned or logged; only cookie names are checked.";

interface PendingLogin {
  page: Page;
  timer: NodeJS.Timeout;
}

/** The outcome of checking one platform's session cookies. */
export interface SessionCheck {
  connected: boolean;
  /** ISO 8601, when every required cookie has a finite expiry; the earliest of them. */
  expiresAt?: string;
}

/**
 * Apply a platform's session-cookie rule to a cookie list. A cookie counts
 * when it sits on the rule's domain (or a subdomain), has one of the group's
 * names, and has not expired (`expires === -1` is a session cookie: present).
 */
export function checkSession(spec: AccountPlatformSpec, cookies: BrowserCookie[], nowMs: number): SessionCheck {
  const { domain, required } = spec.sessionCookies;
  const onDomain = cookies.filter((c) => cookieDomainMatches(c.domain, domain) && (c.expires === -1 || c.expires * 1000 > nowMs));
  const present: BrowserCookie[] = [];
  for (const group of required) {
    const found = onDomain.filter((c) => group.includes(c.name));
    if (found.length === 0) return { connected: false };
    present.push(...found);
  }
  if (present.some((c) => c.expires === -1)) return { connected: true };
  const earliest = Math.min(...present.map((c) => c.expires));
  return { connected: true, expiresAt: new Date(earliest * 1000).toISOString() };
}

class DefaultAccountsService implements AccountsService {
  private readonly browser: BrowserSession;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly table: AccountPlatformTable;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly assumeDisplay: boolean;
  private readonly pollMs: number;
  private readonly pendingTtlMs: number;
  /** Login pages left open by `connect` that returned `pending`, one per platform. */
  private readonly pending = new Map<AccountPlatform, PendingLogin>();

  constructor(deps: AccountsServiceDeps) {
    this.browser = deps.browser;
    this.config = deps.config;
    this.log = deps.log;
    this.table = deps.platforms ?? ACCOUNT_PLATFORM_TABLE;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.assumeDisplay = deps.assumeDisplay ?? false;
    this.pollMs = deps.pollMs ?? CONNECT_POLL_MS;
    this.pendingTtlMs = deps.pendingPageTtlMs ?? PENDING_PAGE_TTL_MS;
  }

  private get mode(): "persistent" | "cdp" {
    return this.config.browser.cdp_url !== undefined ? "cdp" : "persistent";
  }

  async list(): Promise<AccountsListOutput> {
    const cookies = await this.browser.cookies();
    const nowMs = this.now();
    const checkedAt = new Date(nowMs).toISOString();
    const closing: Promise<void>[] = [];
    const accounts: AccountStatus[] = platformsInOrder(this.table).map((spec) => {
      const check = checkSession(spec, cookies, nowMs);
      if (check.connected) closing.push(this.forgetPending(spec.platform, "login finished"));
      return {
        platform: spec.platform,
        connected: check.connected,
        domains: [...spec.domains],
        used_by: [...spec.usedBy],
        checked_at: checkedAt,
        ...(check.expiresAt !== undefined && { expires_at: check.expiresAt }),
      };
    });
    await Promise.all(closing);
    const caveats = [NEVER_VALUES];
    if (this.mode === "cdp") {
      caveats.push("BROWSER_CDP_URL is set: these are the logins of your own Chrome. Log in or out there; disconnect is refused in this mode.");
    } else {
      caveats.push("These are the logins of webrunner's own browser profile, not of your everyday browser. Use connect to log in there.");
    }
    if (this.pending.size > 0) {
      caveats.push(`A login page is still open for: ${[...this.pending.keys()].join(", ")}. Finish logging in there, then call connect again.`);
    }
    return {
      action: "list",
      mode: this.mode,
      ...(this.mode === "persistent" && { profile_dir: this.config.browser.profile_dir }),
      accounts,
      caveats,
    };
  }

  async connectedPlatforms(): Promise<AccountPlatform[]> {
    if (!this.browser.isOpen()) return [];
    const cookies = await this.browser.cookies();
    const nowMs = this.now();
    return platformsInOrder(this.table)
      .filter((spec) => checkSession(spec, cookies, nowMs).connected)
      .map((spec) => spec.platform);
  }

  async connect(platform: AccountPlatform, waitSeconds: number): Promise<AccountsConnectOutput> {
    const spec = this.table[platform];
    if (this.mode === "persistent" && !this.assumeDisplay && resolveHeadless(this.config)) {
      throw new AccountsError(
        "config",
        `connect needs a browser window you can see, and the persistent browser is headless here. Two ways out: run webrunner where a display exists with BROWSER_HEADLESS=false, or set BROWSER_CDP_URL (for example http://127.0.0.1:9222) to attach to your own Chrome started with --remote-debugging-port=9222 and log in there.`,
      );
    }
    const caveats = this.connectCaveats(platform);

    if (checkSession(spec, await this.browser.cookies(), this.now()).connected) {
      // A login finished in the page a previous `pending` connect left open completes that flow: `connected`.
      // With no such page the session was simply there already.
      const finishedPending = this.pending.has(platform);
      await this.forgetPending(platform, finishedPending ? "login finished" : "already connected");
      if (finishedPending) this.log.info("account connected", { platform, waited_s: 0 });
      return {
        action: "connect",
        platform,
        status: finishedPending ? "connected" : "already_connected",
        login_url: spec.loginUrl,
        waited_s: 0,
        instructions: finishedPending
          ? `${platform} is connected; the login page has been closed. Tools that read through it: ${usedByText(spec)}.`
          : `${platform} is already connected: its session cookies are present. Use disconnect first if you want to log in as someone else.`,
        caveats,
      };
    }

    const started = this.now();
    const page = await this.loginPage(platform, spec.loginUrl);
    const deadline = started + Math.max(0, waitSeconds) * 1000;
    // Poll until the session cookies appear. The owner types; we only read cookie names.
    for (;;) {
      if (page.isClosed()) break;
      if (checkSession(spec, await this.browser.cookies(), this.now()).connected) {
        await this.forgetPending(platform, "login finished");
        await this.browser.release(page);
        const waited = this.waited(started);
        this.log.info("account connected", { platform, waited_s: waited });
        return {
          action: "connect",
          platform,
          status: "connected",
          login_url: spec.loginUrl,
          waited_s: waited,
          instructions: `${platform} is connected. Tools that read through it: ${usedByText(spec)}.`,
          caveats,
        };
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.pollMs, remaining));
    }

    const waited = this.waited(started);
    if (page.isClosed()) {
      await this.forgetPending(platform, "page closed");
      return {
        action: "connect",
        platform,
        status: "pending",
        login_url: spec.loginUrl,
        waited_s: waited,
        instructions: `The login page for ${platform} was closed before the login finished. Call connect again to open it once more, log in there, then call connect again to confirm.`,
        caveats,
      };
    }
    this.rememberPending(platform, page);
    return {
      action: "connect",
      platform,
      status: "pending",
      login_url: spec.loginUrl,
      waited_s: waited,
      instructions:
        `The login page for ${platform} is open in the ${this.mode === "cdp" ? "Chrome you attached" : "webrunner browser window"} and stays open for ${Math.round(this.pendingTtlMs / 60_000)} minutes. ` +
        `Log in there yourself (webrunner never types credentials), then call accounts with action "connect" and platform "${platform}" again; it answers connected as soon as the session cookies are present.`,
      caveats,
    };
  }

  async disconnect(platform: AccountPlatform): Promise<AccountsDisconnectOutput> {
    if (this.mode === "cdp") {
      throw new AccountsError(
        "config",
        "webrunner never changes the cookies of your own Chrome (BROWSER_CDP_URL is set); log out of the platform in Chrome instead.",
      );
    }
    const spec = this.table[platform];
    await this.forgetPending(platform, "disconnect");
    let cleared = 0;
    for (const domain of spec.domains) cleared += await this.browser.clearCookies({ domain });
    this.log.info("account cookies cleared", { platform, cookies_cleared: cleared });
    return {
      action: "disconnect",
      platform,
      status: cleared > 0 ? "disconnected" : "not_connected",
      cookies_cleared: cleared,
      caveats: [
        cleared > 0
          ? `All cookies for ${spec.domains.join(", ")} were removed from the webrunner browser profile; the platform's own servers still hold the session until it expires.`
          : `No cookies for ${spec.domains.join(", ")} were present in the webrunner browser profile.`,
        NEVER_VALUES,
      ],
    };
  }

  // -- helpers --------------------------------------------------------------

  private waited(startedMs: number): number {
    return Math.max(0, Math.round((this.now() - startedMs) / 1000));
  }

  private connectCaveats(platform: AccountPlatform): string[] {
    const out = ["webrunner never types into the login page; you log in yourself in the window it opens.", NEVER_VALUES];
    if (platform === "google") {
      out.push(
        'Google often refuses to log in inside an automated Chromium ("This browser or app may not be secure"). If that happens, set BROWSER_CDP_URL to your own Chrome (started with --remote-debugging-port=9222) and use the Google session you already have there.',
      );
    }
    if (platform === "facebook" || platform === "x") {
      out.push(`${platform} may show a verification checkpoint on a new browser; completing it in the window is fine, it is your own session.`);
    }
    if (this.mode === "cdp") {
      out.push("BROWSER_CDP_URL is set: the login page opens as a tab in your own Chrome, and that Chrome's cookies are what the tools use.");
    }
    return out;
  }

  /** Reuse the login page a previous `pending` left open, or open a fresh unpooled page on the login URL. */
  private async loginPage(platform: AccountPlatform, loginUrl: string): Promise<Page> {
    const existing = this.pending.get(platform);
    if (existing !== undefined && !existing.page.isClosed()) {
      // Do not navigate: the owner may be halfway through a login flow on it.
      clearTimeout(existing.timer);
      this.pending.delete(platform);
      return existing.page;
    }
    const page = await this.browser.openUnpooledPage();
    try {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: LOGIN_GOTO_TIMEOUT_MS });
    } catch (err) {
      await this.browser.release(page);
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new AccountsError("provider", `could not open the ${platform} login page ${loginUrl}: ${message}`, true);
    }
    return page;
  }

  private rememberPending(platform: AccountPlatform, page: Page): void {
    const timer = setTimeout(() => {
      this.pending.delete(platform);
      this.log.info("closing login page left open", { platform, after_ms: this.pendingTtlMs });
      void this.browser.release(page);
    }, this.pendingTtlMs);
    // Never keep the server alive for a login window nobody is using.
    timer.unref();
    page.once("close", () => {
      if (this.pending.get(platform)?.page === page) {
        clearTimeout(timer);
        this.pending.delete(platform);
      }
    });
    this.pending.set(platform, { page, timer });
  }

  /** Close and forget the pending login page for `platform`, if any. */
  private async forgetPending(platform: AccountPlatform, reason: string): Promise<void> {
    const entry = this.pending.get(platform);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(platform);
    this.log.debug("closing pending login page", { platform, reason });
    await this.browser.release(entry.page);
  }
}

function usedByText(spec: AccountPlatformSpec): string {
  return spec.usedBy.length > 0 ? spec.usedBy.join(", ") : "none yet";
}

export function createAccountsService(deps: AccountsServiceDeps): AccountsService {
  return new DefaultAccountsService(deps);
}
