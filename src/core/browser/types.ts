import type { Locator, Page } from "playwright";
import type { Handoff, HandoffReason } from "../../schemas/handoff.js";

export type { Handoff, HandoffReason };

/**
 * Browser engine types, PLAN.md sections 4.3 and 4.4.
 */

/** PLAN.md 4.3, plus `isOpen` and `stats` for later health reporting. */
export interface BrowserSession {
  /** A fresh page from the shared context. Waits (FIFO) when the pool is full. */
  acquire(): Promise<Page>;
  /** Close the page and free its pool slot. Never throws, also after `close()`. */
  release(page: Page): Promise<void>;
  /** Close pages and the browser/context. Idempotent. */
  close(): Promise<void>;
  /** True while a browser or CDP connection is up. False before first use and after close. */
  isOpen(): boolean;
  stats(): BrowserSessionStats;
  /** Cookies visible to the shared context, optionally only those sent to these URLs. Launches or attaches if needed. */
  cookies(urls?: string[]): Promise<BrowserCookie[]>;
  /** Remove cookies whose domain matches (exact, or a leading-dot parent). Persistent mode only; CDP mode throws. Returns how many were removed. */
  clearCookies(filter: { domain: string }): Promise<number>;
  /** A page that is not counted against the pool, for long-lived interactive use (login windows). Closed by `close()`. */
  openUnpooledPage(): Promise<Page>;
  /**
   * Move a leased page out of the pool (PLAN.md 16.3): its slot is freed at once and the page stays
   * open, unpooled (closed by `release()` or `close()`). A page that is not leased is left alone.
   */
  detach(page: Page): void;
}

/**
 * PLAN.md 14.8. A cookie as reported by `BrowserSession.cookies()`: there is
 * no `value` field, by design, so a cookie value can never reach a tool
 * result or a log line. `expires` is Unix seconds, or -1 for a session cookie.
 */
export interface BrowserCookie {
  name: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface BrowserSessionStats {
  /** How the session reaches a browser. `null` until the first `acquire()`. */
  mode: "persistent" | "cdp" | null;
  open: boolean;
  closed: boolean;
  headless: boolean;
  /** Pages currently handed out (or being created for a caller). */
  activePages: number;
  /** Callers waiting for a free slot. */
  waiting: number;
  maxPages: number;
  /** Pages handed out since the session was created. */
  totalAcquired: number;
  /** ISO 8601 UTC of the most recent launch or attach. */
  launchedAt?: string;
}

export interface BrowserSessionOptions {
  /** Explicit Chromium binary. Tests use it; production uses Playwright's own install. */
  executablePath?: string;
}

/** One entry per emitted line of `Snapshot.axTree`. */
export interface SnapshotRefInfo {
  role: string;
  name: string;
}

/**
 * PLAN.md 4.4. `refs` maps the `eN` ids printed in `axTree` back to locators
 * on the page the snapshot was taken from, so an action layer can click them.
 * Refs are deterministic for an unchanged page: the same page snapshotted
 * twice yields the same ids for the same nodes.
 */
export interface Snapshot {
  url: string;
  title: string;
  /** Compact accessibility tree: `[e3] button "Search" {disabled}`, one node per line, indented by depth. */
  axTree: string;
  /** Present when a screenshot was requested, or when the tree came back empty and a directory was given. */
  screenshotPath?: string;
  refs: Map<string, Locator>;
  refInfo: Map<string, SnapshotRefInfo>;
}

export interface SnapshotOptions {
  screenshot?: boolean;
  /** Directory for PNG screenshots. Created if missing. */
  screenshotDir?: string;
}

// -- human handoff (PLAN.md section 16) ------------------------------------------------

/** What a tool-side host hands to providers so a recipe can park its page (PLAN.md 16.4). */
export interface HandoffHooks {
  /** The parked page to continue on, for this site only; the provider uses it instead of acquiring one. */
  parked?: { site: string; page: Page };
  /**
   * Park `page` (or re-park it) with `reason` and `whatToDo`, then wait up to the host's budget for
   * the wall to clear. "cleared" means re-probe and continue; "timeout" means throw the wall as a
   * `blocked` error carrying `wall: reason`. In the original tool call the budget is 0.
   */
  pause(page: Page, site: string, reason: HandoffReason, whatToDo: string, step: string): Promise<"cleared" | "timeout">;
  /** True when `page` is held by the store: the provider must not release it. */
  isParked(page: Page): boolean;
}

/** What a tool parks (PLAN.md 16.3). */
export interface ParkRequest {
  page: Page;
  tool: string;
  site: string;
  url: string;
  reason: HandoffReason;
  whatToDo: string;
  step: string;
  /** Is the wall gone? Default: the generic wall classifier on the page. */
  cleared?: (page: Page) => Promise<boolean>;
  /** Run the work again with the page handed to its site. Resolves to the tool's normal output object. */
  continue: (hooks: HandoffHooks) => Promise<Record<string, unknown>>;
}

export interface HandoffRecord extends ParkRequest {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The `paused` result's `handoff` field for this record. */
  toHandoff(): Handoff;
}

export type ResumeOutcome =
  | { kind: "finished"; output: Record<string, unknown> }
  /** Still walled after the wait, or re-parked by the continuation. */
  | { kind: "paused"; handoff: Handoff }
  | { kind: "unknown" }
  | { kind: "expired" }
  | { kind: "cancelled" };

/**
 * Parked runs, one store per server (PLAN.md 16.3): at most three pages the
 * owner is clearing a wall on, each with the work to run again once the wall
 * is gone. Expired or cancelled parks close their page; `close()` closes all.
 */
export interface HandoffStore {
  /** True when a human can see the browser window: headful persistent mode, or CDP mode. */
  canPause(): boolean;
  /** Park a page. Throws `HandoffError` with code `provider` when three are already parked. */
  park(req: ParkRequest): HandoffRecord;
  get(id: string): HandoffRecord | undefined;
  /** For `health`: what is parked, by name. Never a URL. */
  list(): Array<{ id: string; tool: string; site: string; reason: HandoffReason; expires_at: string }>;
  /** Re-probe every 2 s for up to `waitSeconds`, then continue the run or report it still paused. */
  resume(id: string, waitSeconds: number): Promise<ResumeOutcome>;
  /** Close the page and forget the record. False when the id is unknown. */
  cancel(id: string): Promise<boolean>;
  /** Close every parked page. Idempotent. */
  close(): Promise<void>;
}
