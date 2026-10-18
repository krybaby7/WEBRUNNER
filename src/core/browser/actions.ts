import { errors as playwrightErrors, type Locator, type Page } from "playwright";
import { z } from "zod";
import type { Logger } from "../../log.js";
import type { Snapshot } from "./types.js";

/**
 * Action layer of the generic browse agent (PLAN.md 3.4, WP10): the action
 * schema the model fills in, the hard deny rules that run in code before any
 * click or type-with-submit, the navigation policy, and the executors that
 * turn a ref from `Snapshot.refs` into a page interaction.
 *
 * Executors never throw for problems with the action itself. A stale ref, a
 * refused action or a Playwright failure comes back as an `ActionOutcome` that
 * the agent reports to the model as the result of that step.
 */

// -- actions ---------------------------------------------------------------------------------

export const MAX_WAIT_MS = 5000;
export const DEFAULT_SCROLL_PX = 600;

/** One action per step. A discriminated union so the model's output can be schema-constrained. */
export const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ref: z.string().describe("Ref id from the accessibility tree, such as e12.") }),
  z.object({
    action: z.literal("type"),
    ref: z.string(),
    text: z.string().describe("Replaces the current value of the field."),
    submit: z.boolean().optional().describe("Press Enter after typing."),
  }),
  z.object({ action: z.literal("select"), ref: z.string(), value: z.string().describe("Option value or visible label.") }),
  z.object({ action: z.literal("navigate"), url: z.string().describe("Absolute http(s) URL, or a path relative to the current page.") }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["down", "up"]),
    amount: z.number().int().positive().optional().describe(`Pixels. Default ${DEFAULT_SCROLL_PX}.`),
  }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).describe(`Milliseconds, at most ${MAX_WAIT_MS}.`) }),
  z.object({ action: z.literal("screenshot") }).describe("Attach a screenshot of the page to the next step."),
  z.object({ action: z.literal("extract") }).describe("The current page already shows everything the goal needs."),
  z.object({ action: z.literal("done"), summary: z.string().describe("What was found or accomplished.") }),
  z.object({ action: z.literal("blocked"), reason: z.string().describe("Why the goal cannot be reached from here.") }),
]);
export type Action = z.infer<typeof ActionSchema>;
/** Actions that touch the page. The rest end the run or only change what the next step sees. */
export type PageAction = Extract<Action, { action: "click" | "type" | "select" | "navigate" | "scroll" | "wait" }>;

export interface ActionOutcome {
  status: "ok" | "refused" | "failed";
  /** Reported back to the model as the result of the step. */
  message: string;
  /** True when the action ran against the page. Refused and failed actions do not count as steps. */
  executed: boolean;
}

const ok = (message: string): ActionOutcome => ({ status: "ok", message, executed: true });
const refused = (message: string): ActionOutcome => ({ status: "refused", message, executed: false });
const failed = (message: string): ActionOutcome => ({ status: "failed", message, executed: false });

// -- deny rules ----------------------------------------------------------------------------------

/** Element names and form details matching this are never clicked or submitted. PLAN.md 3.4. */
export const DENY_NAME_RE =
  /\b(buy|pay|purchase|checkout|place order|confirm (purchase|order|payment|booking)|book now|subscribe|donate|submit payment|complete (purchase|order))\b/i;

/** URL path segments that mark a payment flow. Matched as whole tokens, so `/display` and `/payload` are fine. */
const DENY_PATH_TOKENS = new Set(["checkout", "payment", "payments", "pay", "billing"]);

/** Inputs whose name, id, autocomplete or label suggests a card number or other card detail. */
const CARD_FIELD_RE = /cc-?(number|num|csc|cvc|cvv|exp|name)|cardnumber|credit|(^|[^a-z])card([^a-z]|$)/i;

