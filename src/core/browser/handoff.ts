import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import type { Config } from "../../config.js";
import type { Logger } from "../../log.js";
import type { ErrorCode } from "../../schemas/error.js";
import type { Handoff, HandoffReason } from "../../schemas/handoff.js";
import type { BrowserSession, HandoffHooks, HandoffRecord, HandoffStore, ParkRequest, ResumeOutcome } from "./types.js";
import { classifyWall, probeWall, windowHidden } from "./walls.js";

/**
 * Parked runs, PLAN.md 16.3. At most three pages the owner is clearing a wall
 * on, each with the work to run again once the wall is gone. A parked page is
 * moved out of the pool (`BrowserSession.detach`) so it holds no slot, like a
 * login window; it is closed when the handoff expires, is cancelled, finishes,
 * or the store closes. The store only ever reads a parked page (the wall
 * probe) or closes it; it never types.
 */

export const MAX_PARKED = 3;
export const RESUME_POLL_MS = 2_000;

/** A failure the hosting tool turns into an error envelope (3.6) with this code. */
export class HandoffError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
  }
}

export interface HandoffStoreDeps {
  browser: BrowserSession;
  config: Config;
  log: Logger;
  /** Clock in ms since the epoch. */
  now?: () => number;
  /** Replaces the wait between probes. */
  sleep?: (ms: number) => Promise<void>;
  /** Interval between probes during `resume`. Default 2 s. */
  pollMs?: number;
  /** Treat the persistent browser as visible even when `resolveHeadless` says otherwise. Tests only. */
  assumeDisplay?: boolean;
}

interface Record_ extends HandoffRecord {
  timer: NodeJS.Timeout;
  /** Set when `park` was called again for this page while its continuation ran. */
  reparked: boolean;
  /** The page's URL and title at park time, for `unknown_wall`: cleared when either changed. */
  parkedTitle: string;
}

/** Is the wall gone? The generic classifier; for `unknown_wall`, also "the page moved on". */
async function defaultCleared(page: Page, reason: HandoffReason, parkedUrl: string, parkedTitle: string): Promise<boolean> {
  const probe = await probeWall(page);
  if (probe === undefined) return false;
  const wall = classifyWall(probe);
  if (wall !== undefined && wall.kind !== "ip_refusal") return false;
  if (reason === "unknown_wall") return probe.url !== parkedUrl || probe.title !== parkedTitle;
  return true;
}

class DefaultHandoffStore implements HandoffStore {
  private readonly records = new Map<string, Record_>();
  private readonly byPage = new Map<Page, Record_>();
  /** Ids that expired, so `resume` can say so instead of "unknown". Bounded. */
  private readonly expired = new Set<string>();
  /** Ids whose page the owner closed by hand: `resume` reports those as cancelled. Bounded. */
  private readonly closedByHand = new Set<string>();
  private closed = false;

  private readonly browser: BrowserSession;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly assumeDisplay: boolean;

  constructor(deps: HandoffStoreDeps) {
    this.browser = deps.browser;
    this.config = deps.config;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = deps.pollMs ?? RESUME_POLL_MS;
    this.assumeDisplay = deps.assumeDisplay ?? false;
  }

  canPause(): boolean {
    if (this.closed) return false;
    return this.assumeDisplay || !windowHidden(this.config);
  }

