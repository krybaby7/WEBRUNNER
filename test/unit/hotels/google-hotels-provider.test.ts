import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { createGoogleHotelsRecipe } from "../../../src/core/browser/recipes/google-hotels.js";
import { RecipeError, type Recipe } from "../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { GoogleHotelsProvider } from "../../../src/core/hotels/providers/google-hotels.js";
import { buildAllHotelProviders, buildHotelProviders } from "../../../src/core/hotels/providers/index.js";
import { HotelProviderError } from "../../../src/core/hotels/types.js";
import { CostMeter } from "../../../src/core/llm/cost.js";
import { LlmError } from "../../../src/core/llm/types.js";
import { log } from "../../../src/log.js";
import type { HotelResult, NormalizedHotelsQuery } from "../../../src/schemas/hotels.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../browser/helpers.js";
import { cannedExtraction, forbiddenLlm, makeLogger, PARIS, scriptedLlm, startHotelsServer, type HotelsServer } from "./gh-helpers.js";

const probe = await probeChromium();
const never = (): AbortSignal => new AbortController().signal;

function fakeBrowser(): BrowserSession & { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; page: Page } {
  const page = { close: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
  return {
    page,
    acquire: vi.fn().mockResolvedValue(page),
    release: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isOpen: () => true,
    stats: () => ({}) as never,
  } as never;
}

function fakeRecipe(run: Recipe<NormalizedHotelsQuery, HotelResult[]>["run"]): Recipe<NormalizedHotelsQuery, HotelResult[]> {
  const real = createGoogleHotelsRecipe();
  return { site: "google_hotels", paramsSchema: real.paramsSchema, resultSchema: real.resultSchema, run };
}

const mk = (name: string, amount: number): HotelResult => ({
  id: `google_hotels:${name}`,
  source: "google_hotels",
  name,
  price_per_night: { amount, currency: "USD" },
  amenities: [],
  tags: [],
  availability: "available",
});

describe("GoogleHotelsProvider (fake browser and recipe)", () => {
  it("is named google_hotels and configured exactly when a browser exists (the LLM is optional)", () => {
    expect(new GoogleHotelsProvider({ browser: fakeBrowser() }).name).toBe("google_hotels");
    expect(new GoogleHotelsProvider({ browser: fakeBrowser() }).isConfigured()).toBe(true);
    expect(new GoogleHotelsProvider({ llm: forbiddenLlm() }).isConfigured()).toBe(false);
    expect(new GoogleHotelsProvider({}).isConfigured()).toBe(false);
  });

  it("acquires a page, gives the recipe a deadline from the timeout, surfaces caveats and always releases", async () => {
    const browser = fakeBrowser();
    const seen: { deadline?: number; meter?: unknown } = {};
    const hookMeter = new CostMeter();
    const provider = new GoogleHotelsProvider({
      browser,
      timeoutMs: 12_345,
      meter: new CostMeter(),
      recipe: fakeRecipe(async (page, _q, ctx) => {
        seen.deadline = ctx.deadline;
        seen.meter = ctx.meter;
        ctx.caveats?.push("a note");
        expect(page).toBe(browser.page);
        return [];
      }),
    });
    const before = Date.now();
    const hooks = { caveats: [] as string[], meter: hookMeter };
    await expect(provider.search(PARIS, never(), hooks)).resolves.toEqual([]);
    expect(seen.deadline! - before).toBeGreaterThanOrEqual(12_345);
    expect(seen.deadline! - before).toBeLessThan(13_500);
    expect(seen.meter).toBe(hookMeter);
    expect(hooks.caveats).toEqual(["a note"]);
    expect(browser.release).toHaveBeenCalledWith(browser.page);
  });

  it("defaults the budget to 90 seconds", async () => {
    let deadline = 0;
    const provider = new GoogleHotelsProvider({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async (_p, _q, ctx) => {
        deadline = ctx.deadline;
        return [];
      }),
    });
    const t = Date.now();
    await provider.search(PARIS, never());
    expect(deadline - t).toBeGreaterThanOrEqual(90_000);
    expect(deadline - t).toBeLessThan(91_000);
  });

  it("hands the recipe a config-failing LLM stub when it has none, and the real one otherwise", async () => {
    let client: { complete: (r: never) => Promise<unknown> } | undefined;
    const capture = fakeRecipe(async (_p, _q, ctx) => {
      client = ctx.llm;
      return [];
    });
    await new GoogleHotelsProvider({ browser: fakeBrowser(), recipe: capture }).search(PARIS, never());
    await expect(client!.complete({} as never)).rejects.toMatchObject({ code: "config", message: expect.stringContaining("ANTHROPIC_API_KEY") });
    const llm = forbiddenLlm();
    await new GoogleHotelsProvider({ browser: fakeBrowser(), llm, recipe: capture }).search(PARIS, never());
    expect(client).toBe(llm);
  });

  it.each(["blocked", "timeout", "provider", "invalid_input", "config"] as const)(
    "maps a RecipeError %s onto a HotelProviderError with the same code, and releases the page",
    async (code) => {
      const browser = fakeBrowser();
      const provider = new GoogleHotelsProvider({
        browser,
        recipe: fakeRecipe(async (_p, _q, ctx) => {
          ctx.caveats?.push("seen before failing");
          throw new RecipeError(code, `it was ${code}`);
        }),
      });
      const hooks = { caveats: [] as string[] };
      const err = await provider.search(PARIS, never(), hooks).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HotelProviderError);
      expect(err).toMatchObject({ code, provider: "google_hotels", message: `it was ${code}` });
      expect((err as HotelProviderError).cause).toBeInstanceOf(RecipeError);
      expect(hooks.caveats).toEqual(["seen before failing"]);
      expect(browser.release).toHaveBeenCalledTimes(1);
    },
  );

  it("passes an LlmError through unchanged and still releases", async () => {
    const browser = fakeBrowser();
    const llmError = new LlmError("budget_exceeded", "api", "cap", { retryable: false });
    const provider = new GoogleHotelsProvider({
      browser,
      recipe: fakeRecipe(async () => {
        throw llmError;
      }),
    });
    await expect(provider.search(PARIS, never())).rejects.toBe(llmError);
    expect(browser.release).toHaveBeenCalledTimes(1);
  });

  it("wraps unexpected errors as provider errors", async () => {
    const provider = new GoogleHotelsProvider({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async () => {
        throw new TypeError("oops");
      }),
    });
    await expect(provider.search(PARIS, never())).rejects.toMatchObject({ code: "provider" });
  });

  it("closes the page when the signal aborts, and reports a timeout", async () => {
    const browser = fakeBrowser();
    const ac = new AbortController();
    const provider = new GoogleHotelsProvider({
      browser,
      recipe: fakeRecipe(
        () =>
          new Promise((_resolve, reject) => {
            (browser.page.close as ReturnType<typeof vi.fn>).mockImplementation(async () => {
              reject(new Error("Target page, context or browser has been closed"));
            });
          }),
      ),
    });
    const p = provider.search(PARIS, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    expect(browser.release).toHaveBeenCalledTimes(1);
  });

  it("fails with config without a browser and with timeout when the signal is already aborted", async () => {
    const recipe = fakeRecipe(async () => []);
    await expect(new GoogleHotelsProvider({ recipe }).search(PARIS, never())).rejects.toMatchObject({ code: "config" });
    const browser = fakeBrowser();
    await expect(new GoogleHotelsProvider({ browser, recipe }).search(PARIS, AbortSignal.abort())).rejects.toMatchObject({ code: "timeout" });
    expect(browser.acquire).not.toHaveBeenCalled();
  });

  it("maps a browser that cannot open a page to a retryable provider error", async () => {
    const browser = fakeBrowser();
    browser.acquire.mockRejectedValue(new Error("launch failed"));
    const provider = new GoogleHotelsProvider({ browser, recipe: fakeRecipe(async () => []) });
    await expect(provider.search(PARIS, never())).rejects.toMatchObject({ code: "provider", retryable: true });
    expect(browser.release).not.toHaveBeenCalled();
  });

  it("keeps the page order and caps at max_results", async () => {
    const provider = new GoogleHotelsProvider({
      browser: fakeBrowser(),
      recipe: fakeRecipe(async () => Array.from({ length: 30 }, (_, i) => mk(`h${i}`, 100 - i))),
    });
    const hotels = await provider.search({ ...PARIS, max_results: 5 }, never());
    expect(hotels.map((h) => h.name)).toEqual(["h0", "h1", "h2", "h3", "h4"]);
  });
});

