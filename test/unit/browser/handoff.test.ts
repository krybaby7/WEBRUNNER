import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../src/config.js";
import { createHandoffStore, HandoffError, MAX_PARKED } from "../../../src/core/browser/handoff.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession, HandoffHooks, HandoffStore, ParkRequest } from "../../../src/core/browser/types.js";
import { classifyWall, HEADLESS_HINT, IP_REFUSED_HINT, whatToDoFor, windowHidden, type WallProbe } from "../../../src/core/browser/walls.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../../src/core/llm/types.js";
import type { Deps } from "../../../src/deps.js";
import type { Logger } from "../../../src/log.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { PausedOutputSchema, type PausedOutput } from "../../../src/schemas/handoff.js";
import { registerBrowseTaskTool } from "../../../src/tools/browse_task.js";
import { registerHealthTool } from "../../../src/tools/health.js";
import { TOOL_NAMES } from "../../../src/tools/index.js";
import { registerResumeTool } from "../../../src/tools/resume.js";
import { spyPage, type PageSpy } from "../social/browser/helpers.js";
import { callTool, connectServer, type Connected } from "../tools/helpers.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "./helpers.js";

/**
 * The human handoff, PLAN.md section 16 (WP45): the generic wall classifier,
 * the HandoffStore on real Chromium against a local site whose walls the test
 * "clears" by swapping the served page, and browse_task pausing at a CAPTCHA
 * and finishing through resume with its step count intact.
 */

// -- the classifier (no browser) --------------------------------------------------------------------------------------

function probe(over: Partial<WallProbe> = {}): WallProbe {
  return {
    url: "https://www.example.com/shop",
    title: "Shop",
    text: "Welcome to the shop. Plenty of products below.",
    textLength: 5000,
    captchaWidgets: 0,
    passwordFields: 0,
    codeFields: 0,
    ...over,
  };
}

describe("classifyWall", () => {
  it.each([
    ["a CAPTCHA widget", probe({ captchaWidgets: 1 }), "captcha"],
    ["CAPTCHA text on a short page", probe({ text: "Please verify you are human", textLength: 30 }), "captcha"],
    ["a press-and-hold check", probe({ text: "Press & Hold to confirm you are a human", textLength: 60 }), "captcha"],
    ["a Facebook checkpoint URL", probe({ url: "https://www.facebook.com/checkpoint/1501092823525282/?next=x" }), "checkpoint"],
    ["an X account access URL", probe({ url: "https://x.com/account/access" }), "checkpoint"],
    ["Amazon's bot check URL", probe({ url: "https://www.amazon.com/errors/validateCaptcha?x=1" }), "checkpoint"],
    ["Google's sorry page", probe({ url: "https://www.google.com/sorry/index?continue=x" }), "checkpoint"],
    ["Google's unusual traffic text", probe({ text: "Our systems have detected unusual traffic from your computer network.", textLength: 200 }), "checkpoint"],
    ["a Cloudflare challenge", probe({ title: "Just a moment...", text: "Checking your browser before accessing", textLength: 50 }), "ip_refusal"],
    ["an access denied page", probe({ title: "Access denied", text: "", textLength: 0 }), "ip_refusal"],
    ["a blocked page", probe({ text: "You have been blocked", textLength: 30 }), "ip_refusal"],
    ["Google's consent page", probe({ url: "https://consent.google.com/m", text: "Before you continue to Google. We use cookies...", textLength: 800 }), "consent"],
    ["a one-time code form", probe({ codeFields: 1, text: "Enter the verification code we sent to your phone", textLength: 300 }), "mfa"],
    ["a login form on a short page", probe({ passwordFields: 1, textLength: 300 }), "login_required"],
  ])("classifies %s", (_name, p, kind) => {
    expect(classifyWall(p)?.kind).toBe(kind);
  });

  it("is quiet on an ordinary page, a long article that mentions CAPTCHAs, and a long page with a login widget", () => {
    expect(classifyWall(probe())).toBeUndefined();
    expect(classifyWall(probe({ text: "How CAPTCHA works ...", textLength: 20_000 }))).toBeUndefined();
    expect(classifyWall(probe({ passwordFields: 1, textLength: 40_000 }))).toBeUndefined();
    expect(classifyWall(probe({ codeFields: 1, textLength: 300 }))).toBeUndefined();
  });

  it("lets a login page through when the caller says logins are not walls", () => {
    expect(classifyWall(probe({ passwordFields: 1, textLength: 300 }), { loginIsWall: false })).toBeUndefined();
  });

  it("writes what_to_do naming the window, and tells a hidden window from a visible one", () => {
    expect(whatToDoFor("captcha", "x", "Chrome you attached")).toMatch(/Solve the CAPTCHA on the x page in the Chrome you attached/);
    expect(whatToDoFor("login_required", "x", "webrunner browser window")).toMatch(/never types/);
    for (const reason of ["checkpoint", "consent", "mfa", "unknown_wall"] as const) expect(whatToDoFor(reason, "x", "w")).toMatch(/resume/);
    const base = makeConfig("/tmp/p");
    expect(windowHidden({ ...base, browser: { ...base.browser, headless: true } })).toBe(true);
    expect(windowHidden({ ...base, browser: { ...base.browser, headless: false } })).toBe(false);
    expect(windowHidden({ ...base, browser: { ...base.browser, headless: true, cdp_url: "http://127.0.0.1:9222" } })).toBe(false);
  });
});

