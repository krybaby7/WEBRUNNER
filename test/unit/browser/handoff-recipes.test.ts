import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../src/config.js";
import { createHandoffStore } from "../../../src/core/browser/handoff.js";
import { createAmazonReviewsRecipe } from "../../../src/core/browser/recipes/amazon-reviews.js";
import { runRecipeWithPause } from "../../../src/core/browser/recipes/pause.js";
import { RecipeError, type Recipe, type RecipeContext } from "../../../src/core/browser/recipes/types.js";
import { createXSearchRecipe } from "../../../src/core/browser/recipes/x-search.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession, HandoffHooks } from "../../../src/core/browser/types.js";
import { HEADLESS_HINT, IP_REFUSED_HINT } from "../../../src/core/browser/walls.js";
import { AmazonReviewSource } from "../../../src/core/reviews/sources/amazon.js";
import { XProvider } from "../../../src/core/social/platforms/x.js";
import type { Deps } from "../../../src/deps.js";
import type { Logger } from "../../../src/log.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { PausedOutputSchema, type PausedOutput } from "../../../src/schemas/handoff.js";
import type { SearchReviewsOutput } from "../../../src/schemas/reviews.js";
import type { SocialSearchOutput } from "../../../src/schemas/social.js";
import { registerAccountsTool } from "../../../src/tools/accounts.js";
import { registerHealthTool } from "../../../src/tools/health.js";
import { TOOL_NAMES } from "../../../src/tools/index.js";
import { registerResumeTool } from "../../../src/tools/resume.js";
import { registerSearchReviewsTool } from "../../../src/tools/search_reviews.js";
import { registerSocialSearchTool } from "../../../src/tools/social_search.js";
import { startReviewsServer, type ReviewsFixtureServer } from "../reviews/browser/helpers.js";
import { forbiddenLlm, spyPage, startSocialServer, type PageSpy, type SocialServer } from "../social/browser/helpers.js";
import { callTool, connectServer, type Connected } from "../tools/helpers.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "./helpers.js";

/**
 * WP46: the recipes and `accounts connect` on the handoff (PLAN.md 16.4, 16.5).
 * Real Chromium against the social and review fixture servers, whose gated
 * scenarios show a login wall until the test "logs in" by opening the gate.
 */

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A session whose pages are spied on, so the test can assert nothing typed. */
function spiedSession(real: BrowserSession): { session: BrowserSession; spies: PageSpy[] } {
  const spies: PageSpy[] = [];
  const toReal = new Map<Page, Page>();
  const wrap = (page: Page): Page => {
    const spy = spyPage(page);
    spies.push(spy);
    toReal.set(spy.page, page);
    return spy.page;
  };
  const unwrap = (page: Page): Page => toReal.get(page) ?? page;
  return {
    spies,
    session: {
      ...real,
      acquire: async () => wrap(await real.acquire()),
      openUnpooledPage: async () => wrap(await real.openUnpooledPage()),
      release: (page) => real.release(unwrap(page)),
      detach: (page) => real.detach(unwrap(page)),
      close: () => real.close(),
      isOpen: () => real.isOpen(),
      stats: () => real.stats(),
      cookies: (urls) => real.cookies(urls),
      clearCookies: (f) => real.clearCookies(f),
    },
  };
}

// -- the pause loop (no browser) ---------------------------------------------------------------------------------------