  park(req: ParkRequest): HandoffRecord {
    if (this.closed) throw new HandoffError("provider", "the handoff store is closed");
    const existing = this.byPage.get(req.page);
    if (existing !== undefined) {
      // The continuation met a wall again on the same page: same id, fresh expiry and instructions.
      Object.assign(existing, {
        site: req.site,
        url: req.url,
        reason: req.reason,
        whatToDo: req.whatToDo,
        step: req.step,
        cleared: req.cleared,
        continue: req.continue,
        reparked: true,
        expiresAt: new Date(this.now() + this.config.handoff_ttl_ms).toISOString(),
      });
      clearTimeout(existing.timer);
      existing.timer = this.expiryTimer(existing);
      this.log.info("handoff re-parked", { id: existing.id, tool: req.tool, site: req.site, reason: req.reason });
      return existing;
    }
    if (this.records.size >= MAX_PARKED) {
      const sites = [...this.records.values()].map((r) => `${r.site} (${r.id})`).join(", ");
      throw new HandoffError(
        "provider",
        `${MAX_PARKED} handoffs are already parked: ${sites}. Resume or cancel one of them before another page can be handed over.`,
      );
    }
    const id = this.newId();
    const createdAt = this.now();
    const record: Record_ = {
      ...req,
      id,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.config.handoff_ttl_ms).toISOString(),
      reparked: false,
      parkedTitle: "",
      timer: undefined as unknown as NodeJS.Timeout,
      toHandoff: () => this.toHandoff(record),
    };
    record.timer = this.expiryTimer(record);
    this.browser.detach(req.page);
    this.records.set(id, record);
    this.byPage.set(req.page, record);
    // The owner may close the window by hand: that is a cancel.
    req.page.once("close", () => {
      if (this.records.get(id) === record) {
        this.log.info("handoff page closed by hand", { id, site: record.site });
        clearTimeout(record.timer);
        this.records.delete(id);
        this.byPage.delete(req.page);
        this.remember(this.closedByHand, id);
      }
    });
    void this.rememberTitle(record);
    this.log.info("handoff parked", { id, tool: req.tool, site: req.site, reason: req.reason, step: req.step, expires_at: record.expiresAt });
    return record;
  }

  get(id: string): HandoffRecord | undefined {
    return this.records.get(id);
  }

  list(): Array<{ id: string; tool: string; site: string; reason: HandoffReason; expires_at: string }> {
    return [...this.records.values()].map((r) => ({ id: r.id, tool: r.tool, site: r.site, reason: r.reason, expires_at: r.expiresAt }));
  }

  async resume(id: string, waitSeconds: number): Promise<ResumeOutcome> {
    const record = this.records.get(id);
    if (record === undefined) {
      if (this.closedByHand.delete(id)) return { kind: "cancelled" };
      return { kind: this.expired.has(id) ? "expired" : "unknown" };
    }
    const deadline = this.now() + Math.max(0, waitSeconds) * 1000;
    for (;;) {
      if (record.page.isClosed()) {
        await this.forget(record, "page closed");
        return { kind: "cancelled" };
      }
      if (await this.isCleared(record)) break;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        const handoff = this.toHandoff(record);
        return {
          kind: "paused",
          handoff: { ...handoff, what_to_do: `The ${record.site} page still shows the wall. ${handoff.what_to_do}` },
        };
      }
      await this.sleep(Math.min(this.pollMs, remaining));
    }

    record.reparked = false;
    const bound = buildHooks(this, { tool: record.tool, parked: record });
    let output: Record<string, unknown>;
    try {
      output = await record.continue(bound.hooks);
    } catch (err) {
      if (!record.reparked) await this.forget(record, "continuation failed");
      throw err;
    }
    if (record.reparked) return { kind: "paused", handoff: this.toHandoff(record) };
    await this.forget(record, "finished");
    return { kind: "finished", output };
  }

  async cancel(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined) return false;
    await this.forget(record, "cancelled");
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.records.values()];
    await Promise.all(all.map((r) => this.forget(r, "store closed")));
  }

  /** True when `page` is held by the store. Used by the hooks; not part of the interface. */
  holds(page: Page): boolean {
    return this.byPage.has(page);
  }

  // -- helpers --------------------------------------------------------------

  private async isCleared(record: Record_): Promise<boolean> {
    try {
      if (record.cleared !== undefined) return await record.cleared(record.page);
      return await defaultCleared(record.page, record.reason, record.url, record.parkedTitle);
    } catch (err) {
      this.log.debug("handoff probe failed", { id: record.id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private async rememberTitle(record: Record_): Promise<void> {
    try {
      record.parkedTitle = await record.page.title();
    } catch {
      // The page may be mid-navigation; an empty title still works for the "moved on" check.
    }
  }

  private expiryTimer(record: Record_): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.records.get(record.id) !== record) return;
      this.log.info("handoff expired; closing its page", { id: record.id, site: record.site });
      this.remember(this.expired, record.id);
      void this.forget(record, "expired");
    }, this.config.handoff_ttl_ms);
    // Never keep the server alive for a parked page nobody is clearing.
    timer.unref();
    return timer;
  }

  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > 100) set.delete(set.values().next().value as string);
  }

  private async forget(record: Record_, reason: string): Promise<void> {
    clearTimeout(record.timer);
    this.records.delete(record.id);
    this.byPage.delete(record.page);
    this.log.debug("handoff forgotten", { id: record.id, reason });
    await this.browser.release(record.page);
  }

  private toHandoff(record: Record_): Handoff {
    return {
      id: record.id,
      tool: record.tool,
      site: record.site,
      url: record.url,
      reason: record.reason,
      what_to_do: record.whatToDo,
      expires_at: record.expiresAt,
      step: record.step,
    };
  }

  private newId(): string {
    for (;;) {
      const id = `h_${randomBytes(4).toString("hex")}`;
      if (!this.records.has(id) && !this.expired.has(id)) return id;
    }
  }
}

/** What a tool-side host needs to build hooks for one call. */
export interface HandoffCall {
  tool: string;
  /** The record this call continues, when it is a resumed call. */
  parked?: HandoffRecord;
}

/** The hooks handed to one tool call, plus what the host reads back after the work ran. */
export interface BoundHooks {
  hooks: HandoffHooks;
  /** The record this call parked (or re-parked), if any. */
  parkedRecord(): HandoffRecord | undefined;
  /** Set when a park was refused because the store was full. */
  refused(): HandoffError | undefined;
}

/**
 * Build the `HandoffHooks` for one tool call (PLAN.md 16.4). `pause` parks the
 * page with the call's work as the continuation and answers "timeout" at once
 * (the budget in this phase is always 0: `resume` waits before it runs the
 * continuation). One handoff per call: a second wall in the same call is not
 * parked. A full store makes `pause` throw `HandoffError`, which the host
 * turns into a `provider` error.
 */
export function buildHooks(store: HandoffStore, call: HandoffCall, work?: ParkRequest["continue"]): BoundHooks {
  let record: HandoffRecord | undefined;
  let refused: HandoffError | undefined;
  const holds = (page: Page): boolean => {
    if (store instanceof DefaultHandoffStore) return store.holds(page);
    return record?.page === page || call.parked?.page === page;
  };
  const hooks: HandoffHooks = {
    ...(call.parked !== undefined && { parked: { site: call.parked.site, page: call.parked.page } }),
    pause: (page, site, reason, whatToDo, step) => {
      const continuation = work ?? call.parked?.continue;
      if (continuation === undefined) return Promise.resolve("timeout");
      const samePage = call.parked !== undefined && call.parked.page === page;
      if (record !== undefined && !samePage) return Promise.resolve("timeout");
      try {
        record = store.park({ page, tool: call.tool, site, url: safeUrl(page), reason, whatToDo, step, continue: continuation });
      } catch (err) {
        if (err instanceof HandoffError) {
          refused = err;
          return Promise.reject(err);
        }
        throw err;
      }
      return Promise.resolve("timeout");
    },
    isParked: holds,
  };
  return { hooks, parkedRecord: () => record, refused: () => refused };
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

export function createHandoffStore(deps: HandoffStoreDeps): HandoffStore {
  return new DefaultHandoffStore(deps);
}
