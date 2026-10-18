import type { Locator, Page } from "playwright";

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
