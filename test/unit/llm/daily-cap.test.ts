import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLlmClient } from "../../../src/core/llm/client.js";
import { DAILY_CAP_VARIABLE, DAILY_COST_FILE, DailyCostCap } from "../../../src/core/llm/daily-cap.js";
import { LlmError, type Usage } from "../../../src/core/llm/types.js";
import { buildDeps } from "../../../src/deps.js";
import { makeConfig, makeFakeSdk, makeLogger, makeMessage } from "./helpers.js";

const USAGE: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const DAY1 = Date.parse("2026-10-18T10:00:00Z");
const userMsg = [{ role: "user" as const, content: "hi" }];

let dir: string;
let clock: number;
let log: ReturnType<typeof makeLogger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-daily-cap-"));
  clock = DAY1;
  log = makeLogger();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cap(capUsd = 5, where = dir): DailyCostCap {
  return new DailyCostCap({ capUsd, dir: where, now: () => clock, log });
}

const fileDays = (): Record<string, number> =>
  (JSON.parse(readFileSync(join(dir, DAILY_COST_FILE), "utf8")) as { days: Record<string, number> }).days;

describe("DailyCostCap", () => {
  it("starts at zero with no file and does not throw", () => {
    const c = cap();
    expect(c.spentTodayUsd()).toBe(0);
    expect(() => c.check()).not.toThrow();
    expect(c.exceededError()).toBeUndefined();
  });

  it("records every call into a JSON file keyed by UTC date", () => {
    const c = cap();
    c.record(USAGE, 0.25);
    c.record(USAGE, 0.5);
    expect(c.spentTodayUsd()).toBeCloseTo(0.75, 10);
    expect(fileDays()).toEqual({ "2026-10-18": 0.75 });
    // The per-run meter side of CostMeter keeps working too.
    expect(c.calls).toBe(2);
    expect(c.totalCostUsd).toBeCloseTo(0.75, 10);
  });

  it("persists across instances and processes sharing the directory", () => {
    cap().record(USAGE, 1);
    const second = cap();
    expect(second.spentTodayUsd()).toBe(1);
    second.record(USAGE, 2);
    expect(cap().spentTodayUsd()).toBe(3);
  });

  it("adds spend recorded by another process since this one last looked", () => {
    const c = cap();
    c.record(USAGE, 1);
    // Another server process writes to the same file.
    writeFileSync(join(dir, DAILY_COST_FILE), JSON.stringify({ days: { "2026-10-18": 4.5 } }));
    expect(c.spentTodayUsd()).toBe(4.5);
    c.record(USAGE, 0.25);
    expect(fileDays()["2026-10-18"]).toBeCloseTo(4.75, 10);
  });

  it("starts a fresh total at 00:00 UTC", () => {
    const c = cap(5);
    c.record(USAGE, 5);
    expect(() => c.check()).toThrow(LlmError);
    clock = Date.parse("2026-10-18T23:59:59.999Z");
    expect(() => c.check()).toThrow(LlmError);
    clock = Date.parse("2026-10-19T00:00:00.000Z");
    expect(c.spentTodayUsd()).toBe(0);
    expect(() => c.check()).not.toThrow();
    c.record(USAGE, 1);
    expect(fileDays()).toEqual({ "2026-10-18": 5, "2026-10-19": 1 });
  });

  it("uses the UTC date, not the local one", () => {
    // 23:30 UTC on the 18th is already the 19th in UTC+2, and still the 18th in UTC.
    clock = Date.parse("2026-10-18T23:30:00Z");
    expect(cap().today()).toBe("2026-10-18");
  });

  it("keeps only the most recent days in the file", () => {
    const days: Record<string, number> = {};
    for (let d = 1; d <= 20; d++) days[`2026-09-${String(d).padStart(2, "0")}`] = 1;
    writeFileSync(join(dir, DAILY_COST_FILE), JSON.stringify({ days }));
    cap().record(USAGE, 1);
    const kept = Object.keys(fileDays());
    expect(kept).toHaveLength(14);
    expect(kept).toContain("2026-10-18");
    expect(kept).not.toContain("2026-09-01");
  });

  describe("the cap", () => {
    it("is soft: the call that crosses it completes, the next one is refused", () => {
      const c = cap(1);
      c.check();
      c.record(USAGE, 1.4);
      expect(() => c.check()).toThrow(LlmError);
    });

    it("refuses at exactly the cap and allows just below it", () => {
      const c = cap(2);
      c.record(USAGE, 1.99);
      expect(() => c.check()).not.toThrow();
      c.record(USAGE, 0.01);
      expect(() => c.check()).toThrow(LlmError);
    });

    it("throws budget_exceeded naming the variable, the day's spend, the cap and the date", () => {
      const c = cap(5);
      c.record(USAGE, 5.678);
      let error: LlmError | undefined;
      try {
        c.check();
      } catch (err) {
        error = err as LlmError;
      }
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ code: "budget_exceeded", retryable: false });
      expect(error?.message).toContain(DAILY_CAP_VARIABLE);
      expect(error?.message).toContain("$5.68");
      expect(error?.message).toContain("$5.00");
      expect(error?.message).toContain("2026-10-18");
      expect(error?.details).toEqual({
        scope: "daily",
        variable: "WEBRUNNER_DAILY_COST_CAP_USD",
        date: "2026-10-18",
        spent_usd: 5.678,
        cap_usd: 5,
      });
    });

    it("shows small amounts with enough digits to be meaningful", () => {
      const c = cap(0.005);
      c.record(USAGE, 0.0062);
      expect(c.exceededError()?.message).toContain("$0.0062");
      expect(c.exceededError()?.message).toContain("$0.0050");
    });
  });

  describe("damaged or unwritable state", () => {
    it("treats a corrupt file as empty and carries on", () => {
      writeFileSync(join(dir, DAILY_COST_FILE), "{ not json");
      const c = cap();
      expect(c.spentTodayUsd()).toBe(0);
      c.record(USAGE, 1);
      expect(fileDays()).toEqual({ "2026-10-18": 1 });
      expect(log.warn).toHaveBeenCalled();
    });

    it("ignores malformed entries in an otherwise valid file", () => {
      writeFileSync(
        join(dir, DAILY_COST_FILE),
        JSON.stringify({ days: { "2026-10-18": 2, "yesterday": 9, "2026-10-17": "lots", "2026-10-16": -4 } }),
      );
      expect(cap().spentTodayUsd()).toBe(2);
    });

    it("creates the directory when it is missing", () => {
      const nested = join(dir, "does", "not", "exist");
      cap(5, nested).record(USAGE, 1);
      expect(readdirSync(nested)).toEqual([DAILY_COST_FILE]);
    });

    it("leaves no temporary files behind", () => {
      const c = cap();
      c.record(USAGE, 1);
      c.record(USAGE, 1);
      expect(readdirSync(dir)).toEqual([DAILY_COST_FILE]);
    });

    it("falls back to this process's own count when the file cannot be written", () => {
      // A regular file where the directory should be: every write fails.
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x");
      const c = cap(1, join(blocker, "sub"));
      c.record(USAGE, 0.6);
      c.record(USAGE, 0.6);
      expect(c.spentTodayUsd()).toBeCloseTo(1.2, 10);
      expect(() => c.check()).toThrow(LlmError);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it("does not crash when the directory is read-only", () => {
      const ro = join(dir, "ro");
      mkdirSync(ro);
      chmodSync(ro, 0o500);
      try {
        const c = cap(1, ro);
        expect(() => c.record(USAGE, 0.5)).not.toThrow();
        expect(c.spentTodayUsd()).toBeCloseTo(0.5, 10);
      } finally {
        chmodSync(ro, 0o700);
      }
    });
  });
});

