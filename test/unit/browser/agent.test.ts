import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Config } from "../../../src/config.js";
import {
  ActionSchema,
  DomainPolicy,
  deniedPathReason,
  purchaseDenyReason,
  sensitiveFieldReason,
  type ElementFacts,
} from "../../../src/core/browser/actions.js";
import {
  AGENT_SYSTEM_PROMPT,
  buildStepPrompt,
  classifyModelBlock,
  detectBlock,
  runBrowseTask,
  type BrowseTaskRunner,
} from "../../../src/core/browser/agent.js";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession, Snapshot } from "../../../src/core/browser/types.js";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "../../../src/core/llm/types.js";
import type { Deps } from "../../../src/deps.js";
import type { Logger } from "../../../src/log.js";
import { BrowseTaskInputSchema, BrowseTaskOutputSchema, type BrowseTaskOutput } from "../../../src/schemas/browse_task.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { JsonSchemaError } from "../../../src/core/browser/json-schema.js";
import { registerTools } from "../../../src/tools/index.js";
import { registerBrowseTaskTool } from "../../../src/tools/browse_task.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "./helpers.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/browser/agent/", import.meta.url));

// -- scripted model ------------------------------------------------------------------------------------

type Reply = unknown | ((req: LlmRequest) => unknown) | Error;

/** An LlmClient that answers from a queue, in order. A function reply sees the request, so it can pick refs from the tree. */
class ScriptedLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly queue: Reply[]) {}

  complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error(`scripted LLM queue is empty (call ${this.calls.length}, role ${req.role})`));
    if (next instanceof Error) return Promise.reject(next);
    const parsed = typeof next === "function" ? (next as (r: LlmRequest) => unknown)(req) : next;
    return Promise.resolve({
      parsed,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      model: "scripted",
      stopReason: "end_turn",
    });
  }

  get plannerCalls(): LlmRequest[] {
    return this.calls.filter((c) => c.role === "planner");
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

/** Find the ref of the tree line with this (exact) name, in the request's prompt. */
function refOf(req: LlmRequest, name: string, role = "\\S+"): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${escaped}"`).exec(promptText(req));
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in the tree:\n${promptText(req)}`);
  return m[1];
}

const click = (name: string, role?: string) => (req: LlmRequest) => ({ action: "click", ref: refOf(req, name, role) });

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, price: { type: "number" }, stock: { type: "integer" } },
        required: ["name", "price", "stock"],
      },
    },
  },
  required: ["products"],
};
const PRODUCTS = [
  { name: "Laptop Pro 14", price: 1299, stock: 12 },
  { name: "Laptop Air 13", price: 999.5, stock: 0 },
  { name: "Laptop Mini 11", price: 549.99, stock: 31 },
];

// -- local mini site -----------------------------------------------------------------------------------------

interface Site {
  /** http://127.0.0.1:port */
  url: string;
  /** Same server under another hostname, for off-domain tests. */
  otherUrl: string;
  bought: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  let other = "";
  const site = { bought: 0 } as Site;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      try {
        if (path === "/__bought") {
          site.bought++;
          res.writeHead(204).end();
        } else if (path === "/download.bin") {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="prices.bin"' });
          res.end("binary");
        } else if (/^\/[\w-]+\.html$/.test(path)) {
          const body = (await readFile(join(FIXTURE_DIR, path.slice(1)), "utf8")).replaceAll("__OTHER_ORIGIN__", other);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
        } else {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        }
      } catch {
        res.writeHead(500).end("fixture error");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  other = `http://localhost:${port}`;
  site.url = `http://127.0.0.1:${port}`;
  site.otherUrl = other;
  site.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return site;
}

function makeLog(): Logger & { warn: Mock<Logger["warn"]> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn<Logger["warn"]>(), error: vi.fn() };
}

// -- pure pieces (no browser) ---------------------------------------------------------------------------------

function facts(over: Partial<ElementFacts> = {}): ElementFacts {
  return {
    tag: "button",
    type: "",
    name: "",
    id: "",
    autocomplete: "",
    ariaLabel: "",
    title: "",
    placeholder: "",
    buttonValue: "",
    text: "",
    href: "",
    hasDownloadAttr: false,
    form: null,
    ...over,
  };
}

