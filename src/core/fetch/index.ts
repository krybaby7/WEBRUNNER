import type { Logger } from "../../log.js";
import {
  DEFAULT_MAX_CHARS,
  FetchPageOutputSchema,
  type FetchMode,
  type FetchPageInput,
  type FetchPageOutput,
} from "../../schemas/fetch_page.js";
import type { ErrorCode } from "../../schemas/error.js";
import type { Cache } from "../cache/index.js";
import { withRetry, type RetryOptions } from "../retry.js";
import { canonicalizeUrl } from "../search/canonical.js";
import { isThin, visibleTextLength } from "./botwall.js";
import { runFastChain } from "./fast/index.js";
import { FetchError, type FetchMethod, type FetchOpts, type FetchResult, type Fetcher } from "./types.js";

export { buildFastFetchers, runFastChain } from "./fast/index.js";

/** Per-attempt timeouts, PLAN.md section 3.2 and the WP5 brief. */
export const FAST_TIMEOUT_MS = 20_000;
export const BROWSER_TIMEOUT_MS = 45_000;
/** Cache lifetimes: 24 h for fast methods, 1 h for browser results. */
export const FAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const BROWSER_CACHE_TTL_MS = 60 * 60 * 1000;

export type FetchServiceErrorCode = Extract<
  ErrorCode,
  "provider" | "timeout" | "blocked" | "invalid_input" | "config" | "internal"
>;

/**
 * Thrown by `FetchService.fetchPage` when no page could be produced. `code`
 * maps onto the error envelope (PLAN.md section 3.6); `method` names the
 * fetcher that failed when one is known.
 */
export class FetchServiceError extends Error {
  readonly code: FetchServiceErrorCode;
  readonly retryable: boolean;
  readonly method?: FetchMethod;

  constructor(init: { code: FetchServiceErrorCode; message: string; retryable: boolean; method?: FetchMethod }) {
    super(init.message);
    this.name = "FetchServiceError";
    this.code = init.code;
    this.retryable = init.retryable;
    if (init.method !== undefined) this.method = init.method;
  }
}

export interface FetchService {
  /**
   * URL to Markdown. Throws `FetchServiceError` when no page could be produced.
   * `mode` defaults to "auto" and `max_chars` to 40000.
   */
  fetchPage(input: FetchPageInput): Promise<FetchPageOutput>;
}

export interface FetchServiceDeps {
  /** Fast fetchers in priority order (see `buildFastFetchers`). */
  fastFetchers: Fetcher[];
  /** The browser fetcher. When absent, `browser` mode fails with `config` and `auto` cannot fall back. */
  browserFetcher?: Fetcher;
  cache: Cache;
  log: Logger;
  /** Override the fast-path per-attempt timeout (default 20000). */
  timeoutMs?: number;
  /** Clock in epoch milliseconds, used for elapsed-time logging. Default Date.now. */
  now?: () => number;
  /** Secret values (API keys) to scrub from error messages and logs, on top of pattern-based scrubbing. */
  secrets?: string[];
  /** Override the browser per-attempt timeout (default 45000). */
  browserTimeoutMs?: number;
  /** Retry tuning for the fast chain (retries, delays, clock). Retries default to 2 and are capped at 2. */
  retry?: Pick<RetryOptions, "retries" | "baseMs" | "maxMs" | "random" | "sleep">;
}

/** Replace anything that looks like a credential in a message. */
function makeRedactor(secrets: string[]): (s: string) => string {
  const exact = secrets.filter((s) => s.length >= 6);
  return (s) => {
    let out = s;
    for (const secret of exact) out = out.split(secret).join("[redacted]");
    return out
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|token|key|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi,
        "$1[redacted]",
      );
  };
}

function toOutput(result: FetchResult): FetchPageOutput {
  return {
    url: result.url,
    final_url: result.final_url,
    title: result.title,
    markdown: result.markdown,
    truncated: result.truncated,
    method: result.method,
    fetched_at: result.fetched_at,
    cached: false,
  };
}