/** Why the URL's path marks a payment flow, or undefined. */
export function deniedPathReason(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (path.includes("order/confirm")) return `the page path "${path}" is an order confirmation`;
  const token = path.split(/[^a-z0-9]+/).find((t) => DENY_PATH_TOKENS.has(t));
  return token === undefined ? undefined : `the page path "${path}" belongs to a payment flow ("${token}")`;
}

export interface FormFacts {
  id: string;
  name: string;
  action: string;
  label: string;
  /** Text of the buttons inside the form. */
  buttons: string[];
}

export interface ElementFacts {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  ariaLabel: string;
  title: string;
  placeholder: string;
  /** The `value` of submit and button inputs only; typed text is never inspected. */
  buttonValue: string;
  text: string;
  href: string;
  hasDownloadAttr: boolean;
  form: FormFacts | null;
}

/**
 * Body of the function run against the target element (parameter `el`).
 * Built with `new Function` because this project compiles without the DOM lib,
 * and Playwright only passes the element to real functions, not to strings.
 */
const FACTS_BODY = `
  // A label ref resolves to its control for fill and click, so inspect the control.
  const label = el.tagName === "LABEL" ? el : (el.closest ? el.closest("label") : null);
  const target = (label && label.control) || el;
  const attr = (n) => target.getAttribute(n) || "";
  const type = attr("type").toLowerCase();
  const form = target.form || target.closest("form");
  let formFacts = null;
  if (form) {
    const buttons = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
      .map((b) => ((b.innerText || b.value || b.getAttribute("aria-label") || "") + "").trim())
      .filter(Boolean)
      .slice(0, 12);
    formFacts = {
      id: form.id || "",
      name: form.getAttribute("name") || "",
      action: form.getAttribute("action") || "",
      label: form.getAttribute("aria-label") || "",
      buttons,
    };
  }
  return {
    tag: target.tagName.toLowerCase(),
    type,
    name: attr("name"),
    id: attr("id"),
    autocomplete: attr("autocomplete"),
    ariaLabel: attr("aria-label"),
    title: attr("title"),
    placeholder: attr("placeholder"),
    buttonValue: ["submit", "button", "reset"].includes(type) ? (target.value || "") : "",
    text: ((el.innerText || "") + "").slice(0, 200),
    href: target.href ? String(target.href) : attr("href"),
    hasDownloadAttr: target.hasAttribute("download"),
    form: formFacts,
  };
`;
const factsFn = new Function("el", FACTS_BODY) as (el: unknown) => ElementFacts;

function firstMatch(candidates: Array<[string, string]>): { label: string; text: string } | undefined {
  for (const [label, text] of candidates) {
    if (text !== "" && DENY_NAME_RE.test(text)) return { label, text };
  }
  return undefined;
}

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Why a click or a submitting type must be refused, or undefined. Checks the
 * element's own name, the surrounding form (identifiers, action path and the
 * text of its buttons) and the page URL.
 */
export function purchaseDenyReason(facts: ElementFacts, refName: string, pageUrl: string): string | undefined {
  const own = firstMatch([
    ["name", refName],
    ["text", facts.text],
    ["aria-label", facts.ariaLabel],
    ["title", facts.title],
    ["value", facts.buttonValue],
    ["id", facts.id],
    ["name attribute", facts.name],
  ]);
  if (own !== undefined) return `the element ${own.label} "${clip(own.text)}" matches the purchase deny list`;

  const form = facts.form;
  if (form !== null) {
    const hit = firstMatch([
      ["id", form.id],
      ["name", form.name],
      ["label", form.label],
      ...form.buttons.map((b): [string, string] => ["button", b]),
    ]);
    if (hit !== undefined) {
      return `the surrounding form has a ${hit.label} "${clip(hit.text)}" that matches the purchase deny list`;
    }
    let actionReason: string | undefined;
    try {
      actionReason = form.action === "" ? undefined : deniedPathReason(new URL(form.action, pageUrl).href);
    } catch {
      actionReason = undefined;
    }
    if (actionReason !== undefined) return `the surrounding form posts to a payment URL (${actionReason})`;
  }
  return deniedPathReason(pageUrl);
}