describe("deny rules", () => {
  it.each([
    ["Buy now", true],
    ["Pay $20", true],
    ["Place order", true],
    ["Confirm purchase", true],
    ["Confirm booking", true],
    ["Book now", true],
    ["Subscribe", true],
    ["Donate", true],
    ["Submit payment", true],
    ["Complete order", true],
    ["Proceed to checkout", true],
    ["Add to wishlist", false],
    ["Search", false],
    ["Next page", false],
    ["Buyer guide", false],
    ["Payload size", false],
    ["Booking history", false],
  ])("button named %j is refused: %s", (name, denied) => {
    const reason = purchaseDenyReason(facts({ text: name }), name, "https://shop.test/products");
    expect(reason !== undefined).toBe(denied);
  });

  it("checks the surrounding form, including the text of its buttons and its action", () => {
    const form = { id: "", name: "", action: "", label: "", buttons: ["Continue", "Pay now"] };
    expect(purchaseDenyReason(facts({ text: "Continue", form }), "Continue", "https://s.test/cart")).toMatch(/surrounding form/);
    const post = { id: "", name: "", action: "/checkout/submit", label: "", buttons: ["Go"] };
    expect(purchaseDenyReason(facts({ text: "Go", form: post }), "Go", "https://s.test/cart")).toMatch(/payment URL/);
    const harmless = { id: "q", name: "", action: "/search", label: "Site search", buttons: ["Search"] };
    expect(purchaseDenyReason(facts({ text: "Search", form: harmless }), "Search", "https://s.test/")).toBeUndefined();
  });

  it("never reads typed text, only button labels", () => {
    // A search for "buy milk" must not trip the deny list; the input's value is not part of the facts at all.
    const input = facts({ tag: "input", type: "search", name: "q" });
    expect(purchaseDenyReason(input, "Search products", "https://s.test/")).toBeUndefined();
    expect(purchaseDenyReason(facts({ tag: "input", type: "submit", buttonValue: "Buy now" }), "", "https://s.test/")).toMatch(/matches/);
  });

  it.each([
    ["https://s.test/checkout", true],
    ["https://s.test/checkout/step-2", true],
    ["https://s.test/cart/payment", true],
    ["https://s.test/payments/methods", true],
    ["https://s.test/account/billing", true],
    ["https://s.test/pay", true],
    ["https://s.test/pay-now", true],
    ["https://s.test/order/confirm", true],
    ["https://s.test/order/confirmation/123", true],
    ["https://s.test/products?next=/checkout", false],
    ["https://s.test/display", false],
    ["https://s.test/payload", false],
    ["https://s.test/repay", false],
    ["https://s.test/orders/history", false],
    ["not a url", false],
  ])("page path %s is a payment flow: %s", (url, denied) => {
    expect(deniedPathReason(url) !== undefined).toBe(denied);
  });

  it("refuses any click on a page whose path is a payment flow", () => {
    expect(purchaseDenyReason(facts({ text: "Next" }), "Next", "https://s.test/checkout/shipping")).toMatch(/payment flow/);
  });

  it.each([
    [{ type: "password" }, true],
    [{ type: "text", autocomplete: "cc-number" }, true],
    [{ type: "text", autocomplete: "cc-csc" }, true],
    [{ type: "text", name: "cardnumber" }, true],
    [{ type: "text", name: "card_number" }, true],
    [{ type: "text", id: "credit-card" }, true],
    [{ type: "text", placeholder: "Card" }, true],
    [{ type: "text", name: "q" }, false],
    [{ type: "email", autocomplete: "email" }, false],
    [{ type: "text", name: "discard" }, false],
  ] as Array<[Partial<ElementFacts>, boolean]>)("typing into %j is refused: %s", (over, denied) => {
    expect(sensitiveFieldReason(facts({ tag: "input", ...over }), "") !== undefined).toBe(denied);
  });
});

describe("DomainPolicy", () => {
  it("enforces nothing until a host is adopted", () => {
    const policy = new DomainPolicy(false);
    expect(policy.refusal("https://anywhere.test/")).toBeUndefined();
    policy.adopt("https://www.example.com/start");
    expect(policy.refusal("https://example.com/x")).toBeUndefined();
    expect(policy.refusal("https://shop.example.com/x")).toBeUndefined();
    expect(policy.refusal("https://example.org/")).toMatch(/off the start domain/);
    expect(policy.refusal("https://notexample.com/")).toMatch(/off the start domain/);
  });

  it("allows everything when off-domain navigation is allowed", () => {
    const policy = new DomainPolicy(true);
    policy.adopt("https://a.test/");
    expect(policy.refusal("https://b.test/")).toBeUndefined();
  });
});