/** A result worth remembering: real content, not a wall and not a near-empty shell. */
function isCacheable(result: FetchResult): boolean {
  return !result.botWall && !isThin(result.markdown);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function createFetchService(deps: FetchServiceDeps): FetchService {
  const { cache, log } = deps;
  const fastTimeoutMs = deps.timeoutMs ?? FAST_TIMEOUT_MS;
  const browserTimeoutMs = deps.browserTimeoutMs ?? BROWSER_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const redact = makeRedactor(deps.secrets ?? []);
  const fastFetchers = deps.fastFetchers.filter((f) => f.isConfigured());
  const browser = deps.browserFetcher !== undefined && deps.browserFetcher.isConfigured() ? deps.browserFetcher : undefined;

  function toServiceError(err: unknown, fallbackMethod?: FetchMethod): FetchServiceError {
    if (err instanceof FetchServiceError) return err;
    if (err instanceof FetchError) {
      return new FetchServiceError({
        code: err.code,
        message: redact(err.message),
        retryable: err.retryable,
        method: err.fetcher,
      });
    }
    const message = redact(err instanceof Error ? err.message : String(err));
    return new FetchServiceError({
      code: "internal",
      message: `Fetching failed: ${message}`,
      retryable: false,
      ...(fallbackMethod !== undefined && { method: fallbackMethod }),
    });
  }

  /**
   * Run one attempt under a timeout. The signal is passed to the fetcher; the
   * race also covers a fetcher that ignores it.
   */
  async function attempt<T>(method: FetchMethod, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    let listener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      listener = () =>
        reject(new FetchError(method, "timeout", `Fetch timed out after ${timeoutMs} ms`, true));
      if (signal.aborted) listener();
      else signal.addEventListener("abort", listener, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      return await Promise.race([Promise.resolve().then(() => run(signal)), aborted]);
    } catch (err) {
      // A fetcher that reports the abort in its own words is still a timeout.
      if (signal.aborted && !(err instanceof FetchError && err.code === "timeout")) {
        throw new FetchError(method, "timeout", `Fetch timed out after ${timeoutMs} ms`, true);
      }
      throw err;
    } finally {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    }
  }

  async function runFast(url: string, opts: Omit<FetchOpts, "timeoutMs">): Promise<FetchResult> {
    if (fastFetchers.length === 0) {
      throw new FetchServiceError({
        code: "config",
        message: "No fast fetchers are available.",
        retryable: false,
      });
    }
    // Only a chain that failed outright is retried, and only for transient causes: a provider error
    // or a timeout marked retryable. `blocked` and `invalid_input` fail at once (auto mode needs the
    // browser for the first, the caller's input is wrong for the second). Worst case for the whole
    // call: 3 x 20 s attempts plus two waits of at most 2 s.
    return await withRetry(
      () =>
        attempt(fastFetchers[0]?.name ?? "direct", fastTimeoutMs, (signal) =>
          runFastChain(fastFetchers, url, { ...opts, timeoutMs: fastTimeoutMs }, signal),
        ),
      {
        ...deps.retry,
        isRetryable: (err) =>
          err instanceof FetchError && err.retryable && (err.code === "provider" || err.code === "timeout"),
        log,
        label: "fetch:fast",
      },
    );
  }

  async function runBrowser(url: string, opts: Omit<FetchOpts, "timeoutMs">): Promise<FetchResult> {
    if (browser === undefined) {
      throw new FetchServiceError({
        code: "config",
        message: "The browser fetcher is not available.",
        retryable: false,
        method: "browser",
      });
    }
    return await attempt("browser", browserTimeoutMs, (signal) =>
      browser.fetch(url, { ...opts, timeoutMs: browserTimeoutMs }, signal),
    );
  }

  /** Auto mode: fast chain first, the browser when the fast path hit a wall or came back thin. */
  async function runAuto(url: string, opts: Omit<FetchOpts, "timeoutMs">): Promise<FetchResult> {
    let fast: FetchResult | undefined;
    let blockedError: FetchError | undefined;
    try {
      fast = await runFast(url, opts);
    } catch (err) {
      if (err instanceof FetchError && err.code === "blocked") blockedError = err;
      else throw err;
    }

    if (fast !== undefined && !fast.botWall && !isThin(fast.markdown)) return fast;

    const reason = blockedError !== undefined ? "blocked" : fast?.botWall === true ? "bot_wall" : "thin";
    // A wall is proof the page needs a real browser; a thin page without one may simply be short.
    const wallEvidence = reason !== "thin";
    log.info("fetch_page: falling back to the browser", { url, reason, fast_method: fast?.method });

    if (browser === undefined) {
      if (!wallEvidence && fast !== undefined) return fast;
      if (blockedError !== undefined) throw blockedError;
      throw new FetchServiceError({
        code: "blocked",
        message: "The page is behind a bot wall and the browser fetcher is not available.",
        retryable: false,
        ...(fast !== undefined && { method: fast.method }),
      });
    }

    let rendered: FetchResult;
    try {
      rendered = await runBrowser(url, opts);
    } catch (err) {
      if (err instanceof FetchError && err.code === "blocked" && wallEvidence) throw err;
      if (fast !== undefined && fast.botWall) {
        // The fast result is wall text, not the page; never hand it back as content.
        throw new FetchServiceError({
          code: "blocked",
          message: "The page is behind a bot wall and the browser fallback failed: " + redact(err instanceof Error ? err.message : String(err)),
          retryable: err instanceof FetchError ? err.retryable : false,
          method: fast.method,
        });
      }
      if (fast !== undefined) {
        log.warn("fetch_page: browser fallback failed, returning the fast result", {
          url,
          fast_method: fast.method,
          code: err instanceof FetchError ? err.code : "internal",
          error: redact(err instanceof Error ? err.message : String(err)),
        });
        return fast;
      }
      throw err;
    }

    // A short page is still a page: when the fast path saw no wall and the browser is thin too
    // without finding substantially more text, the page is simply short and the fast result wins.
    if (
      fast !== undefined &&
      !fast.botWall &&
      isThin(rendered.markdown) &&
      visibleTextLength(rendered.markdown) < 2 * visibleTextLength(fast.markdown)
    ) {
      return fast;
    }
    return rendered;
  }

  async function fetchPage(input: FetchPageInput): Promise<FetchPageOutput> {
    const started = now();
    const mode: FetchMode = input.mode ?? "auto";
    const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
    const waitFor = input.wait_for;
    const url = input.url.trim();

    if (!isHttpUrl(url)) {
      throw new FetchServiceError({
        code: "invalid_input",
        message: "url must be an absolute http or https URL.",
        retryable: false,
      });
    }

    const keyFor = (u: string): Record<string, unknown> => ({
      kind: "fetch_page",
      url: canonicalizeUrl(u),
      mode,
      max_chars: maxChars,
      wait_for: waitFor,
    });
    const requestKey = keyFor(url);

    const stored = await cache.get<unknown>(requestKey);
    if (stored !== undefined) {
      // An entry written by an older version of the output shape is a miss, not an error.
      const hit = FetchPageOutputSchema.safeParse(stored);
      if (hit.success) return { ...hit.data, url, cached: true };
      log.warn("fetch cache entry does not match the output schema, ignoring it");
    }

    const opts = { maxChars, ...(waitFor !== undefined && { waitFor }) };
    let result: FetchResult;
    try {
      if (mode === "fast") result = await runFast(url, opts);
      else if (mode === "browser") result = await runBrowser(url, opts);
      else result = await runAuto(url, opts);
    } catch (err) {
      const mapped = toServiceError(err);
      log.warn("fetch_page failed", { url, mode, code: mapped.code, method: mapped.method, error: mapped.message });
      throw mapped;
    }

    const output = toOutput(result);
    if (isCacheable(result)) {
      const ttl = result.method === "browser" ? BROWSER_CACHE_TTL_MS : FAST_CACHE_TTL_MS;
      await cache.set(requestKey, output, ttl);
      // A later request for the redirect target hits as well.
      try {
        const finalKey = keyFor(result.final_url);
        if (finalKey["url"] !== requestKey["url"]) await cache.set(finalKey, output, ttl);
      } catch {
        // final_url was not a parseable URL; the request key alone is enough.
      }
    }
    log.debug("fetch_page done", {
      url,
      mode,
      method: output.method,
      cacheable: isCacheable(result),
      elapsed_ms: Math.max(0, now() - started),
    });
    return output;
  }

  return { fetchPage };
}
