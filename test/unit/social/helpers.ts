import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Cache } from "../../../src/core/cache/index.js";
import type { SocialHooks, SocialPlatformProvider } from "../../../src/core/social/types.js";
import type { Logger } from "../../../src/log.js";
import type { SocialItem, SocialPlatform, SocialSearchQuery } from "../../../src/schemas/social.js";

export function loadFixture(name: string): unknown {
  const url = new URL(`../../fixtures/social/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

/** The Reddit thread fixture wraps its two-listing array in `listings` so the file can carry `_note`. */
export function redditThreadFixture(): unknown {
  return (loadFixture("reddit-thread") as { listings: unknown }).listings;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  /** Calls whose URL contains `fragment`. */
  to(fragment: string): RecordedCall[];
}

export type Responder = (call: RecordedCall, url: URL) => Response | Promise<Response>;

/** A fetch that records every call and answers through `respond`. */
export function fakeFetch(respond: Responder): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string" && { body: init.body }),
    };
    calls.push(call);
    return Promise.resolve().then(() => respond(call, new URL(call.url)));
  }) as typeof fetch;
  return { fetchImpl, calls, to: (fragment) => calls.filter((c) => c.url.includes(fragment)) };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export const signal = (): AbortSignal => new AbortController().signal;

export function query(over: Partial<SocialSearchQuery> = {}): SocialSearchQuery {
  return {
    mode: "search",
    query: "rust async",
    platforms: ["reddit", "hackernews", "bluesky", "youtube"],
    kind: "posts",
    sort: "engagement",
    max_results: 30,
    per_platform: 10,
    ...over,
  };
}

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

export function item(over: Partial<SocialItem> & { id: string }): SocialItem {
  const platform = over.platform ?? "hackernews";
  return {
    platform,
    kind: "post",
    url: `https://example.org/${platform}/${over.id}`,
    text: `text of ${over.id}`,
    truncated: false,
    ...over,
  };
}

export interface FakePlatform extends SocialPlatformProvider {
  searches: Array<{ q: SocialSearchQuery; hooks?: SocialHooks }>;
  threads: Array<{ url: string; q: SocialSearchQuery; hooks?: SocialHooks }>;
}

export interface FakePlatformOptions {
  access?: "api" | "browser";
  configured?: boolean;
  owns?: (url: string) => boolean;
  search?: (q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks) => Promise<SocialItem[]>;
  thread?: (url: string, q: SocialSearchQuery, signal: AbortSignal, hooks?: SocialHooks) => Promise<SocialItem[]>;
}

/** A platform whose search and thread answers are scripted. */
export function fakePlatform(name: SocialPlatform, opts: FakePlatformOptions = {}): FakePlatform {
  const searches: FakePlatform["searches"] = [];
  const threads: FakePlatform["threads"] = [];
  return {
    name,
    access: opts.access ?? "api",
    searches,
    threads,
    isConfigured: () => opts.configured ?? true,
    ownsUrl: opts.owns ?? ((url) => url.includes(`${name}.example`)),
    search: (q, s, hooks) => {
      searches.push({ q, ...(hooks !== undefined && { hooks }) });
      return (opts.search ?? (() => Promise.resolve([item({ id: `${name}:1`, platform: name })])))(q, s, hooks);
    },
    thread: (url, q, s, hooks) => {
      threads.push({ url, q, ...(hooks !== undefined && { hooks }) });
      return (
        opts.thread ??
        (() =>
          Promise.resolve([
            item({ id: `${name}:post`, platform: name, kind: "post" }),
            item({ id: `${name}:c1`, platform: name, kind: "comment" }),
          ]))
      )(url, q, s, hooks);
    },
  };
}

export interface MemoryCache extends Cache {
  store: Map<string, unknown>;
  gets: number;
  sets: number;
}

/** An in-memory cache keyed by the JSON of the key; TTLs are ignored. */
export function memoryCache(): MemoryCache {
  const store = new Map<string, unknown>();
  const cache: MemoryCache = {
    store,
    gets: 0,
    sets: 0,
    get: async <T>(key: unknown): Promise<T | undefined> => {
      cache.gets += 1;
      return store.get(JSON.stringify(key)) as T | undefined;
    },
    set: async (key: unknown, value: unknown): Promise<void> => {
      cache.sets += 1;
      store.set(JSON.stringify(key), value);
    },
  };
  return cache;
}

/** A promise that never settles. */
export const forever = <T>(): Promise<T> => new Promise<T>(() => undefined);