describe("block detection", () => {
  const page = (over: Partial<Parameters<typeof detectBlock>[0]> = {}): Parameters<typeof detectBlock>[0] => ({
    title: "Shop",
    text: "Welcome to the shop. Plenty of products below.",
    textLength: 5000,
    captchaWidgets: 0,
    passwordFields: 0,
    ...over,
  });

  it("recognizes CAPTCHAs by widget, title and short-page text", () => {
    expect(detectBlock(page({ captchaWidgets: 1 }), "g")?.reason).toBe("captcha");
    expect(detectBlock(page({ title: "reCAPTCHA check" }), "g")?.reason).toBe("captcha");
    expect(detectBlock(page({ text: "Please verify you are human", textLength: 30 }), "g")?.reason).toBe("captcha");
    expect(detectBlock(page({ text: "hCaptcha challenge", textLength: 30 }), "g")?.reason).toBe("captcha");
    expect(detectBlock(page({ text: "cf-turnstile loading", textLength: 30 }), "g")?.reason).toBe("captcha");
  });

  it("does not flag a long article that mentions CAPTCHAs", () => {
    expect(detectBlock(page({ text: "How CAPTCHA works ...", textLength: 20_000 }), "g")).toBeUndefined();
  });

  it("recognizes bot walls", () => {
    expect(detectBlock(page({ title: "Just a moment...", text: "Checking your browser before accessing x.com", textLength: 50 }), "g")?.reason).toBe("bot_wall");
    expect(detectBlock(page({ title: "Access denied", text: "", textLength: 0 }), "g")?.reason).toBe("bot_wall");
  });

  it("recognizes login walls unless the goal is about logging in or the page is large", () => {
    const login = page({ passwordFields: 1, textLength: 200 });
    expect(detectBlock(login, "find the price of a laptop")?.reason).toBe("login_required");
    expect(detectBlock(login, "log in and read my profile")).toBeUndefined();
    expect(detectBlock(login, "check the Sign In flow")).toBeUndefined();
    expect(detectBlock(page({ passwordFields: 1, textLength: 40_000 }), "find the price")).toBeUndefined();
  });

  it("is quiet on an ordinary page", () => {
    expect(detectBlock(page(), "find the price")).toBeUndefined();
  });

  it.each([
    ["Solve the CAPTCHA to continue", "captcha"],
    ["The site requires you to log in", "login_required"],
    ["Access denied by the server", "bot_wall"],
    ["There are no flights on that date", undefined],
  ])("classifies the model's blocked reason %j as %s", (reason, expected) => {
    expect(classifyModelBlock(reason)).toBe(expected);
  });
});

