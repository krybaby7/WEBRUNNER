import type { z } from "zod";
import type { Logger } from "../../log.js";
import type { ErrorCode } from "../../schemas/error.js";
import {
  SOCIAL_PLATFORMS,
  SocialItemSchema,
  type SocialItem,
  type SocialPlatform,
  type SocialSearchInputSchema,
  type SocialSearchOutput,
  type SocialSearchQuery,
} from "../../schemas/social.js";
import type { Cache } from "../cache/index.js";
import { CostMeter } from "../llm/cost.js";
import { LlmError, type LlmClient } from "../llm/types.js";
import { makeRedactor } from "./http.js";
import { finalizeItem, mergeSocialItems } from "./merge.js";
import { summarizeSocialItems } from "./summary.js";
import { SocialProviderError, type SocialHooks, type SocialPlatformProvider } from "./types.js";

export { buildAllSocialPlatforms, buildSocialPlatforms, type SocialPlatformDeps } from "./platforms/index.js";
export { mergeSocialItems, clipText } from "./merge.js";
export { summarizeSocialItems } from "./summary.js";

/**
 * The `social_search` service, PLAN.md 14.5: normalises the input to a
 * `SocialSearchQuery`, runs the platforms in parallel under their timeouts,
 * merges, caches per platform and optionally summarises.
 */

/** Cache lifetime per platform and query. Empty answers are not cached. */
export const SOCIAL_CACHE_TTL_MS = 15 * 60_000;
/** Per-platform timeouts by access kind. */
export const DEFAULT_SOCIAL_TIMEOUTS_MS: Readonly<Record<SocialPlatformProvider["access"], number>> = {
  api: 15_000,
  browser: 60_000,
};

/** The validated tool input (zod output: defaults applied). */
export type ParsedSocialSearchInput = z.output<typeof SocialSearchInputSchema>;

export type SocialSearchFailure = SocialSearchOutput["platforms_failed"][number];

/**
 * Thrown by `SocialService.search` when nothing could be produced: the input
 * names no usable platform, or every platform failed. `code` maps onto the
 * error envelope (PLAN.md 3.6).
 */
export class SocialSearchError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly platformsFailed: SocialSearchFailure[];

  constructor(init: { code: ErrorCode; message: string; retryable: boolean; platformsFailed?: SocialSearchFailure[] }) {
    super(init.message);
    this.name = "SocialSearchError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.platformsFailed = init.platformsFailed ?? [];
  }
}

export interface SocialServiceDeps {
  /** Every platform, configured or not. */
  platforms: SocialPlatformProvider[];
  cache: Cache;
  /** Needed for `summarize`; without it the summary is skipped with a caveat. */
  llm?: LlmClient;
  log: Logger;
  /** Per-platform timeouts by access kind. Defaults: 15 s api, 60 s browser. */
  timeoutsMs?: Partial<Record<SocialPlatformProvider["access"], number>>;
  /** Clock in epoch milliseconds, for `fetched_at`. Default Date.now. */
  now?: () => number;
  /** Secret values to scrub from error messages, on top of pattern-based scrubbing. */
  secrets?: string[];
}

export interface SocialSearchOptions {
  /** The tool's wall clock; aborts every platform call. */
  signal?: AbortSignal;
}

export interface SocialService {
  search(input: ParsedSocialSearchInput, opts?: SocialSearchOptions): Promise<SocialSearchOutput>;
}

const NOT_CONFIGURED_HINT: Record<SocialPlatform, string> = {
  reddit: "not configured",
  hackernews: "not configured",
  bluesky: "not configured",
  x: "not configured: X is read through the browser with a connected account (accounts connect x)",
  facebook: "not configured: Facebook is read through the browser with a connected account (accounts connect facebook)",
  youtube: "not configured: set YOUTUBE_API_KEY",
};

const URL_FORMS =
  "reddit.com/r/<sub>/comments/<id>, redd.it/<id>, news.ycombinator.com/item?id=<id>, bsky.app/profile/<handle>/post/<rkey>, youtube.com/watch?v=<id>, youtu.be/<id>, and X or Facebook post URLs when those platforms are connected";