describe("runRecipeWithPause", () => {
  const page = {} as Page;
  const ctx: RecipeContext = { llm: forbiddenLlm(), log: makeLog(), deadline: Date.now() + 10_000 };
  function recipe(run: Recipe<string, string>["run"]): Recipe<string, string> {
    return { site: "fake", paramsSchema: undefined as never, resultSchema: undefined as never, run };
  }
  const hooksFor = (answers: Array<"cleared" | "timeout">, calls: unknown[][] = []): HandoffHooks => ({
    pause: (...args) => {
      calls.push(args);
      return Promise.resolve(answers.shift() ?? "timeout");
    },
    isParked: () => false,
  });

  it("offers a walled error to the owner once and runs the recipe again from navigation after 'cleared'", async () => {
    let runs = 0;
    const calls: unknown[][] = [];
    const r = recipe(() => {
      runs++;
      if (runs === 1) throw new RecipeError("blocked", "X served a CAPTCHA at https://x.com/search; no results", { wall: "captcha" });
      return Promise.resolve("ok");
    });
    expect(await runRecipeWithPause(r, page, "q", ctx, hooksFor(["cleared"], calls))).toBe("ok");
    expect(runs).toBe(2);
    expect(calls).toEqual([[page, "fake", "captcha", "", "fake: X served a CAPTCHA at https://x.com/search"]]);
  });

  it("throws the wall as it is on 'timeout' (the tool then reports paused), and a wall met twice", async () => {
    const r = recipe(() => Promise.reject(new RecipeError("blocked", "login wall", { wall: "login_required", needsLogin: true })));
    await expect(runRecipeWithPause(r, page, "q", ctx, hooksFor(["timeout"]))).rejects.toMatchObject({ wall: "login_required", message: "login wall" });
    await expect(runRecipeWithPause(r, page, "q", ctx, hooksFor(["cleared", "cleared"]))).rejects.toMatchObject({ wall: "login_required" });
  });

  it("adds the headless hint when nobody can pause, the IP hint to an IP-level refusal, and nothing to a login or a rate limit", async () => {
    const walled = recipe(() => Promise.reject(new RecipeError("blocked", "a CAPTCHA", { wall: "captcha" })));
    await expect(runRecipeWithPause(walled, page, "q", ctx, undefined)).rejects.toThrow(`a CAPTCHA. ${HEADLESS_HINT}`);
    const refused = recipe(() => Promise.reject(new RecipeError("blocked", "X answered HTTP 403; it is blocking this browser or network")));
    await expect(runRecipeWithPause(refused, page, "q", ctx, hooksFor([]))).rejects.toThrow(IP_REFUSED_HINT);
    await expect(runRecipeWithPause(refused, page, "q", ctx, undefined)).rejects.toThrow(IP_REFUSED_HINT);
    const limited = recipe(() => Promise.reject(new RecipeError("blocked", "X answered HTTP 429; it is blocking this browser or network")));
    await expect(runRecipeWithPause(limited, page, "q", ctx, hooksFor([]))).rejects.toThrow(/HTTP 429; it is blocking this browser or network$/);
    const login = recipe(() => Promise.reject(new RecipeError("blocked", "needs a session", { needsLogin: true })));
    await expect(runRecipeWithPause(login, page, "q", ctx, undefined)).rejects.toThrow(/needs a session$/);
    const other = recipe(() => Promise.reject(new RecipeError("timeout", "slow")));
    await expect(runRecipeWithPause(other, page, "q", ctx, hooksFor(["cleared"]))).rejects.toMatchObject({ code: "timeout" });
  });
});

// -- through the tools, on real Chromium ------------------------------------------------------------------------------------

const chromium = await probeChromium();

