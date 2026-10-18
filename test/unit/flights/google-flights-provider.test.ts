import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { createGoogleFlightsRecipe } from "../../../src/core/browser/recipes/google-flights.js";
import { RecipeError, type Recipe } from "../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import { GoogleFlightsProvider } from "../../../src/core/flights/providers/google-flights.js";
import { buildAllFlightProviders, buildFlightProviders } from "../../../src/core/flights/providers/index.js";
import { FlightProviderError } from "../../../src/core/flights/types.js";
import { LlmError } from "../../../src/core/llm/types.js";
import { log } from "../../../src/log.js";
import type { FlightOffer, NormalizedFlightsQuery } from "../../../src/schemas/flights.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../browser/helpers.js";
import {
  labelReadingLlm,
  makeLogger,
  ROUND_TRIP,
  scriptedLlm,
  startFlightsServer,
  type FlightsServer,
} from "./gf-helpers.js";

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
    cookies: () => Promise.resolve([]),
    clearCookies: () => Promise.resolve(0),
    openUnpooledPage: () => Promise.reject(new Error("fakeBrowser: openUnpooledPage is not available")),
  } as never;
}

function fakeRecipe(run: Recipe<NormalizedFlightsQuery, FlightOffer[]>["run"]): Recipe<NormalizedFlightsQuery, FlightOffer[]> {
  return { site: "google_flights", paramsSchema: createGoogleFlightsRecipe().paramsSchema, resultSchema: createGoogleFlightsRecipe().resultSchema, run };
}

