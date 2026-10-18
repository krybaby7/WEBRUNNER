import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { setLogLevel } from "../../../src/log.js";
import { buildFastFetchers, runFastChain } from "../../../src/core/fetch/fast/index.js";
import { truncateMarkdown } from "../../../src/core/fetch/fast/shared.js";
import {
  FetchError,
  type FetchMethod,
  type FetchOpts,
  type FetchResult,
  type Fetcher,
} from "../../../src/core/fetch/types.js";
import { OPTS, fixture, htmlResponse, jsonFixture, jsonResponse, mockFetch, neverAborted } from "./helpers.js";

beforeAll(() => setLogLevel("error"));

const GOOD_TEXT = "A sentence of real article content that goes on for a while. ".repeat(12);

function result(method: FetchMethod, markdown: string, botWall = false): FetchResult {
  return {
    url: "https://example.com/",
    final_url: "https://example.com/",
    title: "T",
    markdown,
    truncated: false,
    method,
    fetched_at: new Date().toISOString(),
    botWall,
  };
}

interface StubCall {
  name: FetchMethod;
}

function stub(name: FetchMethod, outcome: FetchResult | FetchError, calls: StubCall[] = []): Fetcher {
  return {
    name,
    isConfigured: () => true,
    fetch: (_url: string, _opts: FetchOpts, _signal: AbortSignal) => {
      calls.push({ name });
      return outcome instanceof FetchError ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

describe("runFastChain", () => {
  it("returns the first good result and stops", async () => {
    const calls: StubCall[] = [];
    const out = await runFastChain(
      [stub("firecrawl", result("firecrawl", GOOD_TEXT), calls), stub("jina", result("jina", GOOD_TEXT), calls)],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(out.method).toBe("firecrawl");
    expect(calls.map((c) => c.name)).toEqual(["firecrawl"]);
  });

  it("falls through a bot-walled first fetcher to a good second one", async () => {
    const calls: StubCall[] = [];
    const out = await runFastChain(
      [
        stub("firecrawl", result("firecrawl", "Just a moment... " + GOOD_TEXT, true), calls),
        stub("jina", result("jina", GOOD_TEXT), calls),
        stub("direct", result("direct", GOOD_TEXT), calls),
      ],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(out.method).toBe("jina");
    expect(out.botWall).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["firecrawl", "jina"]);
  });

  it("falls through a thin result and a thrown error", async () => {
    const out = await runFastChain(
      [
        stub("firecrawl", new FetchError("firecrawl", "provider", "boom", true, 500)),
        stub("jina", result("jina", "too short")),
        stub("direct", result("direct", GOOD_TEXT)),
      ],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(out.method).toBe("direct");
  });

  it("returns the thickest non-bot-wall result when nothing is good, carrying botWall through", async () => {
    const thin = "Short page. ".repeat(10);
    const thinner = "Tiny.";
    const out = await runFastChain(
      [stub("firecrawl", result("firecrawl", thinner)), stub("jina", result("jina", thin)), stub("direct", result("direct", thinner))],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(out.method).toBe("jina");
    expect(out.botWall).toBe(false);
  });

  it("prefers a thin real page over a longer bot wall, and reports botWall when only walls remain", async () => {
    const wall = "Please enable JavaScript. ".repeat(10);
    const preferReal = await runFastChain(
      [stub("jina", result("jina", wall, true)), stub("direct", result("direct", "Tiny real page."))],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(preferReal.method).toBe("direct");
    expect(preferReal.botWall).toBe(false);

    const onlyWalls = await runFastChain(
      [stub("jina", result("jina", "wall", true)), stub("direct", result("direct", wall, true))],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(onlyWalls.method).toBe("direct");
    expect(onlyWalls.botWall).toBe(true);
  });

  it("returns a thin result rather than throwing when some fetcher succeeded", async () => {
    const out = await runFastChain(
      [stub("jina", new FetchError("jina", "timeout", "slow", true)), stub("direct", result("direct", "Hi."))],
      "https://example.com/",
      OPTS,
      neverAborted(),
    );
    expect(out.markdown).toBe("Hi.");
  });

  it("throws the last FetchError only when every fetcher threw", async () => {
    const last = new FetchError("direct", "blocked", "walled", false, 403);
    await expect(
      runFastChain(
        [stub("jina", new FetchError("jina", "provider", "first", true, 502)), stub("direct", last)],
        "https://example.com/",
        OPTS,
        neverAborted(),
      ),
    ).rejects.toBe(last);
  });

  it("wraps unexpected exceptions in a FetchError", async () => {
    const broken: Fetcher = {
      name: "jina",
      isConfigured: () => true,
      fetch: () => Promise.reject(new Error("unexpected bug")),
    };
    const err = await runFastChain([broken], "https://example.com/", OPTS, neverAborted()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe("provider");
    expect((err as FetchError).fetcher).toBe("jina");
  });

  it("throws a config error when there are no fetchers", async () => {
    const err = await runFastChain([], "https://example.com/", OPTS, neverAborted()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe("config");
  });

  it("stops trying fetchers once the signal aborts", async () => {
    const controller = new AbortController();
    const calls: StubCall[] = [];
    const first: Fetcher = {
      name: "firecrawl",
      isConfigured: () => true,
      fetch: () => {
        calls.push({ name: "firecrawl" });
        controller.abort();
        return Promise.reject(new FetchError("firecrawl", "timeout", "aborted", false));
      },
    };
    const err = await runFastChain([first, stub("jina", result("jina", GOOD_TEXT), calls)], "https://example.com/", OPTS, controller.signal).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FetchError);
    expect(calls.map((c) => c.name)).toEqual(["firecrawl"]);
  });

  it("works end to end with the real fetchers over an injected fetch", async () => {
    const config = loadConfig({ env: { FIRECRAWL_API_KEY: "fc-test" }, configPath: "/nonexistent/config.json", home: "/nonexistent" });
    const firecrawlWall = { success: true, data: { markdown: "# Just a moment...\n\nChecking if the site connection is secure", metadata: { title: "Just a moment...", url: "https://example.com/blog/caching", statusCode: 200 } } };
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.startsWith("https://api.firecrawl.dev/")) return jsonResponse(firecrawlWall);
      if (url.startsWith("https://r.jina.ai/")) return jsonResponse(jsonFixture("jina-reader.json"));
      return htmlResponse(fixture("article.html"));
    });

    const out = await runFastChain(buildFastFetchers(config, fetchImpl), "https://example.com/blog/caching", OPTS, neverAborted());

    expect(out.method).toBe("jina");
    expect(out.botWall).toBe(false);
    expect(out.markdown).toContain("## Choosing a strategy");
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["api.firecrawl.dev", "r.jina.ai"]);
  });
});

describe("buildFastFetchers", () => {
  const quiet = { configPath: "/nonexistent/config.json", home: "/nonexistent" };

  it("orders firecrawl, jina, direct when a Firecrawl key is set", () => {
    const config = loadConfig({ env: { FIRECRAWL_API_KEY: "fc-test", JINA_API_KEY: "jina_x" }, ...quiet });
    expect(buildFastFetchers(config).map((f) => f.name)).toEqual(["firecrawl", "jina", "direct"]);
  });

  it("omits firecrawl when it is not configured", () => {
    const config = loadConfig({ env: {}, ...quiet });
    const fetchers = buildFastFetchers(config);
    expect(fetchers.map((f) => f.name)).toEqual(["jina", "direct"]);
    expect(fetchers.every((f) => f.isConfigured())).toBe(true);
  });

  it("passes the Jina key through as a bearer token", async () => {
    const config = loadConfig({ env: { JINA_API_KEY: "jina_secret" }, ...quiet });
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(jsonFixture("jina-reader.json")));
    const jina = buildFastFetchers(config, fetchImpl).find((f) => f.name === "jina");
    await jina?.fetch("https://example.com/", OPTS, neverAborted());
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jina_secret");
  });
});

describe("truncateMarkdown", () => {
  it("returns short text untouched", () => {
    expect(truncateMarkdown("abc", 3)).toEqual({ markdown: "abc", truncated: false });
  });

  it("cuts on the last line boundary within the limit", () => {
    expect(truncateMarkdown("one\ntwo\nthree", 10)).toEqual({ markdown: "one\ntwo", truncated: true });
  });

  it("keeps the whole line when the cut already lands on a boundary", () => {
    expect(truncateMarkdown("one\ntwo\nthree", 7)).toEqual({ markdown: "one\ntwo", truncated: true });
  });

  it("hard-cuts a single long line", () => {
    expect(truncateMarkdown("abcdefghij", 4)).toEqual({ markdown: "abcd", truncated: true });
  });
});