/** Why typing into this field must be refused, or undefined. Password and card fields are never typed into. */
export function sensitiveFieldReason(facts: ElementFacts, refName: string): string | undefined {
  if (facts.type === "password") return "typing into password fields is not allowed";
  const hit = [facts.name, facts.id, facts.autocomplete, facts.ariaLabel, facts.placeholder, refName].find(
    (v) => v !== "" && CARD_FIELD_RE.test(v),
  );
  return hit === undefined ? undefined : `the field "${clip(hit)}" looks like a payment card field; typing card details is not allowed`;
}

// -- navigation policy --------------------------------------------------------------------------

const baseHost = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/**
 * Keeps the run on the start domain unless `allowOffDomain`. A host passes when
 * it equals an adopted host or is a subdomain of one (`www.` is ignored).
 * Nothing is enforced until a host has been adopted, so a run without a
 * `start_url` may make its first navigation anywhere.
 */
export class DomainPolicy {
  private readonly hosts = new Set<string>();

  constructor(private readonly allowOffDomain: boolean) {}

  adopt(url: string): void {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") this.hosts.add(baseHost(u.hostname));
    } catch {
      // about:blank and the like: nothing to adopt.
    }
  }

  get enforcing(): boolean {
    return !this.allowOffDomain && this.hosts.size > 0;
  }

  /** Undefined when the navigation is allowed, otherwise the refusal reason. */
  refusal(url: string): string | undefined {
    if (!this.enforcing) return undefined;
    let host: string;
    try {
      host = baseHost(new URL(url).hostname);
    } catch {
      return undefined;
    }
    for (const allowed of this.hosts) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return undefined;
    }
    return `${host} is off the start domain (${[...this.hosts].join(", ")}) and allow_navigation_off_domain is false`;
  }
}

// -- page guards -----------------------------------------------------------------------------------

export interface GuardEvents {
  /** File names of downloads that were cancelled. */
  downloads: string[];
  /** URLs of main-frame navigations the policy aborted. */
  refusedNavigations: string[];
  /** URLs opened in new tabs by the last action. The tabs are closed. */
  popups: string[];
}

const noop = (): undefined => undefined;

/**
 * Listeners and routing that enforce the rules even when an action has side
 * effects the executor did not predict: JS dialogs are dismissed, downloads
 * cancelled, new tabs closed (their URL is reported so the agent can follow
 * it on the main page), and main-frame navigations that leave the allowed
 * domain are cancelled, including redirects and scripted ones.
 */
export class PageGuards {
  private events: GuardEvents = { downloads: [], refusedNavigations: [], popups: [] };
  private readonly pending: Array<Promise<void>> = [];

  constructor(
    private readonly page: Page,
    private readonly policy: DomainPolicy,
    private readonly log: Logger,
  ) {}

  async install(): Promise<void> {
    const { page } = this;
    page.on("dialog", (d) => {
      d.dismiss().catch(noop);
    });
    page.on("download", (d) => {
      this.events.downloads.push(d.suggestedFilename());
      this.log.warn("browse_task refused a file download", { file: d.suggestedFilename(), url: d.url() });
      this.pending.push(d.cancel().catch(noop));
    });
    page.on("popup", (popup) => {
      this.pending.push(
        (async () => {
          await popup.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(noop);
          this.events.popups.push(popup.url());
          await popup.close().catch(noop);
        })(),
      );
    });
    await page.route("**/*", async (route) => {
      try {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame().parentFrame() === null) {
          const reason = this.policy.refusal(req.url());
          if (reason !== undefined) {
            this.events.refusedNavigations.push(req.url());
            this.log.warn("browse_task refused an off-domain navigation", { url: req.url(), reason });
            // 204 No Content makes the browser stay on the current document; an abort would leave an error page.
            await route.fulfill({ status: 204 });
            return;
          }
        }
        await route.continue();
      } catch {
        // The page closed while the request was in flight.
      }
    });
  }

  /** Wait for popup and download handlers started by the last action, then return and clear what they saw. */
  async drain(): Promise<GuardEvents> {
    await Promise.all(this.pending.splice(0));
    const events = this.events;
    this.events = { downloads: [], refusedNavigations: [], popups: [] };
    return events;
  }
}