describe("GoogleFlightsProvider (fake browser and recipe)", () => {
  it("is named google_flights and configured exactly when a browser exists", () => {
    expect(new GoogleFlightsProvider({ browser: fakeBrowser() }).name).toBe("google_flights");
    expect(new GoogleFlightsProvider({ browser: fakeBrowser() }).isConfigured()).toBe(true);
    expect(new GoogleFlightsProvider({}).isConfigured()).toBe(false);
  });

  it("acquires a page, gives the recipe a deadline from the timeout, surfaces caveats and always releases", async () => {
    const browser = fakeBrowser();
    const seen: { deadline?: number; hasMeter?: boolean } = {};
    const provider = new GoogleFlightsProvider({
      browser,
      llm: scriptedLlm(() => ({})),
      timeoutMs: 12_345,
      recipe: fakeRecipe(async (page, _q, ctx) => {
        seen.deadline = ctx.deadline;
        ctx.caveats?.push("a note");
        expect(page).toBe(browser.page);
        return [];
      }),
    });
    const before = Date.now();
    const hooks = { caveats: [] as string[] };
    await expect(provider.search(ROUND_TRIP, never(), hooks)).resolves.toEqual([]);
    expect(seen.deadline! - before).toBeGreaterThanOrEqual(12_345);
    expect(seen.deadline! - before).toBeLessThan(13_500);
    expect(hooks.caveats).toEqual(["a note"]);
    expect(browser.release).toHaveBeenCalledWith(browser.page);
  });

  it("defaults the budget to 60 seconds", async () => {
    let deadline = 0;
    const provider = new GoogleFlightsProvider({
      browser: fakeBrowser(),
      llm: scriptedLlm(() => ({})),
      recipe: fakeRecipe(async (_p, _q, ctx) => {
        deadline = ctx.deadline;
        return [];
      }),
    });
    const t = Date.now();
    await provider.search(ROUND_TRIP, never());
    expect(deadline - t).toBeGreaterThanOrEqual(60_000);
    expect(deadline - t).toBeLessThan(61_000);
  });

  it.each(["blocked", "timeout", "provider", "invalid_input", "config"] as const)(
    "maps a RecipeError %s onto a FlightProviderError with the same code, and releases the page",
    async (code) => {
      const browser = fakeBrowser();
      const provider = new GoogleFlightsProvider({
        browser,
        llm: scriptedLlm(() => ({})),
        recipe: fakeRecipe(async () => {
          throw new RecipeError(code, `it was ${code}`);
        }),
      });
      const err = await provider.search(ROUND_TRIP, never()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FlightProviderError);
      expect(err).toMatchObject({ code, provider: "google_flights", message: `it was ${code}` });
      expect((err as FlightProviderError).cause).toBeInstanceOf(RecipeError);
      expect(browser.release).toHaveBeenCalledTimes(1);
    },
  );

  it("passes an LlmError through unchanged and still releases", async () => {
    const browser = fakeBrowser();
    const llmError = new LlmError("budget_exceeded", "api", "cap", { retryable: false });
    const provider = new GoogleFlightsProvider({
      browser,
      llm: scriptedLlm(() => ({})),
      recipe: fakeRecipe(async () => {
        throw llmError;
      }),
    });
    await expect(provider.search(ROUND_TRIP, never())).rejects.toBe(llmError);
    expect(browser.release).toHaveBeenCalledTimes(1);
  });

  it("wraps unexpected errors as provider errors", async () => {
    const provider = new GoogleFlightsProvider({
      browser: fakeBrowser(),
      llm: scriptedLlm(() => ({})),
      recipe: fakeRecipe(async () => {
        throw new TypeError("oops");
      }),
    });
    await expect(provider.search(ROUND_TRIP, never())).rejects.toMatchObject({ code: "provider" });
  });

  it("closes the page when the signal aborts, and reports a timeout", async () => {
    const browser = fakeBrowser();
    const ac = new AbortController();
    const provider = new GoogleFlightsProvider({
      browser,
      llm: scriptedLlm(() => ({})),
      recipe: fakeRecipe(
        () =>
          new Promise((_resolve, reject) => {
            (browser.page.close as ReturnType<typeof vi.fn>).mockImplementation(async () => {
              reject(new Error("Target page, context or browser has been closed"));
            });
          }),
      ),
    });
    const p = provider.search(ROUND_TRIP, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    expect(browser.release).toHaveBeenCalledTimes(1);
  });

  it("fails with config when there is no LLM, no browser or the signal is already aborted", async () => {
    const recipe = fakeRecipe(async () => []);
    await expect(new GoogleFlightsProvider({ browser: fakeBrowser(), recipe }).search(ROUND_TRIP, never())).rejects.toMatchObject({
      code: "config",
      message: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
    await expect(new GoogleFlightsProvider({ llm: scriptedLlm(() => ({})), recipe }).search(ROUND_TRIP, never())).rejects.toMatchObject({
      code: "config",
    });
    const aborted = AbortSignal.abort();
    const browser = fakeBrowser();
    await expect(
      new GoogleFlightsProvider({ browser, llm: scriptedLlm(() => ({})), recipe }).search(ROUND_TRIP, aborted),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(browser.acquire).not.toHaveBeenCalled();
  });

  it("maps a browser that cannot open a page to a retryable provider error", async () => {
    const browser = fakeBrowser();
    browser.acquire.mockRejectedValue(new Error("launch failed"));
    const provider = new GoogleFlightsProvider({ browser, llm: scriptedLlm(() => ({})), recipe: fakeRecipe(async () => []) });
    await expect(provider.search(ROUND_TRIP, never())).rejects.toMatchObject({ code: "provider", retryable: true });
    expect(browser.release).not.toHaveBeenCalled();
  });

  it("returns offers sorted by price and capped", async () => {
    const mk = (id: string, amount: number): FlightOffer => ({
      id,
      source: "google_flights",
      price: { amount, currency: "USD" },
      total_duration_min: 1,
      stops: 0,
      slices: [
        {
          segments: [
            { airline: "BA", airline_name: "BA", depart_airport: "LHR", depart_at: "2026-12-01T10:00:00", arrive_airport: "JFK", arrive_at: "2026-12-01T12:00:00", duration_min: 1 },
          ],
          layovers: [],
        },
      ],
    });
    const provider = new GoogleFlightsProvider({
      browser: fakeBrowser(),
      llm: scriptedLlm(() => ({})),
      recipe: fakeRecipe(async () => Array.from({ length: 35 }, (_, i) => mk(`o${i}`, 100 - i))),
    });
    const offers = await provider.search(ROUND_TRIP, never());
    expect(offers).toHaveLength(30);
    expect(offers[0]?.price.amount).toBe(66);
  });
});

describe("flight provider registration", () => {
  function config() {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    return loadConfig({ env: {}, configPath: "/nonexistent/webrunner-config.json", home: "/nonexistent" });
  }

  it("includes Google Flights when a browser is given, and not otherwise", () => {
    const browser = fakeBrowser();
    expect(buildAllFlightProviders(config()).map((p) => p.name)).toEqual(["duffel"]);
    expect(buildAllFlightProviders(config(), { browser, llm: scriptedLlm(() => ({})) }).map((p) => [p.name, p.isConfigured()])).toEqual([
      ["duffel", false],
      ["google_flights", true],
    ]);
    expect(buildFlightProviders(config(), { browser }).map((p) => p.name)).toEqual(["google_flights"]);
    expect(buildFlightProviders(config(), {}).map((p) => p.name)).toEqual([]);
  });
});

describe.skipIf(!probe.available)(`GoogleFlightsProvider with a real browser${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: FlightsServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startFlightsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  const provider = (path: string, llm = labelReadingLlm(), timeoutMs = 20_000) =>
    new GoogleFlightsProvider({
      browser: session,
      llm,
      timeoutMs,
      logger: makeLogger(),
      recipe: createGoogleFlightsRecipe({ baseUrl: `${server.url}${path}`, pollMs: 50 }),
    });

  it("returns offers and releases the page", async () => {
    const offers = await provider("/results").search(ROUND_TRIP, never());
    expect(offers).toHaveLength(8);
    expect(session.stats().activePages).toBe(0);
  });

  it("maps a bot wall to a blocked FlightProviderError and releases the page", async () => {
    const err = await provider("/blocked").search(ROUND_TRIP, never()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlightProviderError);
    expect((err as FlightProviderError).code).toBe("blocked");
    expect(session.stats().activePages).toBe(0);
  });

  it("maps an exhausted budget to a timeout and releases the page", async () => {
    const err = await provider("/stalled", labelReadingLlm(), 2500).search(ROUND_TRIP, never()).catch((e: unknown) => e);
    expect((err as FlightProviderError).code).toBe("timeout");
    expect(session.stats().activePages).toBe(0);
  });
});