// -- a site whose walls the test can clear -----------------------------------------------------------------------------------

interface WallSite {
  url: string;
  /** Which wall `/gate` serves; `none` serves the results page. */
  gate: "captcha" | "login" | "mfa" | "ip" | "none";
  close(): Promise<void>;
}

const CAPTCHA_PAGE = `<!doctype html><title>One more step</title><h1>Checking your browser</h1><p>Please verify you are human to continue.</p>
<div class="g-recaptcha" data-sitekey="fixture" style="width:304px;height:78px;border:1px solid #ccc"></div>`;
const LOGIN_PAGE = `<!doctype html><title>Sign in</title><h1>Sign in to continue</h1><form><label>Email <input name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form>`;
const MFA_PAGE = `<!doctype html><title>Verify</title><h1>Two-step verification</h1><p>Enter the verification code we sent to your phone.</p><form><input autocomplete="one-time-code" inputmode="numeric" maxlength="6" name="code"><button>Continue</button></form>`;
const RESULTS_PAGE = `<!doctype html><title>Results</title><h1>Laptops</h1><ul><li>Laptop Pro 14: $1299</li><li>Laptop Air 13: $999.50</li></ul>`;
const INDEX_PAGE = `<!doctype html><title>Mini Shop</title><h1>Mini Shop</h1><p>Welcome.</p><nav><a href="/gate">Open results</a></nav>`;

async function startWallSite(): Promise<WallSite> {
  const site = { gate: "captcha" } as WallSite;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    if (path === "/index.html") return html(INDEX_PAGE);
    if (path === "/gate") {
      switch (site.gate) {
        case "captcha":
          return html(CAPTCHA_PAGE);
        case "login":
          return html(LOGIN_PAGE);
        case "mfa":
          return html(MFA_PAGE);
        case "ip":
          return html("<!doctype html><title>Access denied</title><p>Forbidden</p>", 403);
        case "none":
          return html(RESULTS_PAGE);
      }
    }
    if (path === "/results") return html(RESULTS_PAGE);
    return html("<title>Not found</title>", 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  site.url = `http://127.0.0.1:${port}`;
  site.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return site;
}

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** An LlmClient that answers from a queue; a function reply sees the request so it can pick a ref from the tree. */
class ScriptedLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly queue: Array<unknown | ((req: LlmRequest) => unknown)>) {}

  complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error(`scripted LLM queue is empty (call ${this.calls.length})`));
    const parsed = typeof next === "function" ? (next as (r: LlmRequest) => unknown)(req) : next;
    return Promise.resolve({ parsed, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, model: "scripted", stopReason: "end_turn" });
  }
}