describe("hotel provider registration", () => {
  function config() {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    return loadConfig({ env: {}, configPath: "/nonexistent/webrunner-config.json", home: "/nonexistent" });
  }

  it("offers Google Hotels when a browser is given, and nothing otherwise", () => {
    const browser = fakeBrowser();
    expect(buildAllHotelProviders(config()).map((p) => p.name)).toEqual([]);
    expect(buildAllHotelProviders(config(), { browser, llm: forbiddenLlm() }).map((p) => [p.name, p.isConfigured()])).toEqual([["google_hotels", true]]);
    expect(buildHotelProviders(config(), { browser }).map((p) => p.name)).toEqual(["google_hotels"]);
    expect(buildHotelProviders(config(), { llm: forbiddenLlm() }).map((p) => p.name)).toEqual([]);
  });
});

describe.skipIf(!probe.available)(`GoogleHotelsProvider with a real browser${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: HotelsServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startHotelsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  const provider = (path: string, llm = forbiddenLlm(), timeoutMs = 20_000) =>
    new GoogleHotelsProvider({
      browser: session,
      llm,
      timeoutMs,
      logger: makeLogger(),
      recipe: createGoogleHotelsRecipe({ baseUrl: `${server.url}${path}`, pollMs: 50, nextPageWaitMs: 1500, noResultsGraceMs: 500 }),
    });

  it("returns hotels in page order, capped at max_results, and releases the page", async () => {
    const caveats: string[] = [];
    const hotels = await provider("/results").search({ ...PARIS, max_results: 12 }, never(), { caveats });
    expect(hotels).toHaveLength(12);
    expect(hotels.slice(0, 9).every((h) => h.tags.includes("Sponsored"))).toBe(true);
    expect(hotels[9]?.name).toBe("Best Western Hôtel Rives de Paris La Défense");
    expect(caveats.some((c) => /cookie consent/.test(c))).toBe(true);
    expect(session.stats().activePages).toBe(0);
  });

  it("works keyless on a recognised page and reaches the extractor only on an unrecognised one", async () => {
    const keyless = new GoogleHotelsProvider({
      browser: session,
      timeoutMs: 20_000,
      logger: makeLogger(),
      recipe: createGoogleHotelsRecipe({ baseUrl: `${server.url}/results`, pollMs: 50, nextPageWaitMs: 1500 }),
    });
    expect((await keyless.search(PARIS, never())).length).toBeGreaterThanOrEqual(10);
    const llm = scriptedLlm(() => cannedExtraction());
    expect(await provider("/unstructured", llm).search(PARIS, never())).toHaveLength(9);
    expect(llm.calls).toHaveLength(1);
    const noKey = new GoogleHotelsProvider({
      browser: session,
      timeoutMs: 20_000,
      logger: makeLogger(),
      recipe: createGoogleHotelsRecipe({ baseUrl: `${server.url}/unstructured`, pollMs: 50, noResultsGraceMs: 500 }),
    });
    await expect(noKey.search(PARIS, never())).rejects.toMatchObject({ code: "config", message: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(session.stats().activePages).toBe(0);
  });

  it("maps a bot wall to a blocked HotelProviderError and releases the page", async () => {
    const err = await provider("/blocked").search(PARIS, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelProviderError);
    expect((err as HotelProviderError).code).toBe("blocked");
    expect(session.stats().activePages).toBe(0);
  });

  it("maps an exhausted budget to a timeout and releases the page", async () => {
    const err = await provider("/stalled", forbiddenLlm(), 2500).search(PARIS, never()).catch((e: unknown) => e);
    expect((err as HotelProviderError).code).toBe("timeout");
    expect(session.stats().activePages).toBe(0);
  });
});