// -- executors ---------------------------------------------------------------------------------------

export interface ActionEnv {
  page: Page;
  snapshot: Snapshot;
  policy: DomainPolicy;
  guards: PageGuards;
  log: Logger;
}

const ACTION_TIMEOUT_MS = 8000;
const NAV_TIMEOUT_MS = 30_000;

const firstLine = (s: string): string => clip(s.split("\n")[0] ?? s, 200);

function describeError(err: unknown, verb: string): string {
  if (err instanceof playwrightErrors.TimeoutError) {
    return `${verb} timed out; the element may be hidden, disabled or covered by another element`;
  }
  return `${verb} failed: ${firstLine(err instanceof Error ? err.message : String(err))}`;
}

/** Let the page settle after an action. Pages that never go idle are not an error. */
export async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(noop);
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(noop);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Target {
  locator: Locator;
  facts: ElementFacts;
  name: string;
}

/** Resolve a ref against the snapshot it came from. A missing or stale ref becomes an outcome, never a throw. */
async function resolveTarget(ref: string, env: ActionEnv): Promise<Target | ActionOutcome> {
  const locator = env.snapshot.refs.get(ref);
  if (locator === undefined) {
    return failed(`ref ${ref} is not in the current accessibility tree; use a ref from the latest tree`);
  }
  const name = env.snapshot.refInfo.get(ref)?.name ?? "";
  try {
    if ((await locator.count()) === 0) {
      return failed(`ref ${ref} is stale: the element is no longer on the page; use a ref from the latest tree`);
    }
    const facts = await (locator.first() as unknown as ElementEvaluator).evaluate(factsFn);
    return { locator: locator.first(), facts, name };
  } catch (err) {
    return failed(`ref ${ref} could not be inspected: ${firstLine(err instanceof Error ? err.message : String(err))}`);
  }
}

/** `Locator.evaluate` as seen without the DOM lib: the function receives the element. */
interface ElementEvaluator {
  evaluate(fn: (el: unknown) => ElementFacts): Promise<ElementFacts>;
}

const isOutcome = (v: Target | ActionOutcome): v is ActionOutcome => "status" in v;

/** Notes about what the last action triggered, plus the page the agent should now be on. */
async function afterAction(env: ActionEnv, base: string, urlBefore: string, mayDownload = false): Promise<ActionOutcome> {
  const { page } = env;
  await settlePage(page);
  let events = await env.guards.drain();
  const quiet = (e: GuardEvents): boolean => e.downloads.length + e.refusedNavigations.length + e.popups.length === 0;
  if (mayDownload && quiet(events) && page.url() === urlBefore) {
    // A link that went nowhere may be a download whose event is still on its way.
    await sleep(500);
    const late = await env.guards.drain();
    events = {
      downloads: [...events.downloads, ...late.downloads],
      refusedNavigations: [...events.refusedNavigations, ...late.refusedNavigations],
      popups: [...events.popups, ...late.popups],
    };
  }
  const notes: string[] = [];
  let executed = true;

  if (events.downloads.length > 0) {
    notes.push(`a file download (${events.downloads.join(", ")}) was started and cancelled; downloads are not allowed`);
    executed = false;
  }
  for (const url of events.refusedNavigations) {
    const reason = env.policy.refusal(url);
    notes.push(`navigation to ${url} was refused${reason !== undefined ? `: ${reason}` : ""}`);
    executed = false;
  }
  for (const url of events.popups) {
    const reason = /^https?:/i.test(url) ? env.policy.refusal(url) : "it is not an http(s) page";
    if (reason !== undefined) {
      notes.push(`a new tab to ${url} was closed: ${reason}`);
    } else {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await settlePage(page);
        notes.push(`the link opened a new tab, which was closed; its page ${url} was loaded in the main tab`);
      } catch (err) {
        notes.push(`the link opened a new tab (${url}) that could not be loaded: ${firstLine(String(err))}`);
      }
    }
  }

  const urlAfter = page.url();
  const where = urlAfter !== urlBefore ? `the page is now ${urlAfter}` : "the URL did not change";
  const message = [base, where, ...notes].join("; ");
  return executed ? ok(message) : refused(message);
}

