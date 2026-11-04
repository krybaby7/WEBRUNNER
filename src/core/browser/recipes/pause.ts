import type { Page } from "playwright";
import type { HandoffReason } from "../../../schemas/handoff.js";
import type { HandoffHooks } from "../types.js";
import { HEADLESS_HINT, IP_REFUSED_HINT } from "../walls.js";
import { RecipeError, type Recipe, type RecipeContext } from "./types.js";

/**
 * The pause loop every browser provider runs its recipe in (PLAN.md 16.4).
 * A recipe marks the walls a human can clear with `RecipeError.wall`; this
 * wrapper offers such a wall to the owner through the host's hooks and, when
 * the owner cleared it ("cleared"), runs the recipe again from its first
 * navigation on the same page. With no hooks (nobody can see the window) the
 * error goes back with the headless hint; a `blocked` error with no wall is
 * an IP-level refusal and gets the IP hint.
 */

/** Bot-check names the recipes' `blockedReason` helpers return, mapped to what the owner can do about them. */
const CLEARABLE_BOT_CHECKS: Record<string, HandoffReason> = {
  "sorry/index": "checkpoint",
  recaptcha: "captcha",
  "unusual traffic": "checkpoint",
  "unusual-traffic": "checkpoint",
  "captcha-title": "captcha",
  "captcha-body": "captcha",
  "cloudflare-verify": "captcha",
  "robot-check-title": "captcha",
  "press-and-hold": "captcha",
};

/** The handoff reason for a bot-check name, or undefined when nothing a human does in the window would help. */
export function wallOfBotCheck(name: string | undefined): HandoffReason | undefined {
  return name === undefined ? undefined : CLEARABLE_BOT_CHECKS[name];
}

/** A `blocked` error that reads like the network refusing the IP, as opposed to a rate limit or a page that merely did not load. */
const IP_REFUSAL_RE = /HTTP 403|network block|network security|refused|bot check|bot-protection|has been blocked|access denied/i;

/** Where the recipe stopped, for the handoff's `step`: the site and the first clause of its own message. */
function stepOf(site: string, err: RecipeError): string {
  const clause = err.message.split(/[;(]/)[0]?.trim() ?? err.message;
  return `${site}: ${clause.slice(0, 80)}`;
}

function withHint(err: RecipeError, hint: string): RecipeError {
  if (err.message.includes(hint)) return err;
  return new RecipeError(err.code, `${err.message}. ${hint}`, {
    retryable: err.retryable,
    needsLogin: err.needsLogin,
    ...(err.wall !== undefined && { wall: err.wall }),
    cause: err,
  });
}

/**
 * Run `recipe` on `page` with the handoff wired into its context. One pause per
 * run: a wall met again after "cleared" is reported as it is. `site` is the
 * name the handoff carries (the provider's platform or source name, so it
 * matches `accounts` and the failure lists); default the recipe's site id.
 */
export async function runRecipeWithPause<P, R>(
  recipe: Recipe<P, R>,
  page: Page,
  params: P,
  ctx: RecipeContext,
  handoff: HandoffHooks | undefined,
  site: string = recipe.site,
): Promise<R> {
  const pausable: RecipeContext =
    handoff === undefined ? ctx : { ...ctx, pause: (reason, whatToDo, step) => handoff.pause(page, site, reason, whatToDo, step) };
  for (let attempt = 0; ; attempt++) {
    try {
      return await recipe.run(page, params, pausable);
    } catch (err) {
      if (!(err instanceof RecipeError) || err.code !== "blocked") throw err;
      if (err.wall === undefined) throw !err.needsLogin && IP_REFUSAL_RE.test(err.message) ? withHint(err, IP_REFUSED_HINT) : err;
      if (pausable.pause === undefined) throw withHint(err, HEADLESS_HINT);
      if (attempt > 0) throw err;
      const outcome = await pausable.pause(err.wall, "", stepOf(site, err));
      if (outcome === "timeout") throw err;
      // "cleared": the owner dealt with it; navigate again on the same page.
    }
  }
}