interface Failure extends SocialSearchFailure {
  code: ErrorCode;
  retryable: boolean;
  /** True for "not configured"; such entries do not decide the error code when a real failure exists. */
  unconfigured: boolean;
  timedOut: boolean;
}

export interface NormalizedSocialInput {
  query: SocialSearchQuery;
  /** Platforms to run, in `query.platforms` order. */
  toRun: SocialPlatformProvider[];
  failed: Failure[];
  caveats: string[];
}

/**
 * Turn the tool input into the query every platform receives. Thread mode
 * infers the platform from the URL, ignores other `platforms` entries with a
 * caveat and forces `kind` to `comments`. Throws `SocialSearchError`
 * (`invalid_input` or `config`) when no platform can run.
 */
export function normalizeSocialInput(input: ParsedSocialSearchInput, platforms: SocialPlatformProvider[]): NormalizedSocialInput {
  const caveats: string[] = [];
  const failed: Failure[] = [];
  const configured = platforms.filter((p) => p.isConfigured());
  const base = {
    ...(input.query !== undefined && { query: input.query }),
    ...(input.recency !== undefined && { recency: input.recency }),
    sort: input.sort,
    max_results: input.max_results,
    per_platform: input.per_platform,
    ...(input.subreddits !== undefined && { subreddits: input.subreddits }),
    ...(input.lang !== undefined && { lang: input.lang }),
  };

  if (input.url !== undefined) {
    const owner = platforms.find((p) => p.ownsUrl(input.url as string));
    if (owner === undefined) {
      throw new SocialSearchError({
        code: "invalid_input",
        message: `No supported platform recognises ${input.url}. Supported URL forms: ${URL_FORMS}.`,
        retryable: false,
      });
    }
    if (!owner.isConfigured()) {
      throw new SocialSearchError({
        code: "config",
        message: `${input.url} belongs to ${owner.name}, which is ${NOT_CONFIGURED_HINT[owner.name]}.`,
        retryable: false,
        platformsFailed: [{ platform: owner.name, error: NOT_CONFIGURED_HINT[owner.name], needs_login: false }],
      });
    }
    if (input.platforms !== undefined && input.platforms.some((p) => p !== owner.name)) {
      caveats.push(`platforms (${input.platforms.join(", ")}) was ignored: the URL belongs to ${owner.name}, so only that platform was read.`);
    }
    if (input.kind !== "comments") {
      caveats.push("In url mode kind is always comments: the first item is the post itself, the rest are its comments.");
    }
    return {
      query: { mode: "thread", url: input.url, platforms: [owner.name], kind: "comments", ...base },
      toRun: [owner],
      failed,
      caveats,
    };
  }

  const requested = [...new Set(input.platforms ?? configured.map((p) => p.name))];
  if (requested.length === 0) {
    throw new SocialSearchError({
      code: "config",
      message:
        "No social platform is configured. Reddit, Hacker News and Bluesky need no key; YouTube needs YOUTUBE_API_KEY; X and Facebook need the browser and a connected account (accounts tool).",
      retryable: false,
    });
  }
  const toRun: SocialPlatformProvider[] = [];
  for (const name of requested) {
    const p = platforms.find((x) => x.name === name);
    if (p === undefined || !p.isConfigured()) {
      const hint = p === undefined && !(SOCIAL_PLATFORMS as readonly string[]).includes(name) ? "unknown platform" : NOT_CONFIGURED_HINT[name];
      failed.push({ platform: name, error: hint, needs_login: false, code: "config", retryable: false, unconfigured: true, timedOut: false });
    } else toRun.push(p);
  }
  if (toRun.length === 0) {
    throw new SocialSearchError({
      code: "config",
      message: `None of the requested platforms is available: ${failed.map((f) => `${f.platform} (${f.error})`).join("; ")}.`,
      retryable: false,
      platformsFailed: failed.map(publicFailure),
    });
  }
  return { query: { mode: "search", platforms: requested, kind: input.kind, ...base }, toRun, failed, caveats };
}