async function execClick(ref: string, env: ActionEnv): Promise<ActionOutcome> {
  const target = await resolveTarget(ref, env);
  if (isOutcome(target)) return target;
  const { page, log } = env;
  const { facts, name } = target;

  const deny = purchaseDenyReason(facts, name, page.url());
  if (deny !== undefined) {
    log.warn("browse_task refused a click", { ref, name, reason: deny, url: page.url() });
    return refused(`click on ${ref} refused: ${deny}. This run only reads and extracts; it never buys, pays, books or subscribes.`);
  }
  if (facts.hasDownloadAttr) {
    log.warn("browse_task refused a file download", { ref, name, url: page.url() });
    return refused(`click on ${ref} refused: it is a file download and downloads are not allowed`);
  }
  if (facts.tag === "a" && facts.href !== "") {
    if (/^javascript:/i.test(facts.href)) return refused(`click on ${ref} refused: javascript: links are not allowed`);
    const offDomain = /^https?:/i.test(facts.href) ? env.policy.refusal(facts.href) : undefined;
    if (offDomain !== undefined) {
      log.warn("browse_task refused an off-domain link", { ref, href: facts.href, reason: offDomain });
      return refused(`click on ${ref} refused: the link goes to ${facts.href}, which ${offDomain}`);
    }
  }

  const urlBefore = page.url();
  try {
    await target.locator.click({ timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    return failed(describeError(err, `click on ${ref}`));
  }
  return afterAction(env, `clicked ${ref}${name !== "" ? ` (${clip(name, 60)})` : ""}`, urlBefore, facts.tag === "a");
}

async function execType(action: Extract<PageAction, { action: "type" }>, env: ActionEnv): Promise<ActionOutcome> {
  const target = await resolveTarget(action.ref, env);
  if (isOutcome(target)) return target;
  const { page, log } = env;
  const { facts, name } = target;

  const sensitive = sensitiveFieldReason(facts, name);
  if (sensitive !== undefined) {
    log.warn("browse_task refused to type", { ref: action.ref, name, reason: sensitive, url: page.url() });
    return refused(`typing into ${action.ref} refused: ${sensitive}`);
  }
  if (action.submit === true) {
    const deny = purchaseDenyReason(facts, name, page.url());
    if (deny !== undefined) {
      log.warn("browse_task refused to submit", { ref: action.ref, name, reason: deny, url: page.url() });
      return refused(
        `typing into ${action.ref} with submit refused: ${deny}. This run only reads and extracts; it never buys, pays, books or subscribes.`,
      );
    }
  }

  const urlBefore = page.url();
  try {
    await target.locator.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
    if (action.submit === true) await target.locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    return failed(describeError(err, `typing into ${action.ref}`));
  }
  const typed = `typed ${JSON.stringify(clip(action.text, 60))} into ${action.ref}${name !== "" ? ` (${clip(name, 60)})` : ""}`;
  return afterAction(env, action.submit === true ? `${typed} and pressed Enter` : typed, urlBefore);
}

async function execSelect(action: Extract<PageAction, { action: "select" }>, env: ActionEnv): Promise<ActionOutcome> {
  const target = await resolveTarget(action.ref, env);
  if (isOutcome(target)) return target;
  const urlBefore = env.page.url();
  try {
    await target.locator.selectOption(action.value, { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    return failed(describeError(err, `selecting ${JSON.stringify(clip(action.value, 60))} in ${action.ref}`));
  }
  return afterAction(env, `selected ${JSON.stringify(clip(action.value, 60))} in ${action.ref}`, urlBefore);
}

async function execNavigate(action: Extract<PageAction, { action: "navigate" }>, env: ActionEnv): Promise<ActionOutcome> {
  const { page, policy, log } = env;
  let target: URL;
  try {
    target = new URL(action.url, page.url());
  } catch {
    return failed(`navigate failed: "${clip(action.url, 100)}" is not a valid URL`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return refused(`navigation to ${clip(target.href, 100)} refused: only http(s) pages can be opened`);
  }
  const reason = policy.refusal(target.href);
  if (reason !== undefined) {
    log.warn("browse_task refused an off-domain navigation", { url: target.href, reason });
    return refused(`navigation to ${target.href} refused: ${reason}`);
  }
  const urlBefore = page.url();
  try {
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    policy.adopt(target.href);
    const status = response?.status();
    const base = `navigated to ${target.href}${status !== undefined && status >= 400 ? ` (HTTP ${status})` : ""}`;
    return afterAction(env, base, urlBefore);
  } catch (err) {
    const events = await env.guards.drain();
    if (events.refusedNavigations.length > 0) {
      return refused(`navigation to ${target.href} refused: it redirects to ${events.refusedNavigations.join(", ")}, which is off the start domain`);
    }
    return failed(describeError(err, `navigation to ${target.href}`));
  }
}

async function execScroll(action: Extract<PageAction, { action: "scroll" }>, env: ActionEnv): Promise<ActionOutcome> {
  const px = (action.amount ?? DEFAULT_SCROLL_PX) * (action.direction === "up" ? -1 : 1);
  try {
    const [y, height, view] = await env.page.evaluate<number[]>(
      `(() => { window.scrollBy(0, ${px}); return [Math.round(window.scrollY), document.documentElement.scrollHeight, window.innerHeight]; })()`,
    );
    return ok(`scrolled ${action.direction} ${Math.abs(px)}px; now at y=${y} of ${height} (viewport ${view}px)`);
  } catch (err) {
    return failed(describeError(err, "scroll"));
  }
}

async function execWait(action: Extract<PageAction, { action: "wait" }>): Promise<ActionOutcome> {
  const ms = Math.min(Math.max(0, action.ms), MAX_WAIT_MS);
  await sleep(ms);
  return ok(`waited ${ms}ms${ms < action.ms ? ` (capped from ${action.ms}ms)` : ""}`);
}

/** Run one page action. Never throws for problems with the action itself. */
export async function executeAction(action: PageAction, env: ActionEnv): Promise<ActionOutcome> {
  switch (action.action) {
    case "click":
      return execClick(action.ref, env);
    case "type":
      return execType(action, env);
    case "select":
      return execSelect(action, env);
    case "navigate":
      return execNavigate(action, env);
    case "scroll":
      return execScroll(action, env);
    case "wait":
      return execWait(action);
  }
}

/** Short label for the history shown to the model. */
export function describeAction(action: Action, refName?: string): string {
  const named = (ref: string): string => (refName !== undefined && refName !== "" ? `${ref} "${clip(refName, 40)}"` : ref);
  switch (action.action) {
    case "click":
      return `click ${named(action.ref)}`;
    case "type":
      return `type ${JSON.stringify(clip(action.text, 40))} into ${named(action.ref)}${action.submit === true ? " + Enter" : ""}`;
    case "select":
      return `select ${JSON.stringify(clip(action.value, 40))} in ${named(action.ref)}`;
    case "navigate":
      return `navigate ${clip(action.url, 100)}`;
    case "scroll":
      return `scroll ${action.direction}${action.amount !== undefined ? ` ${action.amount}px` : ""}`;
    case "wait":
      return `wait ${action.ms}ms`;
    case "screenshot":
      return "request screenshot";
    case "extract":
      return "extract";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
  }
}
