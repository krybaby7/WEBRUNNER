import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log as defaultLog, type Logger } from "../../log.js";

/**
 * Disk cache, PLAN.md section 4.7: content-addressed JSON files, key = sha256
 * of a canonical JSON key, TTL stored alongside. No external dependency.
 * Clearing is `rm -rf` of the directory.
 *
 * Failures never throw. An unreadable file, bad JSON or a permissions error is
 * logged at warn level and behaves like a miss; a failed write is logged and
 * dropped. A cache that cannot be written must not break a search.
 */
export interface Cache {
  /** The stored value, or undefined on a miss, an expired entry or any failure. */
  get<T>(key: unknown): Promise<T | undefined>;
  /** Store `value` for `ttlMs` milliseconds. Never throws. */
  set<T>(key: unknown, value: T, ttlMs: number): Promise<void>;
}

export interface CacheOptions {
  /** Clock in epoch milliseconds. Injected in tests. */
  now?: () => number;
  /** Where warnings go. Defaults to the stderr logger. */
  log?: Logger;
}

/** What is written to disk for one entry. Times are epoch milliseconds. */
interface Entry {
  expires_at: number;
  stored_at: number;
  value: unknown;
}

function serialize(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return serialize((value as { toJSON: () => unknown }).toJSON());
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new TypeError("canonicalJson: bigint is not serializable");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v) ?? "null").join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const s = serialize(obj[k]);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic JSON: object keys sorted recursively (by UTF-16 code unit),
 * arrays kept in order, no whitespace. Follows JSON.stringify for values it
 * cannot represent: undefined, functions and symbols are omitted from objects
 * and become null in arrays, non-finite numbers become null, `toJSON` is
 * honoured. Throws on bigint and (via stack overflow) on cycles.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value) ?? "null";
}

function isEntry(v: unknown): v is Entry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e["expires_at"] === "number" && typeof e["stored_at"] === "number" && Object.hasOwn(e, "value");
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

export function createCache(dir: string, opts: CacheOptions = {}): Cache {
  const now = opts.now ?? Date.now;
  const logger = opts.log ?? defaultLog;

  /** `<dir>/<first 2 hex chars>/<sha256>.json` */
  function pathFor(key: unknown): { shard: string; file: string } {
    const hash = createHash("sha256").update(canonicalJson(key)).digest("hex");
    const shard = join(dir, hash.slice(0, 2));
    return { shard, file: join(shard, `${hash}.json`) };
  }

  async function discard(file: string): Promise<void> {
    try {
      await rm(file, { force: true });
    } catch (err) {
      logger.warn("cache: could not delete entry", { file, error: String(err) });
    }
  }

  return {
    async get<T>(key: unknown): Promise<T | undefined> {
      let file: string;
      try {
        file = pathFor(key).file;
      } catch (err) {
        logger.warn("cache: key is not serializable", { error: String(err) });
        return undefined;
      }

      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        if (errCode(err) !== "ENOENT") logger.warn("cache: read failed", { file, error: String(err) });
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        logger.warn("cache: entry is not valid JSON, treating as a miss", { file, error: String(err) });
        await discard(file);
        return undefined;
      }
      if (!isEntry(parsed)) {
        logger.warn("cache: entry has an unexpected shape, treating as a miss", { file });
        await discard(file);
        return undefined;
      }

      if (now() >= parsed.expires_at) {
        await discard(file);
        return undefined;
      }
      return parsed.value as T;
    },

    async set<T>(key: unknown, value: T, ttlMs: number): Promise<void> {
      if (value === undefined) {
        logger.warn("cache: value is undefined, not stored");
        return;
      }
      let target: { shard: string; file: string };
      let body: string;
      try {
        target = pathFor(key);
        const stored = now();
        const entry: Entry = { expires_at: stored + ttlMs, stored_at: stored, value };
        body = JSON.stringify(entry);
      } catch (err) {
        logger.warn("cache: could not serialize entry", { error: String(err) });
        return;
      }

      // Write to a temp file and rename so a concurrent reader never sees a partial entry.
      const tmp = `${target.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await mkdir(target.shard, { recursive: true });
        await writeFile(tmp, body, "utf8");
        await rename(tmp, target.file);
      } catch (err) {
        logger.warn("cache: write failed", { file: target.file, error: String(err) });
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    },
  };
}