describe("action schema and prompts", () => {
  it("accepts each action and rejects malformed ones", () => {
    const good = [
      { action: "click", ref: "e1" },
      { action: "type", ref: "e2", text: "hi", submit: true },
      { action: "select", ref: "e3", value: "a" },
      { action: "navigate", url: "https://a.test/" },
      { action: "scroll", direction: "down" },
      { action: "scroll", direction: "up", amount: 200 },
      { action: "wait", ms: 500 },
      { action: "screenshot" },
      { action: "extract" },
      { action: "done", summary: "ok" },
      { action: "blocked", reason: "no" },
    ];
    for (const a of good) expect(ActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(true);
    for (const a of [{ action: "click" }, { action: "fly" }, { action: "scroll", direction: "left" }, { action: "done" }, {}]) {
      expect(ActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(false);
    }
  });

  it("keeps the system prompt free of step-specific content and puts the goal in the user message", () => {
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/Step \d|Current URL/);
    const snapshot = { url: "https://a.test/", title: "A", axTree: '[e1] button "Go"', refs: new Map(), refInfo: new Map() } as Snapshot;
    const text = buildStepPrompt({
      goal: "find the thing",
      step: 3,
      maxSteps: 15,
      snapshot,
      history: [{ step: 1, action: "click e1", status: "ok", message: "clicked" }],
      extractSchema: { type: "object" },
      allowOffDomain: false,
      hasScreenshot: false,
    });
    expect(text).toContain("Goal: find the thing");
    expect(text).toContain("Step 3 of 15");
    expect(text).toContain("Current URL: https://a.test/");
    expect(text).toContain('[e1] button "Go"');
    expect(text).toContain("1. click e1 -> ok: clicked");
    expect(text).toContain('{"type":"object"}');
    expect(text).toContain("refused");
  });
});

describe("browse_task input schema", () => {
  it("applies the documented defaults and limits", () => {
    const parsed = BrowseTaskInputSchema.parse({ goal: "  g  " });
    expect(parsed).toEqual({ goal: "g", max_steps: 15, allow_navigation_off_domain: false, max_cost_usd: 1 });
    expect(BrowseTaskInputSchema.safeParse({ goal: "g", max_steps: 40 }).success).toBe(true);
    expect(BrowseTaskInputSchema.safeParse({ goal: "g", max_steps: 41 }).success).toBe(false);
    expect(BrowseTaskInputSchema.safeParse({ goal: "g", max_steps: 0 }).success).toBe(false);
    expect(BrowseTaskInputSchema.safeParse({ goal: "" }).success).toBe(false);
    expect(BrowseTaskInputSchema.safeParse({ goal: "g", start_url: "file:///etc/passwd" }).success).toBe(false);
    expect(BrowseTaskInputSchema.safeParse({ goal: "g", max_cost_usd: 0 }).success).toBe(false);
  });
});

// -- the agent against a real browser ---------------------------------------------------------------------------------

const probe = await probeChromium();

describe.skipIf(!probe.available)(`runBrowseTask${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let site: Site;
  let session: BrowserSession;
  let profileDir: string;
  let shotDir: string;
  let log: ReturnType<typeof makeLog>;
  let config: Config;

  beforeAll(async () => {
    site = await startSite();
    profileDir = await makeTempDir();
    shotDir = await makeTempDir("webrunner-agent-shots-");
    config = makeConfig(profileDir);
    session = createBrowserSession(config);
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await site?.close();
    if (profileDir) await removeDir(profileDir);
    if (shotDir) await removeDir(shotDir);
  }, 30_000);

  beforeEach(() => {
    log = makeLog();
    site.bought = 0;
  });

  afterEach(() => {
    // Every run, whatever its outcome, hands its page back.
    expect(session.stats().activePages).toBe(0);
  });

  function run(
    input: Parameters<typeof runBrowseTask>[0],
    llm: LlmClient,
    extra: { config?: Config; screenshotDir?: string } = {},
  ): Promise<BrowseTaskOutput> {
    return runBrowseTask(input, {
      browser: session,
      llm,
      log,
      config: extra.config ?? config,
      ...(extra.screenshotDir !== undefined && { screenshotDir: extra.screenshotDir }),
    });
  }

  it("types into the form, clicks through to the results, extracts, and conforms to extract_schema", async () => {
    const llm = new ScriptedLlm([
      (req: LlmRequest) => ({ action: "type", ref: refOf(req, "Search products"), text: "laptop" }),
      click("Search", "button"),
      { action: "extract" },
      (req: LlmRequest) => {
        // The extractor sees the page text and the tree of the results page.
        expect(promptText(req)).toContain("Laptop Air 13");
        expect(promptText(req)).toContain("$549.99");
        return { products: PRODUCTS };
      },
    ]);
    const out = await run(
      { goal: "List the laptops with price and stock", start_url: `${site.url}/index.html`, extract_schema: ITEM_SCHEMA },
      llm,
    );

    expect(BrowseTaskOutputSchema.parse(out)).toEqual(out);
    expect(out.outcome).toBe("completed");
    expect(out.blocked_reason).toBeUndefined();
    expect(out.steps_taken).toBe(2);
    expect(out.extracted).toEqual({ products: PRODUCTS });
    expect(out.final_url).toBe(`${site.url}/results.html?q=laptop`);
    expect(out.screenshots).toBeUndefined();

    // Request shapes: planner at medium effort with the action union, a shared meter, a stable system prompt.
    const planner = llm.plannerCalls;
    expect(planner).toHaveLength(3);
    for (const call of planner) {
      expect(call).toMatchObject({ role: "planner", effort: "medium", maxTokens: 4096, system: AGENT_SYSTEM_PROMPT });
      expect(call.schema).toBeDefined();
      expect(call.meter).toBeDefined();
    }
    expect(new Set(llm.calls.map((c) => c.meter)).size).toBe(1);
    expect(llm.calls.at(-1)).toMatchObject({ role: "extractor", effort: "medium", maxTokens: 8192 });
    expect(promptText(planner[2] as LlmRequest)).toContain('typed "laptop"');
    expect(promptText(planner[0] as LlmRequest)).toContain("Goal: List the laptops with price and stock");
    expect(promptText(planner[0] as LlmRequest)).toContain("Step 1 of 15");
  });

  it("submits with Enter and follows a link, and answers from the page when no schema was given", async () => {
    const llm = new ScriptedLlm([
      (req: LlmRequest) => ({ action: "type", ref: refOf(req, "Search products"), text: "laptop", submit: true }),
      click("Back to the shop", "link"),
      click("All results", "link"),
      { action: "extract" },
      { answer: "Three laptops: Pro 14 ($1,299), Air 13 ($999.50, out of stock), Mini 11 ($549.99)." },
    ]);
    const out = await run({ goal: "What laptops are sold?", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.steps_taken).toBe(3);
    expect(out.summary).toContain("Three laptops");
    expect(out.extracted).toBeUndefined();
    expect(out.final_url).toBe(`${site.url}/results.html`);
  });

  it("refuses to click Buy now, logs it, tells the model, and carries on", async () => {
    const llm = new ScriptedLlm([
      click("Buy now", "button"),
      (req: LlmRequest) => {
        const text = promptText(req);
        expect(text).toMatch(/click e\d+ "Buy now" -> refused: click on e\d+ refused/);
        expect(text).toContain("purchase deny list");
        return click("All results", "link")(req);
      },
      { action: "done", summary: "Looked at the results instead of buying." },
    ]);
    const out = await run({ goal: "Buy a laptop", start_url: `${site.url}/index.html` }, llm);

    expect(site.bought).toBe(0);
    expect(out.outcome).toBe("completed");
    expect(out.steps_taken).toBe(1); // only the link click ran
    expect(out.final_url).toBe(`${site.url}/results.html`);
    expect(log.warn).toHaveBeenCalledWith(
      "browse_task refused a click",
      expect.objectContaining({ name: "Buy now", reason: expect.stringContaining("deny list") }),
    );
  });

  it("reports a stale or unknown ref to the model instead of throwing", async () => {
    const llm = new ScriptedLlm([
      { action: "click", ref: "e999" },
      (req: LlmRequest) => {
        expect(promptText(req)).toMatch(/click e999 -> failed: ref e999 is not in the current accessibility tree/);
        return { action: "done", summary: "gave up on that ref" };
      },
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.steps_taken).toBe(0);
  });

  it("stops at max_steps with a partial result and blocked_reason max_steps", async () => {
    const llm = new ScriptedLlm([
      { action: "scroll", direction: "down" },
      { action: "wait", ms: 10 },
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html`, max_steps: 2 }, llm);
    expect(out.outcome).toBe("partial");
    expect(out.blocked_reason).toBe("max_steps");
    expect(out.steps_taken).toBe(2);
    expect(out.summary).toContain("2 steps");
    expect(llm.calls).toHaveLength(2);
  });

  it("still extracts what the page shows when max_steps ends the run", async () => {
    const llm = new ScriptedLlm([click("All results", "link"), { products: PRODUCTS }]);
    const out = await run(
      { goal: "List laptops", start_url: `${site.url}/index.html`, max_steps: 1, extract_schema: ITEM_SCHEMA },
      llm,
    );
    expect(out.outcome).toBe("partial");
    expect(out.blocked_reason).toBe("max_steps");
    expect(out.extracted).toEqual({ products: PRODUCTS });
    expect(llm.calls.at(-1)?.role).toBe("extractor");
  });

  it("reports partial when the extracted data does not conform to extract_schema", async () => {
    const llm = new ScriptedLlm([
      click("All results", "link"),
      { action: "extract" },
      { products: [{ name: "Laptop Pro 14", price: "expensive", stock: 12 }] },
    ]);
    const out = await run({ goal: "List laptops", start_url: `${site.url}/index.html`, extract_schema: ITEM_SCHEMA }, llm);
    expect(out.outcome).toBe("partial");
    expect(out.extracted).toBeUndefined();
    expect(out.summary).toMatch(/Extraction failed: .*did not match extract_schema/);
  });

  it("also reports partial when the client itself rejects the structured output", async () => {
    const llm = new ScriptedLlm([
      { action: "extract" },
      new LlmError("provider", "schema", "Structured output did not match the expected schema", { retryable: false }),
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/results.html`, extract_schema: ITEM_SCHEMA }, llm);
    expect(out.outcome).toBe("partial");
    expect(out.summary).toMatch(/Extraction failed/);
  });

  it("wraps a non-object extract_schema and unwraps the result", async () => {
    const llm = new ScriptedLlm([
      { action: "extract" },
      (req: LlmRequest) => {
        expect(promptText(req)).toContain('"result"');
        return { result: ["Laptop Pro 14", "Laptop Air 13", "Laptop Mini 11"] };
      },
    ]);
    const out = await run(
      { goal: "names", start_url: `${site.url}/results.html`, extract_schema: { type: "array", items: { type: "string" } } },
      llm,
    );
    expect(out.outcome).toBe("completed");
    expect(out.extracted).toEqual(["Laptop Pro 14", "Laptop Air 13", "Laptop Mini 11"]);
  });

  it("rejects an unsupported extract_schema before opening a browser page", async () => {
    const before = session.stats().totalAcquired;
    await expect(
      run({ goal: "g", start_url: `${site.url}/index.html`, extract_schema: { $ref: "#/x" } }, new ScriptedLlm([])),
    ).rejects.toBeInstanceOf(JsonSchemaError);
    expect(session.stats().totalAcquired).toBe(before);
  });

  it("stops on a CAPTCHA page before any LLM call", async () => {
    const llm = new ScriptedLlm([]);
    const out = await run({ goal: "Find the price", start_url: `${site.url}/captcha.html` }, llm);
    expect(out.outcome).toBe("blocked");
    expect(out.blocked_reason).toBe("captcha");
    expect(out.steps_taken).toBe(0);
    expect(out.final_url).toBe(`${site.url}/captcha.html`);
    expect(llm.calls).toHaveLength(0);
  });

  it("stops on a login wall before any LLM call", async () => {
    const llm = new ScriptedLlm([]);
    const out = await run({ goal: "Find the price", start_url: `${site.url}/login.html` }, llm);
    expect(out.outcome).toBe("blocked");
    expect(out.blocked_reason).toBe("login_required");
    expect(llm.calls).toHaveLength(0);
  });

  it("never types into a password field, not even through its label, when the goal is about logging in", async () => {
    const llm = new ScriptedLlm([
      // The label text node: Playwright's fill() would retarget it to the password input.
      (req: LlmRequest) => ({ action: "type", ref: refOf(req, "Password", "text"), text: "hunter2" }),
      (req: LlmRequest) => {
        expect(promptText(req)).toMatch(/refused: typing into password fields is not allowed/);
        return { action: "type", ref: refOf(req, "Password", "textbox"), text: "hunter2", submit: true };
      },
      (req: LlmRequest) => {
        expect(promptText(req).match(/typing into password fields is not allowed/g)).toHaveLength(2);
        return { action: "blocked", reason: "The page needs a login and I may not enter passwords" };
      },
    ]);
    const out = await run({ goal: "Log in and read my orders", start_url: `${site.url}/login.html` }, llm);
    expect(out.outcome).toBe("blocked");
    expect(out.blocked_reason).toBe("login_required");
    expect(out.steps_taken).toBe(0);
    expect(log.warn).toHaveBeenCalledWith("browse_task refused to type", expect.objectContaining({ reason: expect.stringContaining("password") }));
  });

  it("refuses off-domain navigation by default and tells the model", async () => {
    const llm = new ScriptedLlm([
      { action: "navigate", url: `${site.otherUrl}/results.html` },
      (req: LlmRequest) => {
        expect(promptText(req)).toMatch(/refused: .*off the start domain/);
        return { action: "done", summary: "stayed on the shop" };
      },
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.steps_taken).toBe(0);
    expect(out.final_url).toBe(`${site.url}/index.html`);
  });

  it("refuses an off-domain link click, and an off-domain redirect started by a script", async () => {
    const llm = new ScriptedLlm([
      click("Partner site", "link"),
      (req: LlmRequest) => {
        expect(promptText(req)).toMatch(/click e\d+ "Partner site" -> refused: .*off the start domain/);
        return click("Open partner page", "button")(req);
      },
      (req: LlmRequest) => {
        expect(promptText(req)).toMatch(/"Open partner page" -> refused: .*navigation to http:\/\/localhost:\d+\/results\.html was refused/);
        return { action: "done", summary: "never left" };
      },
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.final_url).toBe(`${site.url}/index.html`);
    expect(out.steps_taken).toBe(0);
  });

  it("navigates off-domain when allow_navigation_off_domain is true", async () => {
    const llm = new ScriptedLlm([{ action: "navigate", url: `${site.otherUrl}/results.html` }, { action: "done", summary: "went to the partner" }]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html`, allow_navigation_off_domain: true }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.steps_taken).toBe(1);
    expect(out.final_url).toBe(`${site.otherUrl}/results.html`);
  });

  it("without a start_url the first navigation sets the domain", async () => {
    const llm = new ScriptedLlm([
      { action: "navigate", url: `${site.url}/index.html` },
      { action: "navigate", url: `${site.otherUrl}/results.html` },
      { action: "done", summary: "stayed" },
    ]);
    const out = await run({ goal: "g" }, llm);
    expect(out.steps_taken).toBe(1);
    expect(out.final_url).toBe(`${site.url}/index.html`);
  });

  it("cancels file downloads and says so", async () => {
    const llm = new ScriptedLlm([
      click("Price list file", "link"),
      (req: LlmRequest) => {
        expect(promptText(req)).toMatch(/"Price list file" -> refused: .*download/);
        return { action: "done", summary: "no downloads" };
      },
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.steps_taken).toBe(0);
    expect(out.final_url).toBe(`${site.url}/index.html`);
  });

  it("returns partial when the model client runs out of budget", async () => {
    const llm = new ScriptedLlm([
      { action: "scroll", direction: "down" },
      new LlmError("budget_exceeded", "api", "Cost cap of $1.00 reached", { retryable: false }),
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html`, max_cost_usd: 1 }, llm);
    expect(out.outcome).toBe("partial");
    expect(out.steps_taken).toBe(1);
    expect(out.summary).toMatch(/cost cap of \$1\.00 was reached/);
    expect(out.final_url).toBe(`${site.url}/index.html`);
  });

  it("returns partial with the cap in the summary when the budget runs out during extraction", async () => {
    const llm = new ScriptedLlm([
      { action: "extract" },
      new LlmError("budget_exceeded", "api", "Cost cap reached", { retryable: false }),
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/results.html`, extract_schema: ITEM_SCHEMA }, llm);
    expect(out.outcome).toBe("partial");
    expect(out.summary).toMatch(/Extraction failed: the cost cap was reached/);
  });

  it("propagates a config error from the LLM client and still releases the page", async () => {
    const llm = new ScriptedLlm([new LlmError("config", "not_configured", "ANTHROPIC_API_KEY is not set", { retryable: false })]);
    await expect(run({ goal: "g", start_url: `${site.url}/index.html` }, llm)).rejects.toMatchObject({ code: "config" });
  });

  it("treats an invalid model reply as a failed step and keeps going", async () => {
    const llm = new ScriptedLlm([
      { action: "teleport" },
      (req: LlmRequest) => {
        expect(promptText(req)).toContain("(invalid reply) -> invalid");
        return { action: "done", summary: "recovered" };
      },
    ]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("completed");
    expect(out.summary).toBe("recovered");
  });

  it("reports blocked with a mapped reason when the model says it is blocked", async () => {
    const llm = new ScriptedLlm([{ action: "blocked", reason: "The site shows a CAPTCHA I cannot pass" }]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm);
    expect(out.outcome).toBe("blocked");
    expect(out.blocked_reason).toBe("captcha");
    expect(out.summary).toContain("CAPTCHA");
  });

  it("reports partial, with no LLM call, when the start page cannot be loaded", async () => {
    const llm = new ScriptedLlm([]);
    const out = await run({ goal: "g", start_url: "http://127.0.0.1:1/never" }, llm);
    expect(out.outcome).toBe("partial");
    expect(out.summary).toMatch(/Could not load/);
    expect(out.steps_taken).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("attaches a screenshot only when requested and saves it only when config.save_screenshots is on", async () => {
    const script = (): ScriptedLlm =>
      new ScriptedLlm([
        { action: "screenshot" },
        (req: LlmRequest) => {
          const content = req.messages[0]?.content;
          const hasImage = Array.isArray(content) && content.some((b) => b.type === "image");
          expect(hasImage).toBe(true);
          return { action: "done", summary: "saw it" };
        },
      ]);

    // Off: the image still reaches the model, but nothing is kept or reported.
    const unsaved = script();
    const outOff = await run({ goal: "g", start_url: `${site.url}/index.html` }, unsaved, { screenshotDir: shotDir });
    expect(outOff.screenshots).toBeUndefined();
    const firstContent = unsaved.calls[0]?.messages[0]?.content;
    expect(Array.isArray(firstContent) && firstContent.some((b) => b.type === "image")).toBe(false);

    // On: the PNG lands under the run directory and its path is returned.
    const saved = script();
    const outOn = await run({ goal: "g", start_url: `${site.url}/index.html` }, saved, {
      config: { ...config, save_screenshots: true },
      screenshotDir: shotDir,
    });
    expect(outOn.screenshots).toHaveLength(1);
    const path = outOn.screenshots?.[0] as string;
    expect(path.startsWith(shotDir)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("defaults the screenshot directory to <cache_dir>/runs/<run id>", async () => {
    const cfg = { ...config, save_screenshots: true };
    const llm = new ScriptedLlm([{ action: "screenshot" }, { action: "done", summary: "ok" }]);
    const out = await run({ goal: "g", start_url: `${site.url}/index.html` }, llm, { config: cfg });
    const path = out.screenshots?.[0] as string;
    expect(path.startsWith(join(cfg.cache_dir, "runs") + "/")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

// -- the tool, with a fake runner ------------------------------------------------------------------------------------

describe("browse_task tool", () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()?.();
  });

  const okOutput: BrowseTaskOutput = {
    goal: "g",
    outcome: "completed",
    summary: "done",
    extracted: { a: 1 },
    final_url: "https://a.test/",
    steps_taken: 2,
  };

  async function connect(runner: BrowseTaskRunner, depsOver: Partial<Deps> = {}): Promise<Client> {
    const deps: Deps = {
      config: { anthropic_api_key: "k" } as Config,
      log: makeLog(),
      browser: {} as BrowserSession,
      llm: { complete: vi.fn() },
      ...depsOver,
    };
    const server = new McpServer({ name: "test", version: "0" });
    registerBrowseTaskTool(server, deps, runner);
    const client = new Client({ name: "test-client", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("is listed with a description of its limits, and wired into registerTools", async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "browse_task");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/real browser/i);
    expect(tool?.description).toMatch(/persistent/i);
    expect(tool?.description).toMatch(/read-and-extract/i);
    expect(tool?.description).toMatch(/payments/i);
    expect(tool?.description).toMatch(/never logs in/i);
    expect(tool?.description).toMatch(/CAPTCHA/);
    expect(tool?.description).toMatch(/extract_schema/);
    expect(tool?.description).toMatch(/max_cost_usd/);
    const props = (tool?.inputSchema as { properties: Record<string, { default?: unknown; maximum?: number }>; required?: string[] });
    expect(props.required).toEqual(["goal"]);
    expect(props.properties["max_steps"]).toMatchObject({ default: 15, maximum: 40 });
    expect(props.properties["max_cost_usd"]).toMatchObject({ default: 1 });
    expect(props.properties["allow_navigation_off_domain"]).toMatchObject({ default: false });
    expect(tool?.outputSchema).toBeDefined();

    const server = new McpServer({ name: "test", version: "0" });
    registerTools(server, { config: {} as Config, log: makeLog() });
    const c2 = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), c2.connect(a)]);
    open.push(async () => {
      await c2.close();
      await server.close();
    });
    expect((await c2.listTools()).tools.map((t) => t.name)).toContain("browse_task");
  });

  it("passes the input with defaults to the runner and returns its output as text and structuredContent", async () => {
    const runner = vi.fn<BrowseTaskRunner>(() => Promise.resolve(okOutput));
    const client = await connect(runner);
    const res = await client.callTool({
      name: "browse_task",
      arguments: { goal: "find it", start_url: "https://a.test/", extract_schema: { type: "object" } },
    });
    expect(res.isError).toBeFalsy();
    expect(BrowseTaskOutputSchema.parse(res.structuredContent)).toEqual(okOutput);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(okOutput);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toEqual({
      goal: "find it",
      start_url: "https://a.test/",
      extract_schema: { type: "object" },
      max_steps: 15,
      allow_navigation_off_domain: false,
      max_cost_usd: 1,
    });
    expect(runner.mock.calls[0]?.[1]).toMatchObject({ config: { anthropic_api_key: "k" } });
  });

  it("returns blocked and partial outcomes as normal results, not errors", async () => {
    const blocked: BrowseTaskOutput = { ...okOutput, outcome: "blocked", blocked_reason: "captcha", extracted: undefined };
    const client = await connect(() => Promise.resolve(blocked));
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect(res.isError).toBeFalsy();
    expect(BrowseTaskOutputSchema.parse(res.structuredContent)).toMatchObject({ outcome: "blocked", blocked_reason: "captcha" });
  });

  it.each([
    ["config", new LlmError("config", "not_configured", "no key", { retryable: false }), "config", false],
    ["provider", new LlmError("provider", "rate_limit", "slow down", { retryable: true, details: { status: 429 } }), "provider", true],
    ["timeout", new LlmError("timeout", "network", "timed out", { retryable: true }), "timeout", true],
    ["budget", new LlmError("budget_exceeded", "api", "cap", { retryable: false, details: { spent_usd: 1 } }), "budget_exceeded", false],
  ])("maps an LlmError (%s) onto the envelope", async (_n, err, code, retryable) => {
    const client = await connect(() => Promise.reject(err));
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect(res.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(res.structuredContent);
    expect(envelope.error).toMatchObject({ code, retryable, message: err.message });
    expect(envelope.error.details).toEqual(err.details);
  });

  it("maps an unsupported extract_schema to invalid_input", async () => {
    const client = await connect(() => Promise.reject(new JsonSchemaError('"$ref" is not supported', "a")));
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error).toMatchObject({ code: "invalid_input", retryable: false });
  });

  it("maps anything else to internal, without a stack", async () => {
    const client = await connect(() => Promise.reject(new Error("kaboom\n    at secret.ts:1:1")));
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect(res.isError).toBe(true);
    const err = ErrorEnvelopeSchema.parse(res.structuredContent).error;
    expect(err.code).toBe("internal");
    expect(err.message).toContain("kaboom");
    expect(err.message).not.toContain("secret.ts");
  });

  it("returns a config envelope without running anything when ANTHROPIC_API_KEY is unset", async () => {
    const runner = vi.fn<BrowseTaskRunner>();
    const client = await connect(runner, { config: {} as Config });
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error).toMatchObject({ code: "config", retryable: false });
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns an internal envelope when the browser or llm dep is missing", async () => {
    const runner = vi.fn<BrowseTaskRunner>();
    const client = await connect(runner, { browser: undefined });
    const res = await client.callTool({ name: "browse_task", arguments: { goal: "g" } });
    expect(res.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(res.structuredContent).error.code).toBe("internal");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects invalid input before the runner runs", async () => {
    const runner = vi.fn<BrowseTaskRunner>();
    const client = await connect(runner);
    for (const args of [{}, { goal: "" }, { goal: "g", max_steps: 41 }, { goal: "g", start_url: "ftp://x" }, { goal: "g", max_cost_usd: -1 }]) {
      const res = await client.callTool({ name: "browse_task", arguments: args }).catch((e: unknown) => e);
      const rejected = res instanceof Error || (res as { isError?: boolean }).isError === true;
      expect(rejected, JSON.stringify(args)).toBe(true);
    }
    expect(runner).not.toHaveBeenCalled();
  });
});
