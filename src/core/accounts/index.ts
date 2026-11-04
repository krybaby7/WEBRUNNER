import type { Config } from "../../config.js";
import type { Logger } from "../../log.js";
import type { ErrorCode } from "../../schemas/error.js";
import type { AccountPlatform, AccountStatus, AccountsOutput } from "../../schemas/accounts.js";
import { createHandoffStore } from "../browser/handoff.js";
import { cookieDomainMatches } from "../browser/session.js";
import type { BrowserCookie, BrowserSession, HandoffStore } from "../browser/types.js";
import { ACCOUNT_PLATFORM_TABLE, platformsInOrder, type AccountPlatformSpec, type AccountPlatformTable } from "./platforms.js";

/**
 * The `accounts` service, PLAN.md 14.7 and 16.5: see which platforms the
 * browser profile is logged into, open a login page for the owner to log in
 * by hand, and clear a platform's cookies. It reads cookies only through
 * `BrowserSession.cookies()`, which carries no values, so nothing in here
 * can log or return one. It never types into a page.
 *
 * Since section 16 a login window is a handoff: the page is parked in the
 * `HandoffStore` with the platform's session cookies as its "cleared" check,
 * so `resume` works on it, `health` lists it, and the store's TTL closes it.
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
  /** The server's handoff store (PLAN.md 16.3). Without one the service keeps a store of its own. */
  handoffs?: HandoffStore;
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
  /** How long a `pending` login page stays open before it is closed automatically. Default: the handoff TTL (10 minutes). */
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
  private readonly store: HandoffStore;
  private readonly table: AccountPlatformTable;
  private readonly now: () => number;
  private readonly assumeDisplay: boolean;
  private readonly ttlMs: number;
  /** The handoff id of the login page left open by a `pending` connect, one per platform. */
  private readonly pending = new Map<AccountPlatform, string>();

  constructor(deps: AccountsServiceDeps) {
    this.browser = deps.browser;
    this.config = deps.config;
    this.log = deps.log;
    this.table = deps.platforms ?? ACCOUNT_PLATFORM_TABLE;
    this.now = deps.now ?? (() => Date.now());
    this.assumeDisplay = deps.assumeDisplay ?? false;
    this.ttlMs = deps.pendingPageTtlMs ?? (deps.handoffs !== undefined ? deps.config.handoff_ttl_ms : PENDING_PAGE_TTL_MS);
    this.store =
      deps.handoffs ??
      createHandoffStore({
        browser: deps.browser,
        config: { ...deps.config, handoff_ttl_ms: this.ttlMs },
        log: deps.log,
        ...(deps.now !== undefined && { now: deps.now }),
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
        pollMs: deps.pollMs ?? CONNECT_POLL_MS,
        assumeDisplay: this.assumeDisplay,
      });
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
    const open = [...this.pending.entries()].filter(([, id]) => this.store.get(id) !== undefined).map(([platform]) => platform);
    if (open.length > 0) {
      caveats.push(`A login page is still open for: ${open.join(", ")}. Finish logging in there, then call connect again or resume with its handoff id.`);
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
    if (!this.store.canPause()) {
      throw new AccountsError(
        "config",
        `connect needs a browser window you can see, and the persistent browser is headless here. Two ways out: run webrunner where a display exists with BROWSER_HEADLESS=false, or set BROWSER_CDP_URL (for example http://127.0.0.1:9222) to attach to your own Chrome started with --remote-debugging-port=9222 and log in there.`,
      );
    }
    const caveats = this.connectCaveats(platform);
    const started = this.now();

    if (await this.isConnected(spec)) {
      // A login finished in the page a previous `pending` connect left open completes that flow: `connected`.
      // With no such page the session was simply there already.
      const finishedPending = this.pendingId(platform) !== undefined;
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

    // Reuse the login page a previous `pending` left open (the owner may be halfway through), or open a fresh one and park it.
    const id = this.pendingId(platform) ?? (await this.parkLoginPage(platform, spec));
    const outcome = await this.store.resume(id, Math.max(0, waitSeconds));
    const waited = this.waited(started);
    switch (outcome.kind) {
      case "finished":
        this.pending.delete(platform);
        this.log.info("account connected", { platform, waited_s: waited });
        return {
          ...(outcome.output as AccountsConnectOutput),
          waited_s: waited,
          caveats,
        };
      case "paused":
        return {
          action: "connect",
          platform,
          status: "pending",
          login_url: spec.loginUrl,
          waited_s: waited,
          handoff_id: id,
          instructions:
            `The login page for ${platform} is open in the ${this.mode === "cdp" ? "Chrome you attached" : "webrunner browser window"} and stays open for ${Math.round(this.ttlMs / 60_000)} minutes. ` +
            `Log in there yourself (webrunner never types credentials), then call accounts with action "connect" and platform "${platform}" again, or resume with handoff_id "${id}"; either answers connected as soon as the session cookies are present.`,
          caveats,
        };
      case "cancelled":
      case "expired":
      case "unknown":
        this.pending.delete(platform);
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

  private async isConnected(spec: AccountPlatformSpec): Promise<boolean> {
    return checkSession(spec, await this.browser.cookies(), this.now()).connected;
  }

  private waited(startedMs: number): number {
    return Math.max(0, Math.round((this.now() - startedMs) / 1000));
  }

  /** The handoff id of this platform's open login page, or undefined when the store no longer has it. */
  private pendingId(platform: AccountPlatform): string | undefined {
    const id = this.pending.get(platform);
    if (id === undefined) return undefined;
    if (this.store.get(id) !== undefined) return id;
    this.pending.delete(platform);
    return undefined;
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

  /** Open the login URL on an unpooled page and park it as a login handoff. Returns the handoff id. */
  private async parkLoginPage(platform: AccountPlatform, spec: AccountPlatformSpec): Promise<string> {
    const page = await this.browser.openUnpooledPage();
    try {
      await page.goto(spec.loginUrl, { waitUntil: "domcontentloaded", timeout: LOGIN_GOTO_TIMEOUT_MS });
    } catch (err) {
      await this.browser.release(page);
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new AccountsError("provider", `could not open the ${platform} login page ${spec.loginUrl}: ${message}`, true);
    }
    const window = this.mode === "cdp" ? "Chrome you attached" : "webrunner browser window";
    let record;
    try {
      record = this.store.park({
        page,
        tool: "accounts",
        site: platform,
        url: spec.loginUrl,
        reason: "login_required",
        whatToDo: `Sign in to ${platform} in the ${window}; webrunner never types credentials. Then call accounts connect ${platform} again, or resume.`,
        step: "login",
        cleared: () => this.isConnected(spec),
        continue: () => this.connectedOutput(platform, spec),
      });
    } catch (err) {
      await this.browser.release(page);
      const message = err instanceof Error ? err.message : String(err);
      throw new AccountsError("provider", `could not keep the ${platform} login page open: ${message}`, false);
    }
    this.pending.set(platform, record.id);
    return record.id;
  }

  /** The continuation of a login handoff: the cookies are there, so the page can go. */
  private connectedOutput(platform: AccountPlatform, spec: AccountPlatformSpec): Promise<Record<string, unknown>> {
    this.pending.delete(platform);
    const output: AccountsConnectOutput = {
      action: "connect",
      platform,
      status: "connected",
      login_url: spec.loginUrl,
      waited_s: 0,
      instructions: `${platform} is connected. Tools that read through it: ${usedByText(spec)}.`,
      caveats: this.connectCaveats(platform),
    };
    return Promise.resolve(output);
  }

  /** Close and forget the pending login page for `platform`, if any. */
  private async forgetPending(platform: AccountPlatform, reason: string): Promise<void> {
    const id = this.pendingId(platform);
    if (id === undefined) return;
    this.pending.delete(platform);
    this.log.debug("closing pending login page", { platform, reason });
    await this.store.cancel(id);
  }
}

function usedByText(spec: AccountPlatformSpec): string {
  return spec.usedBy.length > 0 ? spec.usedBy.join(", ") : "none yet";
}

export function createAccountsService(deps: AccountsServiceDeps): AccountsService {
  return new DefaultAccountsService(deps);
}