function promptText(req: LlmRequest): string {
  const content = req.messages[0]?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function refOf(req: LlmRequest, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] \\S+ "${name}"`).exec(promptText(req));
  if (m?.[1] === undefined) throw new Error(`no "${name}" in the tree:\n${promptText(req)}`);
  return m[1];
}

/**
 * A session whose pages are spied on: every page it hands out records any
 * typing call, so the test can assert the handoff path typed nothing.
 */
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

const chromium = await probeChromium();

describe.skipIf(!chromium.available)(`HandoffStore${chromium.available ? "" : ` (${chromium.reason})`}`, () => {
  let site: WallSite;
  let profileDir: string;
  let config: Config;
  let real: BrowserSession;
  let session: BrowserSession;
  let spies: PageSpy[];
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    site = await startWallSite();
    profileDir = await makeTempDir();
    config = { ...makeConfig(profileDir), handoff_ttl_ms: 60_000 };
    real = createBrowserSession(config);
    ({ session, spies } = spiedSession(real));
  }, 30_000);

  afterAll(async () => {
    await real?.close();
    await site?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  beforeEach(() => {
    site.gate = "captcha";
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
    expect(session.stats().activePages).toBe(0);
    expect(spies.flatMap((s) => s.forbidden)).toEqual([]);
  });

  function store(over: Partial<Parameters<typeof createHandoffStore>[0]> = {}): HandoffStore {
    const s = createHandoffStore({ browser: session, config, log: makeLog(), assumeDisplay: true, sleep: () => Promise.resolve(), ...over });
    cleanups.push(() => s.close());
    return s;
  }

  /** Open `/gate` on a pooled page, as a tool would before meeting the wall. */
  async function pageAtGate(): Promise<Page> {
    const page = await session.acquire();
    await page.goto(`${site.url}/gate`, { waitUntil: "domcontentloaded" });
    return page;
  }

  function park(s: HandoffStore, page: Page, over: Partial<ParkRequest> = {}) {
    return s.park({
      page,
      tool: "browse_task",
      site: "127.0.0.1",
      url: page.url(),
      reason: "captcha",
      whatToDo: "Solve the CAPTCHA in the window, then resume.",
      step: "step 2 of 15",
      continue: async (hooks: HandoffHooks) => {
        expect(hooks.parked?.page).toBe(page);
        expect(hooks.isParked(page)).toBe(true);
        await page.goto(`${site.url}/gate`, { waitUntil: "domcontentloaded" });
        return { outcome: "completed", title: await page.title() };
      },
      ...over,
    });
  }

  it("can pause only when a human can see the window: headful persistent or CDP, never headless persistent", () => {
    const headless = { ...config, browser: { ...config.browser, headless: true } };
    expect(createHandoffStore({ browser: session, config: headless, log: makeLog() }).canPause()).toBe(false);
    expect(createHandoffStore({ browser: session, config: { ...headless, browser: { ...headless.browser, headless: false } }, log: makeLog() }).canPause()).toBe(true);
    expect(createHandoffStore({ browser: session, config: { ...headless, browser: { ...headless.browser, cdp_url: "http://127.0.0.1:9222" } }, log: makeLog() }).canPause()).toBe(true);
    expect(store().canPause()).toBe(true);
  });

  it("parks a page outside the pool, lists it by name, and finishes through resume once the wall is gone", async () => {
    const s = store();
    const page = await pageAtGate();
    expect(session.stats().activePages).toBe(1);

    const record = park(s, page);
    expect(session.stats().activePages).toBe(0);
    expect(page.isClosed()).toBe(false);
    expect(record.id).toMatch(/^h_[0-9a-f]{8}$/);
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(60_000);
    expect(s.list()).toEqual([{ id: record.id, tool: "browse_task", site: "127.0.0.1", reason: "captcha", expires_at: record.expiresAt }]);
    expect(PausedOutputSchema.safeParse({ paused: true, handoff: record.toHandoff() }).success).toBe(true);
    expect(record.toHandoff()).toMatchObject({ tool: "browse_task", site: "127.0.0.1", url: `${site.url}/gate`, reason: "captcha", step: "step 2 of 15" });

    // Still walled: paused again, same id, what_to_do says so.
    const still = await s.resume(record.id, 0);
    expect(still.kind).toBe("paused");
    if (still.kind === "paused") {
      expect(still.handoff.id).toBe(record.id);
      expect(still.handoff.what_to_do).toMatch(/still shows the wall/);
    }

    // The owner clears the wall; the next probe sees the results page and the continuation runs on the parked page.
    site.gate = "none";
    await page.reload({ waitUntil: "domcontentloaded" });
    const done = await s.resume(record.id, 0);
    expect(done).toEqual({ kind: "finished", output: { outcome: "completed", title: "Results" } });
    expect(page.isClosed()).toBe(true);
    expect(s.list()).toEqual([]);
    expect(await s.resume(record.id, 0)).toEqual({ kind: "unknown" });
  });

  it("re-parks the same handoff when the continuation meets the wall again", async () => {
    const s = store();
    const page = await pageAtGate();
    let runs = 0;
    const record = park(s, page, {
      continue: async (hooks) => {
        runs++;
        await hooks.pause(page, "127.0.0.1", "checkpoint", "Complete the check, then resume.", "step 3 of 15");
        return { outcome: "blocked" };
      },
    });
    site.gate = "none";
    await page.reload({ waitUntil: "domcontentloaded" });
    const again = await s.resume(record.id, 0);
    expect(runs).toBe(1);
    expect(again.kind).toBe("paused");
    if (again.kind === "paused") expect(again.handoff).toMatchObject({ id: record.id, reason: "checkpoint", step: "step 3 of 15" });
    expect(page.isClosed()).toBe(false);
    expect(s.list()).toHaveLength(1);
  });

  it("waits, probing every poll, and gives up with paused when the wall stays", async () => {
    const sleeps: number[] = [];
    let t = 1_000_000;
    const s = store({
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
      pollMs: 2000,
    });
    const page = await pageAtGate();
    const record = park(s, page);
    const out = await s.resume(record.id, 5);
    expect(out.kind).toBe("paused");
    expect(sleeps).toEqual([2000, 2000, 1000]);
  });

  it(`refuses a ${MAX_PARKED + 1}th park with a provider error naming the parked sites`, async () => {
    const s = store();
    const pages = [await pageAtGate(), await pageAtGate(), await pageAtGate()];
    const records = pages.map((p, i) => park(s, p, { site: `site-${i}` }));
    const extra = await pageAtGate();
    try {
      expect(() => park(s, extra, { site: "fourth" })).toThrow(HandoffError);
      expect(() => park(s, extra, { site: "fourth" })).toThrow(/3 handoffs are already parked: site-0 \(h_[0-9a-f]+\), site-1 .*, site-2 .*\. Resume or cancel/);
    } finally {
      await session.release(extra);
    }
    expect(records).toHaveLength(3);
    expect(s.list().map((r) => r.site)).toEqual(["site-0", "site-1", "site-2"]);
  });

  it("expiry closes the page and resume then says expired", async () => {
    const s = store();
    const short = createHandoffStore({ browser: session, config: { ...config, handoff_ttl_ms: 300 }, log: makeLog(), assumeDisplay: true });
    cleanups.push(() => short.close());
    const page = await pageAtGate();
    const record = park(short, page);
    await new Promise((r) => setTimeout(r, 700));
    expect(page.isClosed()).toBe(true);
    expect(short.list()).toEqual([]);
    expect(await short.resume(record.id, 0)).toEqual({ kind: "expired" });
    expect(await s.resume(record.id, 0)).toEqual({ kind: "unknown" });
  });

  it("cancel closes the page; a page the owner closed by hand counts as cancelled; close() cleans up everything", async () => {
    const s = store();
    const a = await pageAtGate();
    const b = await pageAtGate();
    const c = await pageAtGate();
    const [ra, rb, rc] = [park(s, a), park(s, b), park(s, c)];

    expect(await s.cancel(ra.id)).toBe(true);
    expect(a.isClosed()).toBe(true);
    expect(await s.cancel(ra.id)).toBe(false);
    expect(await s.resume(ra.id, 0)).toEqual({ kind: "unknown" });

    await b.close();
    expect(await s.resume(rb.id, 0)).toEqual({ kind: "cancelled" });

    await s.close();
    expect(c.isClosed()).toBe(true);
    expect(s.list()).toEqual([]);
    expect(await s.resume(rc.id, 0)).toEqual({ kind: "unknown" });
    expect(s.canPause()).toBe(false);
  });

  it("uses the record's own cleared check when one is given, and the generic one for a login wall otherwise", async () => {
    const s = store();
    site.gate = "login";
    const page = await pageAtGate();
    let cleared = false;
    const custom = park(s, page, { reason: "login_required", cleared: () => Promise.resolve(cleared), continue: () => Promise.resolve({ ok: true }) });
    expect((await s.resume(custom.id, 0)).kind).toBe("paused");
    cleared = true;
    expect(await s.resume(custom.id, 0)).toEqual({ kind: "finished", output: { ok: true } });

    const page2 = await pageAtGate();
    const generic = park(s, page2, { reason: "login_required", continue: () => Promise.resolve({ ok: 2 }) });
    expect((await s.resume(generic.id, 0)).kind).toBe("paused");
    // "The owner logged in": the page moved on to the results.
    await page2.goto(`${site.url}/results`, { waitUntil: "domcontentloaded" });
    expect(await s.resume(generic.id, 0)).toEqual({ kind: "finished", output: { ok: 2 } });
  });

  // -- browse_task and resume through the tools --------------------------------------------------------------------------

  describe("browse_task through the tools", () => {
    let connected: Connected;

    async function connect(deps: Partial<Deps> = {}): Promise<Connected> {
      const full: Deps = {
        config,
        log: makeLog(),
        browser: session,
        llm: new ScriptedLlm([]),
        llmInfo: { backend: "api", fallback: "none" },
        handoffs: store(),
        ...deps,
      };
      connected = await connectServer((server) => {
        registerBrowseTaskTool(server, full);
        registerResumeTool(server, full);
        registerHealthTool(server, full, TOOL_NAMES);
      });
      cleanups.push(() => connected.close());
      return connected;
    }

    it("pauses at a CAPTCHA with the step it stopped on, and resume finishes the run with its step count intact", async () => {
      const llm = new ScriptedLlm([
        (req: LlmRequest) => ({ action: "click", ref: refOf(req, "Open results") }),
        (req: LlmRequest) => {
          // The continued run is at step 2, with the click in its history and the results page in front of it.
          expect(promptText(req)).toMatch(/Step 2 of 15/);
          expect(promptText(req)).toMatch(/1\. click e\d+ "Open results" -> ok/);
          expect(promptText(req)).toMatch(/Laptop Pro 14/);
          return { action: "done", summary: "The Laptop Pro 14 costs $1299." };
        },
      ]);
      const { client } = await connect({ llm });

      const first = await callTool(client, "browse_task", { goal: "Find the price of the Laptop Pro 14", start_url: `${site.url}/index.html` });
      expect(first.isError).toBeUndefined();
      const paused = first.structuredContent as PausedOutput;
      expect(PausedOutputSchema.safeParse(paused).success, JSON.stringify(first.structuredContent)).toBe(true);
      expect(paused.handoff).toMatchObject({ tool: "browse_task", site: "127.0.0.1", url: `${site.url}/gate`, reason: "captcha", step: "step 2 of 15" });
      expect(paused.handoff.what_to_do).toMatch(/Solve the CAPTCHA on the 127\.0\.0\.1 page in the webrunner browser window/);
      expect(JSON.parse(first.content[0]?.text ?? "{}")).toEqual(paused);
      expect(session.stats().activePages).toBe(0);
      expect(llm.calls).toHaveLength(1);

      const health = (await callTool(client, "health")).structuredContent as { handoffs: { parked: number; sites: string[] } };
      expect(health.handoffs).toEqual({ parked: 1, sites: ["127.0.0.1"] });

      // Still walled.
      const again = await callTool(client, "resume", { handoff_id: paused.handoff.id, wait_seconds: 0 });
      expect(again.isError).toBeUndefined();
      expect((again.structuredContent as PausedOutput).handoff.id).toBe(paused.handoff.id);
      expect((again.structuredContent as PausedOutput).handoff.what_to_do).toMatch(/still shows the wall/);

      // The owner solves it: the page moves on to the results.
      site.gate = "none";
      await reloadParkedPage();
      const done = await callTool(client, "resume", { handoff_id: paused.handoff.id, wait_seconds: 0 });
      expect(done.isError, JSON.stringify(done.structuredContent)).toBeUndefined();
      expect(done.structuredContent).toMatchObject({
        goal: "Find the price of the Laptop Pro 14",
        outcome: "completed",
        summary: "The Laptop Pro 14 costs $1299.",
        final_url: `${site.url}/gate`,
        steps_taken: 1,
      });
      expect(llm.calls).toHaveLength(2);
      expect(((await callTool(client, "health")).structuredContent as { handoffs: { parked: number } }).handoffs.parked).toBe(0);
      expect(ErrorEnvelopeSchema.safeParse((await callTool(client, "resume", { handoff_id: paused.handoff.id })).structuredContent).success).toBe(true);
    });

    /** The parked page is the last page open in the context; reload it as the owner's solved CAPTCHA would. */
    async function reloadParkedPage(): Promise<void> {
      const pages = spies.map((s) => s.page).filter((p) => !p.isClosed());
      const page = pages.at(-1);
      if (page === undefined) throw new Error("no parked page");
      await page.reload({ waitUntil: "domcontentloaded" });
    }

    it("pauses at a one-time code and at a login wall, and never at an IP-level refusal", async () => {
      const { client } = await connect();
      site.gate = "mfa";
      const mfa = (await callTool(client, "browse_task", { goal: "Find the price", start_url: `${site.url}/gate` })).structuredContent as PausedOutput;
      expect(mfa.paused).toBe(true);
      expect(mfa.handoff).toMatchObject({ reason: "mfa", step: "step 1 of 15" });
      expect(mfa.handoff.what_to_do).toMatch(/verification code/);
      await callTool(client, "resume", { handoff_id: mfa.handoff.id, cancel: true });

      site.gate = "login";
      const login = (await callTool(client, "browse_task", { goal: "Find the price", start_url: `${site.url}/gate` })).structuredContent as PausedOutput;
      expect(login.handoff).toMatchObject({ reason: "login_required" });
      expect(login.handoff.what_to_do).toMatch(/Sign in to 127\.0\.0\.1 .* never types/);
      const cancelled = await callTool(client, "resume", { handoff_id: login.handoff.id, cancel: true });
      expect(cancelled.structuredContent).toEqual({ cancelled: true, handoff_id: login.handoff.id });

      site.gate = "ip";
      const ip = (await callTool(client, "browse_task", { goal: "Find the price", start_url: `${site.url}/gate` })).structuredContent as { outcome: string; blocked_reason?: string; summary: string };
      expect(ip).toMatchObject({ outcome: "blocked", blocked_reason: "bot_wall" });
      expect(ip.summary).toContain(IP_REFUSED_HINT);
      expect(((await callTool(client, "health")).structuredContent as { handoffs: { parked: number } }).handoffs.parked).toBe(0);
    });

    it("never pauses when the window is hidden: the run is blocked and the message says how to", async () => {
      const headless = { ...config, browser: { ...config.browser, headless: true } };
      const hidden = createHandoffStore({ browser: session, config: headless, log: makeLog() });
      cleanups.push(() => hidden.close());
      const { client } = await connect({ config: headless, handoffs: hidden });
      const out = (await callTool(client, "browse_task", { goal: "Find the price", start_url: `${site.url}/gate` })).structuredContent as { outcome: string; blocked_reason?: string; summary: string };
      expect(out).toMatchObject({ outcome: "blocked", blocked_reason: "captcha" });
      expect(out.summary).toContain(HEADLESS_HINT);
      expect(hidden.list()).toEqual([]);
    });

    it("refuses a fourth handoff with a provider error naming the parked sites, and frees nothing", async () => {
      const { client } = await connect();
      const ids: string[] = [];
      for (let i = 0; i < MAX_PARKED; i++) {
        const out = (await callTool(client, "browse_task", { goal: "Find the price", start_url: `${site.url}/gate` })).structuredContent as PausedOutput;
        ids.push(out.handoff.id);
      }
      const fourth = await callTool(client, "browse_task", { goal: "Find the price", start_url: `${site.url}/gate` });
      expect(fourth.isError).toBe(true);
      const envelope = ErrorEnvelopeSchema.parse(fourth.structuredContent);
      expect(envelope.error.code).toBe("provider");
      expect(envelope.error.message).toMatch(/3 handoffs are already parked/);
      expect(session.stats().activePages).toBe(0);
      for (const id of ids) await callTool(client, "resume", { handoff_id: id, cancel: true });
    });

    it("resume answers invalid_input for an unknown id and for cancelling one", async () => {
      const { client } = await connect();
      const unknown = await callTool(client, "resume", { handoff_id: "h_00000000" });
      expect(unknown.isError).toBe(true);
      expect(ErrorEnvelopeSchema.parse(unknown.structuredContent).error).toMatchObject({ code: "invalid_input", retryable: false });
      expect(ErrorEnvelopeSchema.parse(unknown.structuredContent).error.message).toContain("h_00000000");
      const cancel = await callTool(client, "resume", { handoff_id: "h_00000000", cancel: true });
      expect(ErrorEnvelopeSchema.parse(cancel.structuredContent).error.code).toBe("invalid_input");
    });
  });
});
