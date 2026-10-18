import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log as defaultLog, type Logger } from "../../log.js";
import { CostMeter } from "./cost.js";
import { LlmError, type Usage } from "./types.js";

/**
 * Process-wide daily soft cap on LLM spend (PLAN.md section 6, WP14).
 *
 * `DailyCostCap` is a `CostMeter`, so it plugs into `createLlmClient` as the
 * client-wide `meter`: every call is recorded here and every call is checked
 * against the cap first. Spend is kept in a small JSON file under `cache_dir`,
 * keyed by UTC date, so it survives restarts and is shared by the several
 * server processes a machine may run (Claude Code and Codex each start one).
 *
 * "Soft" means the call that crosses the cap still completes; the next one is
 * refused with `budget_exceeded`.
 */

export const DAILY_CAP_VARIABLE = "WEBRUNNER_DAILY_COST_CAP_USD";
export const DAILY_COST_FILE = "daily-cost.json";
/** Days of history kept in the file. */
const KEEP_DAYS = 14;

export interface DailyCostCapOptions {
  /** The cap in USD per UTC day. */
  capUsd: number;
  /** Directory for the spend file, normally `config.cache_dir`. */
  dir: string;
  /** Clock in epoch milliseconds. Default Date.now. */
  now?: () => number;
  log?: Logger;
}

function money(usd: number): string {
  return `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;
}

export class DailyCostCap extends CostMeter {
  readonly capUsd: number;
  private readonly file: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly log: Logger;
  /** What this process has recorded today; the fallback when the file cannot be read or written. */
  private memory = { date: "", usd: 0 };
  private warnedIo = false;

  constructor(options: DailyCostCapOptions) {
    super();
    this.capUsd = options.capUsd;
    this.dir = options.dir;
    this.file = join(options.dir, DAILY_COST_FILE);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? defaultLog;
  }

  /** The current UTC date, `YYYY-MM-DD`. */
  today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private readDays(): Record<string, number> {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.warnIo("read", err);
      return {};
    }
    try {
      const json = JSON.parse(text) as { days?: unknown };
      const days: Record<string, number> = {};
      if (typeof json.days === "object" && json.days !== null) {
        for (const [date, usd] of Object.entries(json.days)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
            days[date] = usd;
          }
        }
      }
      return days;
    } catch (err) {
      // A damaged file starts over; it holds nothing but a convenience counter.
      this.warnIo("parse", err);
      return {};
    }
  }

  private writeDays(days: Record<string, number>): void {
    const kept = Object.keys(days).sort().slice(-KEEP_DAYS);
    const out: Record<string, number> = {};
    for (const date of kept) out[date] = days[date] ?? 0;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ days: out }) + "\n", "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      this.warnIo("write", err);
    }
  }

  private warnIo(what: string, err: unknown): void {
    if (this.warnedIo) return;
    this.warnedIo = true;
    this.log.warn(`daily cost cap: could not ${what} ${this.file}; counting this process's spend only`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  /** USD spent so far today (UTC), across every process that shares the cache directory. */
  spentTodayUsd(): number {
    const date = this.today();
    const fromFile = this.readDays()[date] ?? 0;
    const fromMemory = this.memory.date === date ? this.memory.usd : 0;
    return Math.max(fromFile, fromMemory);
  }

  override record(usage: Usage, costUsd: number): void {
    super.record(usage, costUsd);
    if (!(costUsd > 0)) return;
    const date = this.today();
    this.memory = { date, usd: (this.memory.date === date ? this.memory.usd : 0) + costUsd };
    // Read, add, write in one synchronous step: no other call in this process can interleave.
    const days = this.readDays();
    days[date] = (days[date] ?? 0) + costUsd;
    this.writeDays(days);
  }

  /** The error to raise when today's spend has reached the cap, or undefined while there is room. */
  exceededError(): LlmError | undefined {
    const spent = this.spentTodayUsd();
    if (spent < this.capUsd) return undefined;
    const date = this.today();
    return new LlmError(
      "budget_exceeded",
      "api",
      `Daily cost cap reached: ${money(spent)} spent today (UTC ${date}) against the ${money(this.capUsd)} limit set by ${DAILY_CAP_VARIABLE}. ` +
        `Raise or unset ${DAILY_CAP_VARIABLE}, or try again after 00:00 UTC.`,
      {
        retryable: false,
        details: {
          scope: "daily",
          variable: DAILY_CAP_VARIABLE,
          date,
          spent_usd: spent,
          cap_usd: this.capUsd,
        },
      },
    );
  }

  /** Throws `budget_exceeded` once today's spend has reached the cap. Called before every LLM request. */
  override check(): void {
    const err = this.exceededError();
    if (err !== undefined) throw err;
  }
}