describe.skipIf(!chromium.available)(`recipes on the handoff${chromium.available ? "" : ` (${chromium.reason})`}`, () => {
  let social: SocialServer;
  let reviews: ReviewsFixtureServer;
  let profileDir: string;
  let config: Config;
  let real: BrowserSession;
  let session: BrowserSession;
  let spies: PageSpy[];
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    social = await startSocialServer();
    reviews = await startReviewsServer();
    profileDir = await makeTempDir();
    config = { ...makeConfig(profileDir), anthropic_api_key: "test", handoff_ttl_ms: 60_000 };
    real = createBrowserSession(config);
    ({ session, spies } = spiedSession(real));
  }, 30_000);

  afterAll(async () => {
    await real?.close();
    await social?.close();
    await reviews?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  beforeEach(() => {
    social.walled.add("x");
    reviews.walled.add("amazon");
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
    expect(session.stats().activePages).toBe(0);
    expect(spies.flatMap((s) => s.forbidden)).toEqual([]);
  });

  function makeDeps(over: Partial<Deps> = {}): Deps {
    const handoffs = createHandoffStore({ browser: session, config, log: makeLog(), assumeDisplay: true, sleep: () => Promise.resolve() });
    cleanups.push(() => handoffs.close());
    return { config, log: makeLog(), browser: session, llm: forbiddenLlm(), llmInfo: { backend: "api", fallback: "none" }, handoffs, ...over };
  }

  async function connect(deps: Deps, scenario: string): Promise<Connected> {
    const x = new XProvider({ browser: session, recipe: createXSearchRecipe({ baseUrl: social.scenario(scenario), pollMs: 50, settleMs: 100, maxResultsWaitMs: 2000 }) });
    const amazon = new AmazonReviewSource({
      browser: session,
      recipe: createAmazonReviewsRecipe({ baseUrl: `${reviews.url}/amazon`, pollMs: 50, maxWaitMs: 4000, settleMs: 300, medleyWaitMs: 500 }),
    });
    const c = await connectServer((server) => {
      registerSocialSearchTool(server, deps, { platforms: () => [x], timeoutsMs: { browser: 15_000 } });
      registerSearchReviewsTool(server, deps, { sources: () => [amazon], timeoutsMs: { amazon: 15_000 } });
      registerAccountsTool(server, deps);
      registerResumeTool(server, deps);
      registerHealthTool(server, deps, TOOL_NAMES);
    });
    cleanups.push(() => c.close());
    return c;
  }

  /** The owner "logs in": the gate opens and the parked page moves on to the results. */
  async function logIn(platform: "x" | "amazon", url: string): Promise<void> {
    (platform === "x" ? social : reviews).walled.delete(platform);
    const page = spies.map((s) => s.page).filter((p) => !p.isClosed()).at(-1);
    if (page === undefined) throw new Error("no parked page");
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  it("social_search pauses at X's login page, and resume finishes the search on the page the owner logged in on", async () => {
    const deps = makeDeps();
    const { client } = await connect(deps, "x-gate");
    const first = await callTool(client, "social_search", { query: "claude code", platforms: ["x"], kind: "posts" });
    expect(first.isError, JSON.stringify(first.structuredContent)).toBeUndefined();
    const paused = first.structuredContent as PausedOutput;
    expect(PausedOutputSchema.safeParse(paused).success).toBe(true);
    expect(paused.handoff).toMatchObject({ tool: "social_search", site: "x", reason: "login_required" });
    expect(paused.handoff.url).toContain("/i/flow/login");
    expect(paused.handoff.what_to_do).toMatch(/Sign in to x in the webrunner browser window; webrunner never types/);
    expect(paused.handoff.step).toMatch(/^x: X requires a logged-in session/);
    expect(deps.handoffs?.list().map((h) => h.site)).toEqual(["x"]);

    const still = await callTool(client, "resume", { handoff_id: paused.handoff.id, wait_seconds: 0 });
    expect((still.structuredContent as PausedOutput).handoff?.id, JSON.stringify(still.structuredContent)).toBe(paused.handoff.id);

    await logIn("x", `${social.scenario("x-gate")}/search?q=claude+code&src=typed_query&f=top`);
    const done = await callTool(client, "resume", { handoff_id: paused.handoff.id, wait_seconds: 0 });
    expect(done.isError, JSON.stringify(done.structuredContent)).toBeUndefined();
    const output = done.structuredContent as SocialSearchOutput;
    expect(output.platforms_used).toEqual(["x"]);
    expect(output.items.length).toBeGreaterThan(0);
    expect(output.items.every((i) => i.platform === "x")).toBe(true);
    expect(deps.handoffs?.list()).toEqual([]);
  });

  it("search_reviews pauses at Amazon's sign-in page and resume reads the reviews afterwards", async () => {
    const deps = makeDeps();
    const { client } = await connect(deps, "x-ok");
    const subject = "https://www.amazon.com/dp/B0GATE0000";
    const first = await callTool(client, "search_reviews", { subject, sources: ["amazon"] });
    expect(first.isError, JSON.stringify(first.structuredContent)).toBeUndefined();
    const paused = first.structuredContent as PausedOutput;
    expect(paused.handoff).toMatchObject({ tool: "search_reviews", site: "amazon", reason: "login_required" });
    expect(paused.handoff.what_to_do).toMatch(/Sign in to amazon/);

    await logIn("amazon", `${reviews.url}/amazon/product-reviews/B0GATE0000?reviewerType=all_reviews&sortBy=helpful&pageNumber=1`);
    const done = await callTool(client, "resume", { handoff_id: paused.handoff.id, wait_seconds: 0 });
    expect(done.isError, JSON.stringify(done.structuredContent)).toBeUndefined();
    const output = done.structuredContent as SearchReviewsOutput;
    expect(output.sources_used).toEqual(["amazon"]);
    expect(output.reviews.length).toBeGreaterThan(0);
    expect(output.sources_failed).toEqual([]);
  });

  it("an IP-level refusal (HTTP 403, empty body) never parks: blocked, with the IP sentence", async () => {
    const deps = makeDeps();
    const { client } = await connect(deps, "x-403");
    const out = await callTool(client, "social_search", { query: "claude code", platforms: ["x"], kind: "posts" });
    expect(out.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(out.structuredContent);
    expect(envelope.error.code).toBe("blocked");
    expect(envelope.error.message).toContain("403");
    expect(envelope.error.message).toContain(IP_REFUSED_HINT);
    expect(deps.handoffs?.list()).toEqual([]);
  });

  it("with the window hidden the login wall stays needs_login and the message says how to run", async () => {
    const headless = { ...config, browser: { ...config.browser, headless: true } };
    const hidden = createHandoffStore({ browser: session, config: headless, log: makeLog() });
    cleanups.push(() => hidden.close());
    const deps = makeDeps({ config: headless, handoffs: hidden });
    const { client } = await connect(deps, "x-gate");
    const out = await callTool(client, "social_search", { query: "claude code", platforms: ["x"], kind: "posts" });
    expect(out.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(out.structuredContent);
    expect(envelope.error.code).toBe("blocked");
    expect(envelope.error.message).toContain(HEADLESS_HINT);
    const failed = (envelope.error.details as { platforms_failed?: Array<{ needs_login: boolean }> } | undefined)?.platforms_failed;
    expect(failed?.[0]?.needs_login).toBe(true);
    expect(hidden.list()).toEqual([]);
  });

  it("accounts connect parks the login page as a handoff that resume and list both pick up", async () => {
    const deps = makeDeps();
    const { client } = await connect(deps, "x-ok");
    // The platform table is the real one, so no cookie can appear: the login stays pending.
    const out = await callTool(client, "accounts", { action: "connect", platform: "reddit", wait_seconds: 0 });
    expect(out.isError, JSON.stringify(out.structuredContent)).toBeUndefined();
    const pending = out.structuredContent as { status: string; handoff_id?: string; instructions: string };
    expect(pending.status).toBe("pending");
    expect(pending.handoff_id).toMatch(/^h_/);
    expect(pending.instructions).toContain("resume");
    const health = (await callTool(client, "health")).structuredContent as { handoffs: { parked: number; sites: string[] } };
    expect(health.handoffs).toEqual({ parked: 1, sites: ["reddit"] });

    const still = await callTool(client, "resume", { handoff_id: pending.handoff_id, wait_seconds: 0 });
    expect((still.structuredContent as PausedOutput).handoff).toMatchObject({ tool: "accounts", site: "reddit", reason: "login_required" });
    const listed = (await callTool(client, "accounts", { action: "list" })).structuredContent as { caveats: string[] };
    expect(listed.caveats.join(" ")).toMatch(/login page is still open for: reddit/);

    const cancelled = await callTool(client, "resume", { handoff_id: pending.handoff_id, cancel: true });
    expect(cancelled.structuredContent).toEqual({ cancelled: true, handoff_id: pending.handoff_id });
    expect(deps.handoffs?.list()).toEqual([]);
  }, 45_000);
});
