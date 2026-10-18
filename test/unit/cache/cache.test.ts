import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, createCache } from "../../../src/core/cache/index.js";
import type { Logger } from "../../../src/log.js";

let dir: string;

function spyLog(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** All entry files under dir, as paths relative to dir. */
function files(): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}');
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2, "10": 3, "2": 4 })).toBe(canonicalJson({ "2": 4, b: 2, "10": 3, a: 1 }));
  });

  it("omits undefined in objects and nulls it in arrays, like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("serializes primitives", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(5)).toBe("5");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(Number.NaN)).toBe("null");
  });
});

describe("createCache", () => {
  it("misses on an unknown key and does not create the directory on read", async () => {
    const sub = join(dir, "not-yet");
    const cache = createCache(sub);
    expect(await cache.get({ q: 1 })).toBeUndefined();
    expect(existsSync(sub)).toBe(false);
  });

  it("round-trips a value, with the key order irrelevant", async () => {
    const cache = createCache(dir);
    await cache.set({ a: 1, b: [1, 2] }, { hello: "world", n: 3 }, 1000);
    expect(await cache.get({ b: [1, 2], a: 1 })).toEqual({ hello: "world", n: 3 });
    expect(await cache.get({ a: 1, b: [2, 1] })).toBeUndefined();
  });

  it("creates the directory on first write and shards by the first two hex chars", async () => {
    const sub = join(dir, "deep", "cache");
    const cache = createCache(sub, { now: () => 5000 });
    await cache.set("k", { v: 1 }, 1000);
    const all = readdirSync(sub, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
    expect(all).toHaveLength(1);
    const [shard, name] = (all[0] ?? "").split(/[\\/]/);
    expect(shard).toMatch(/^[0-9a-f]{2}$/);
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(name?.startsWith(shard ?? "?")).toBe(true);
    const entry = JSON.parse(readFileSync(join(sub, all[0] ?? ""), "utf8")) as Record<string, unknown>;
    expect(entry).toEqual({ expires_at: 6000, stored_at: 5000, value: { v: 1 } });
  });

  it("uses sha256 of the canonical key as the file name", async () => {
    const { createHash } = await import("node:crypto");
    const key = { z: 1, a: 2 };
    const hash = createHash("sha256").update(canonicalJson(key)).digest("hex");
    const cache = createCache(dir);
    await cache.set(key, 1, 1000);
    expect(files()).toEqual([join(hash.slice(0, 2), `${hash}.json`)]);
  });

  it("expires entries by the injected clock and deletes them lazily", async () => {
    let t = 1_000_000;
    const cache = createCache(dir, { now: () => t });
    await cache.set("k", "v", 60_000);
    t += 59_999;
    expect(await cache.get("k")).toBe("v");
    expect(files()).toHaveLength(1);
    t += 1;
    expect(await cache.get("k")).toBeUndefined();
    expect(files()).toHaveLength(0);
  });

  it("stores falsy values", async () => {
    const cache = createCache(dir);
    await cache.set("zero", 0, 1000);
    await cache.set("empty", "", 1000);
    await cache.set("null", null, 1000);
    expect(await cache.get("zero")).toBe(0);
    expect(await cache.get("empty")).toBe("");
    expect(await cache.get("null")).toBeNull();
  });

  it("overwrites an existing entry", async () => {
    const cache = createCache(dir);
    await cache.set("k", 1, 1000);
    await cache.set("k", 2, 1000);
    expect(await cache.get("k")).toBe(2);
    expect(files()).toHaveLength(1);
  });

  it("treats a corrupt file as a miss and logs a warning", async () => {
    const log = spyLog();
    const cache = createCache(dir, { log });
    await cache.set("k", "v", 1000);
    const [rel] = files();
    writeFileSync(join(dir, rel ?? ""), "{ this is not json");
    expect(await cache.get("k")).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain("not valid JSON");
    // The bad file is removed, so the next write works normally.
    await cache.set("k", "again", 1000);
    expect(await cache.get("k")).toBe("again");
  });

  it("treats valid JSON of the wrong shape as a miss and logs a warning", async () => {
    const log = spyLog();
    const cache = createCache(dir, { log });
    await cache.set("k", "v", 1000);
    const [rel] = files();
    writeFileSync(join(dir, rel ?? ""), JSON.stringify({ unrelated: true }));
    expect(await cache.get("k")).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn on a plain miss", async () => {
    const log = spyLog();
    const cache = createCache(dir, { log });
    expect(await cache.get("nope")).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("never throws when the cache directory cannot be created", async () => {
    const log = spyLog();
    // A regular file where the directory should be: mkdir fails with ENOTDIR/EEXIST.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const cache = createCache(join(blocker, "cache"), { log });
    await expect(cache.set("k", "v", 1000)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(await cache.get("k")).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)("treats an unreadable file as a miss and logs a warning (EACCES)", async () => {
    const log = spyLog();
    const cache = createCache(dir, { log });
    await cache.set("k", "v", 1000);
    const [rel] = files();
    chmodSync(join(dir, rel ?? ""), 0o000);
    expect(await cache.get("k")).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("does not store undefined or unserializable keys, and does not throw", async () => {
    const log = spyLog();
    const cache = createCache(dir, { log });
    await expect(cache.set("k", undefined, 1000)).resolves.toBeUndefined();
    await expect(cache.set("k2", { n: 1n }, 1000)).resolves.toBeUndefined();
    await expect(cache.set({ n: 1n }, "v", 1000)).resolves.toBeUndefined();
    expect(await cache.get({ n: 1n })).toBeUndefined();
    expect(files()).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("leaves no temp files behind", async () => {
    const cache = createCache(dir);
    for (let i = 0; i < 5; i++) await cache.set({ i }, i, 1000);
    const all = readdirSync(dir, { recursive: true, encoding: "utf8" });
    expect(all.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