describe("DailyCostCap as the LLM client's meter", () => {
  it("counts every call and refuses calls once the day's cap is reached", async () => {
    const c = cap(0.008);
    const sdk = makeFakeSdk(makeMessage({ usage: { input_tokens: 1000, output_tokens: 100 } }));
    const client = createLlmClient(makeConfig(), { sdk, meter: c });

    const first = await client.complete({ role: "extractor", system: "s", messages: userMsg });
    expect(first.costUsd).toBeGreaterThan(0);
    expect(fileDays()["2026-10-18"]).toBeCloseTo(first.costUsd, 10);

    // One more call is allowed to start only while under the cap; push it over and the next is refused.
    await client.complete({ role: "extractor", system: "s", messages: userMsg });
    const refused = await client.complete({ role: "extractor", system: "s", messages: userMsg }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LlmError);
    expect(refused).toMatchObject({ code: "budget_exceeded", retryable: false });
    expect((refused as LlmError).message).toContain(DAILY_CAP_VARIABLE);
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it("a new day lifts the block", async () => {
    const c = cap(0.0001);
    const sdk = makeFakeSdk(makeMessage({ usage: { input_tokens: 1000, output_tokens: 100 } }));
    const client = createLlmClient(makeConfig(), { sdk, meter: c });
    await client.complete({ role: "extractor", system: "s", messages: userMsg });
    await expect(client.complete({ role: "extractor", system: "s", messages: userMsg })).rejects.toBeInstanceOf(LlmError);
    clock = Date.parse("2026-10-19T00:00:01Z");
    await expect(client.complete({ role: "extractor", system: "s", messages: userMsg })).resolves.toBeDefined();
  });

  it("also counts calls that carry their own per-run meter", async () => {
    const c = cap(100);
    const sdk = makeFakeSdk(makeMessage({ usage: { input_tokens: 1000, output_tokens: 100 } }));
    const client = createLlmClient(makeConfig(), { sdk, meter: c });
    const { CostMeter } = await import("../../../src/core/llm/cost.js");
    const perRun = new CostMeter({ maxCostUsd: 50 });
    await client.complete({ role: "extractor", system: "s", messages: userMsg, meter: perRun });
    expect(c.spentTodayUsd()).toBeCloseTo(perRun.totalCostUsd, 10);
  });
});

describe("buildDeps", () => {
  it("builds no daily cap by default", () => {
    const deps = buildDeps(makeConfig({ cache_dir: dir, browser: { profile_dir: join(dir, "profile") } }));
    expect(deps.dailyCap).toBeUndefined();
  });

  it("builds the daily cap under cache_dir when WEBRUNNER_DAILY_COST_CAP_USD is set", () => {
    const deps = buildDeps(
      makeConfig({ cache_dir: dir, browser: { profile_dir: join(dir, "profile") }, daily_cost_cap_usd: 2.5 }),
    );
    expect(deps.dailyCap).toBeInstanceOf(DailyCostCap);
    expect(deps.dailyCap?.capUsd).toBe(2.5);
    deps.dailyCap?.record(USAGE, 1);
    expect(fileDays()[new Date().toISOString().slice(0, 10)]).toBe(1);
  });
});
