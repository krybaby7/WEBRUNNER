import type { Page } from "playwright";
import type { Config } from "../../config.js";
import type { HandoffReason } from "../../schemas/handoff.js";
import { detectBotWall, type PageProbe } from "../fetch/browser.js";
import { resolveHeadless } from "./session.js";

/**
 * The generic wall classifier, PLAN.md 16.4. One probe and one table tell a
 * wall the owner can clear by hand (a CAPTCHA, a checkpoint, a consent page, a
 * login form, a one-time code) from a refusal nobody can do anything about in
 * a window (an IP block). `resume` polls a parked page with it; the browse
 * agent's `detectBlock` and the recipes build on it. Recipes keep their own
 * site-specific detection and report the kind through `RecipeError.wall`.
 */

/** What the probe reads off a page. The text is capped; the counts are of visible elements only. */
export interface WallProbe extends PageProbe {
  url: string;
  /** Visible CAPTCHA widgets (reCAPTCHA, hCaptcha, Turnstile, Arkose). */
  captchaWidgets: number;
  /** Visible password inputs. */
  passwordFields: number;
  /** Visible one-time-code inputs (`autocomplete="one-time-code"`, or a short numeric code field). */
  codeFields: number;
}

/** Runs in the page (a string: the project compiles without the DOM lib). */
export const WALL_PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const widgets = Array.from(document.querySelectorAll(
    '.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"]'
  )).filter((el) => visible(el) && !el.closest(".grecaptcha-badge") && el.getAttribute("data-size") !== "invisible" && el.tagName !== "BUTTON" && el.tagName !== "INPUT");
  const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
  const codes = Array.from(document.querySelectorAll(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[inputmode="numeric"][maxlength="8"], input[name*="otp" i], input[name*="verification" i], input[id*="otp" i], input[id*="verification" i], input[name="approvals_code"]'
  )).filter(visible);
  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 4000),
    textLength: text.length,
    captchaWidgets: widgets.length,
    passwordFields: passwords.length,
    codeFields: codes.length,
  };
})()`;

export type WallKind = HandoffReason | "ip_refusal";

export interface Wall {
  /** A handoff reason the owner can act on, or `ip_refusal` for a block nobody can clear in a window. */
  kind: WallKind;
  /** One clause for messages: "a CAPTCHA widget is shown on the page". */
  detail: string;
}

const SHORT_PAGE_CHARS = 3000;
/** A login or code form on a page this long is more likely a header widget than a wall. */
const FORM_WALL_MAX_CHARS = 4000;

const CAPTCHA_TEXT_RE = /\b(recaptcha|hcaptcha|captcha|cf-turnstile)\b|verify (that )?you are (a )?human|not a robot|press\s*(&|and)\s*hold/i;
const CONSENT_RE = /\bBefore you continue to (Google|YouTube)\b|\b(accept|reject) all\b.*\bcookies\b|\bwe (use|value your) (cookies|privacy)\b.*\b(accept|agree)\b/is;
const MFA_TEXT_RE = /\b(verification|security|one-time|confirmation|two-factor|2fa|authentication) code\b|\benter the code\b|\bcode (we|that was) sent\b/i;

/** URL patterns of platform checkpoints (PLAN.md 16.4): a check the owner completes, not a login. */
const CHECKPOINT_URL_RE = [
  /facebook\.com\/checkpoint\//i,
  /\/\/(?:[^/]+\.)?x\.com\/(?:account\/access|i\/flow\/(?:consent|verification|challenge))/i,
  /twitter\.com\/account\/access/i,
  /amazon\.[a-z.]+\/errors\/validateCaptcha/i,
  /google\.[a-z.]+\/sorry\//i,
];

/** Bot-wall signature names (core/fetch/browser.ts) that a human can clear in the window. */
const HUMAN_CLEARABLE_WALLS: Record<string, HandoffReason> = {
  "captcha-title": "captcha",
  "captcha-body": "captcha",
  "cloudflare-verify": "captcha",
  "robot-check-title": "captcha",
  "press-and-hold": "captcha",
  "unusual-traffic": "checkpoint",
};

/**
 * Classify a probed page. Order: CAPTCHA, checkpoint URL, bot-wall table
 * (human-clearable names become `captcha` or `checkpoint`, the rest
 * `ip_refusal`), consent, one-time code, login form. Undefined when the page
 * looks usable. `loginIsWall` is false when the caller wants login pages
 * passed through (a goal that is about logging in).
 */
export function classifyWall(probe: WallProbe, options: { loginIsWall?: boolean } = {}): Wall | undefined {
  const shortPage = probe.textLength < SHORT_PAGE_CHARS;
  const formPage = probe.textLength < FORM_WALL_MAX_CHARS;
  if (probe.captchaWidgets > 0) return { kind: "captcha", detail: "a CAPTCHA widget is shown on the page" };
  if (CAPTCHA_TEXT_RE.test(probe.title) || (shortPage && CAPTCHA_TEXT_RE.test(probe.text))) {
    return { kind: "captcha", detail: "the page asks the visitor to complete a CAPTCHA or prove they are human" };
  }
  if (CHECKPOINT_URL_RE.some((re) => re.test(probe.url))) {
    return { kind: "checkpoint", detail: `the site redirected to a security checkpoint (${hostOf(probe.url)})` };
  }
  const wall = detectBotWall(probe);
  if (wall !== undefined) {
    const reason = HUMAN_CLEARABLE_WALLS[wall];
    if (reason !== undefined) return { kind: reason, detail: `the site served a ${reason === "captcha" ? "CAPTCHA" : "checkpoint"} page (${wall})` };
    return { kind: "ip_refusal", detail: `the site served a bot-protection page (${wall})` };
  }
  if (shortPage && CONSENT_RE.test(probe.text)) return { kind: "consent", detail: "a cookie consent page is shown" };
  if (probe.codeFields > 0 && formPage && MFA_TEXT_RE.test(probe.text)) {
    return { kind: "mfa", detail: "the page asks for a one-time verification code" };
  }
  if (options.loginIsWall !== false && probe.passwordFields > 0 && formPage) {
    return { kind: "login_required", detail: "the page is a login form" };
  }
  return undefined;
}

/** Evaluate the wall probe, tolerating one navigation under us. Undefined when the page cannot be read. */
export async function probeWall(page: Page): Promise<WallProbe | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await page.evaluate<WallProbe>(WALL_PROBE_JS);
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return undefined;
}

/** `what_to_do` for a wall of this kind, naming the window (PLAN.md 16.4). */
export function whatToDoFor(reason: HandoffReason, site: string, window: string): string {
  switch (reason) {
    case "captcha":
      return `Solve the CAPTCHA on the ${site} page in the ${window}, then resume.`;
    case "checkpoint":
      return `Complete the security check ${site} is showing in the ${window} (it is your own session), then resume.`;
    case "consent":
      return `Accept or reject the cookie dialog on the ${site} page in the ${window}, then resume.`;
    case "login_required":
      return `Sign in to ${site} in the ${window}; webrunner never types credentials. Then resume.`;
    case "mfa":
      return `Enter the verification code ${site} is asking for in the ${window}, then resume.`;
    case "unknown_wall":
      return `${site} is showing a page the tool cannot read past; clear it in the ${window}, then resume.`;
  }
}

/** The name of the window the owner looks at, by browser mode. */
export function windowName(config: Config): string {
  return config.browser.cdp_url !== undefined ? "Chrome you attached" : "webrunner browser window";
}

/** The sentence a `blocked` message carries when a human could have cleared the wall but no one can see the window. */
export const HEADLESS_HINT = "Run headful or attach your Chrome to be able to clear this yourself.";

/** The sentence a `blocked` message carries for an IP-level refusal. */
export const IP_REFUSED_HINT = "This IP is refused; run from a home connection.";

/** True when nobody can see the browser: persistent mode, headless. CDP mode is always visible. */
export function windowHidden(config: Config): boolean {
  return config.browser.cdp_url === undefined && resolveHeadless(config);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