function publicFailure(f: Failure): SocialSearchFailure {
  return { platform: f.platform, error: f.error, needs_login: f.needs_login };
}

/** Reject when `signal` aborts, even if the platform ignores it. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, platform: SocialPlatform, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new SocialProviderError(`${platform} did not answer within ${Math.round(timeoutMs / 1000)}s (timed out or cancelled)`, {
          platform,
          code: "timeout",
          retryable: true,
        }),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

type Outcome = { platform: SocialPlatform; ok: true; items: SocialItem[]; cached: boolean } | { platform: SocialPlatform; ok: false; failure: Failure };

/** Thread mode: the post stays first (PLAN.md 14.5); its comments are merged behind it. */
function mergeThread(collected: SocialItem[], q: SocialSearchQuery): SocialItem[] {
  const post = collected.find((i) => i.kind === "post");
  if (post === undefined) return mergeSocialItems(collected, q.sort, q.max_results);
  const comments = collected.filter((i) => i !== post && i.url !== post.url);
  return [finalizeItem(post), ...mergeSocialItems(comments, q.sort, Math.max(0, q.max_results - 1))];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function createSocialService(deps: SocialServiceDeps): SocialService {
  const { cache, log } = deps;
  const now = deps.now ?? Date.now;
  const timeouts = { ...DEFAULT_SOCIAL_TIMEOUTS_MS, ...deps.timeoutsMs };
  const redact = makeRedactor(deps.secrets ?? []);

  function classify(err: unknown, platform: SocialPlatform): Failure {
    if (err instanceof SocialProviderError) {
      return {
        platform,
        error: redact(err.message),
        needs_login: err.needsLogin,
        code: err.code,
        retryable: err.retryable,
        unconfigured: false,
        timedOut: err.code === "timeout",
      };
    }
    if (err instanceof LlmError) {
      return { platform, error: redact(err.message), needs_login: false, code: err.code, retryable: err.retryable, unconfigured: false, timedOut: false };
    }
    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
    return { platform, error: redact(message), needs_login: false, code: "provider", retryable: false, unconfigured: false, timedOut: false };
  }

  function cacheKeyFor(platform: SocialPlatform, q: SocialSearchQuery): unknown {
    return {
      tool: "social_search",
      platform,
      mode: q.mode,
      query: q.query,
      url: q.url,
      kind: q.kind,
      recency: q.recency,
      sort: q.sort,
      per_platform: q.per_platform,
      subreddits: q.subreddits === undefined ? undefined : [...new Set(q.subreddits.map((s) => s.trim().toLowerCase()))].sort(),
      lang: q.lang,
    };
  }

  async function runPlatform(p: SocialPlatformProvider, q: SocialSearchQuery, outer: AbortSignal | undefined, hooks: SocialHooks): Promise<Outcome> {
    const key = cacheKeyFor(p.name, q);
    const stored = await cache.get<unknown>(key);
    if (stored !== undefined) {
      const hit = SocialItemSchema.array().safeParse(stored);
      if (hit.success) return { platform: p.name, ok: true, items: hit.data, cached: true };
      log.warn("social cache entry does not match the item schema, ignoring it", { platform: p.name });
    }

    const timeoutMs = timeouts[p.access];
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(outer !== undefined ? [outer] : [])]);
    try {
      const work = Promise.resolve().then(() =>
        q.mode === "thread" ? p.thread(q.url as string, q, signal, hooks) : p.search(q, signal, hooks),
      );
      const raw = await raceAbort(work, signal, p.name, timeoutMs);
      const items: SocialItem[] = [];
      let dropped = 0;
      for (const item of raw) {
        const checked = SocialItemSchema.safeParse(item);
        if (checked.success && checked.data.platform === p.name) items.push(checked.data);
        else dropped += 1;
      }
      if (dropped > 0) {
        log.warn("social platform returned invalid items, dropped", { platform: p.name, dropped });
        hooks.caveats?.push(`${p.name}: ${dropped} item(s) were dropped because they failed validation.`);
      }
      // An empty answer is often a page that had not finished loading; caching it would repeat it.
      if (items.length > 0) await cache.set(key, items, SOCIAL_CACHE_TTL_MS);
      return { platform: p.name, ok: true, items, cached: false };
    } catch (err) {
      return { platform: p.name, ok: false, failure: classify(err, p.name) };
    }
  }

  /** Most specific code wins: blocked, then a code shared by every real failure, then provider. */
  function allFailed(failures: Failure[], mode: SocialSearchQuery["mode"]): SocialSearchError {
    const real = failures.filter((f) => !f.unconfigured);
    const basis = real.length > 0 ? real : failures;
    let code: ErrorCode;
    if (basis.some((f) => f.code === "blocked")) code = "blocked";
    else if (basis.every((f) => f.code === (basis[0] as Failure).code)) code = (basis[0] as Failure).code;
    else code = "provider";
    const retryable = code !== "blocked" && basis.some((f) => f.retryable);
    const message =
      failures.length === 1
        ? `${(failures[0] as Failure).platform}: ${(failures[0] as Failure).error}`
        : `No social platform answered${mode === "thread" ? " for the thread" : ""}. ${failures.map((f) => `${f.platform}: ${f.error}`).join("; ")}`;
    return new SocialSearchError({ code, message, retryable, platformsFailed: failures.map(publicFailure) });
  }

  async function search(input: ParsedSocialSearchInput, opts: SocialSearchOptions = {}): Promise<SocialSearchOutput> {
    const { query, toRun, failed, caveats } = normalizeSocialInput(input, deps.platforms);
    const meter = new CostMeter({ maxCostUsd: input.max_cost_usd });
    const hooks: SocialHooks = { caveats: [], meter };

    const outcomes = await Promise.all(toRun.map((p) => runPlatform(p, query, opts.signal, hooks)));
    const used: SocialPlatform[] = [];
    const collected: SocialItem[] = [];
    for (const o of outcomes) {
      if (o.ok) {
        used.push(o.platform);
        collected.push(...o.items);
        if (o.cached) log.debug("social platform served from cache", { platform: o.platform, items: o.items.length });
      } else {
        failed.push(o.failure);
        log.warn("social platform failed", {
          platform: o.platform,
          code: o.failure.code,
          error: o.failure.error,
          needs_login: o.failure.needs_login,
          timed_out: o.failure.timedOut,
        });
      }
    }
    if (used.length === 0) throw allFailed(failed, query.mode);

    const items = query.mode === "thread" ? mergeThread(collected, query) : mergeSocialItems(collected, query.sort, query.max_results);
    const ordered = query.platforms.filter((name) => used.includes(name));
    caveats.push(...(hooks.caveats ?? []));
    for (const f of failed) {
      if (f.needs_login) caveats.push(`${f.platform} needs a logged-in session: connect it with the accounts tool (accounts connect ${f.platform}).`);
    }
    if (items.length === 0) caveats.push("No items were found.");

    const output: SocialSearchOutput = {
      query,
      items,
      platforms_used: ordered,
      platforms_failed: failed.map(publicFailure),
      fetched_at: new Date(now()).toISOString(),
      caveats: [],
    };

    if (input.summarize) {
      if (deps.llm === undefined) caveats.push("Summary skipped: no LLM client is available (set ANTHROPIC_API_KEY).");
      else if (items.length === 0) caveats.push("Summary skipped: there are no items to summarise.");
      else {
        try {
          output.summary = await summarizeSocialItems({
            llm: deps.llm,
            items,
            query,
            meter,
            log,
            ...(opts.signal !== undefined && { signal: opts.signal }),
          });
        } catch (err) {
          if (!(err instanceof LlmError)) throw err;
          log.warn("social summary failed", { code: err.code, error: redact(err.message) });
          caveats.push(`Summary unavailable (${err.code}): ${redact(err.message)}`);
        }
      }
    }

    output.caveats = dedupe(caveats);
    return output;
  }

  return { search };
}
