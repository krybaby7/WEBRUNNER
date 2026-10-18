import { ACCOUNT_PLATFORMS, type AccountPlatform } from "../../schemas/accounts.js";

/**
 * The account platform table, PLAN.md 14.7. For each platform: the cookie
 * domains it owns (what `disconnect` clears), where its login page is, which
 * session cookies prove a login, and which tools read through that login.
 *
 * Nothing here is a secret and no cookie value is ever read through it; the
 * table only names cookies.
 */

/**
 * The cookies that prove a login. `required` is a list of groups: every
 * group must have at least one of its names present and unexpired. So
 * `[["SID"], ["SAPISID"]]` means both, and `[["x-main", "at-main"]]` means
 * either.
 */
export interface SessionCookieRule {
  /** Cookies count only on this domain or a subdomain of it (leading dot ignored). */
  domain: string;
  required: string[][];
}

export interface AccountPlatformSpec {
  platform: AccountPlatform;
  /** Cookie domains cleared by `disconnect`; a domain covers its subdomains. */
  domains: string[];
  loginUrl: string;
  sessionCookies: SessionCookieRule;
  /** Tools (and the platforms within them) that read through this login. Empty: listed for future recipes. */
  usedBy: string[];
}

export type AccountPlatformTable = Record<AccountPlatform, AccountPlatformSpec>;

export const ACCOUNT_PLATFORM_TABLE: AccountPlatformTable = {
  reddit: {
    platform: "reddit",
    domains: ["reddit.com"],
    loginUrl: "https://www.reddit.com/login/",
    sessionCookies: { domain: "reddit.com", required: [["reddit_session"]] },
    usedBy: ["social_search (reddit)"],
  },
  x: {
    platform: "x",
    domains: ["x.com", "twitter.com"],
    loginUrl: "https://x.com/i/flow/login",
    sessionCookies: { domain: "x.com", required: [["auth_token"]] },
    usedBy: ["social_search (x)"],
  },
  facebook: {
    platform: "facebook",
    domains: ["facebook.com"],
    loginUrl: "https://www.facebook.com/login/",
    sessionCookies: { domain: "facebook.com", required: [["c_user"]] },
    usedBy: ["social_search (facebook)"],
  },
  instagram: {
    platform: "instagram",
    domains: ["instagram.com"],
    loginUrl: "https://www.instagram.com/accounts/login/",
    sessionCookies: { domain: "instagram.com", required: [["sessionid"]] },
    usedBy: [],
  },
  google: {
    platform: "google",
    domains: ["google.com"],
    loginUrl: "https://accounts.google.com/",
    sessionCookies: { domain: "google.com", required: [["SID"], ["SAPISID"]] },
    usedBy: ["search_hotels", "search_reviews (google_maps, google_play)", "search_flights (consent and personalisation only)"],
  },
  amazon: {
    platform: "amazon",
    domains: ["amazon.com"],
    loginUrl:
      "https://www.amazon.com/ap/signin?openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0" +
      "&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select" +
      "&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select" +
      "&openid.assoc_handle=usflex&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F",
    sessionCookies: { domain: "amazon.com", required: [["x-main", "at-main"]] },
    usedBy: ["search_reviews (amazon)"],
  },
  linkedin: {
    platform: "linkedin",
    domains: ["linkedin.com"],
    loginUrl: "https://www.linkedin.com/login",
    sessionCookies: { domain: "linkedin.com", required: [["li_at"]] },
    usedBy: [],
  },
};

/** The platforms in schema order, so `list` output is stable. */
export function platformsInOrder(table: AccountPlatformTable = ACCOUNT_PLATFORM_TABLE): AccountPlatformSpec[] {
  return ACCOUNT_PLATFORMS.map((p) => table[p]);
}
