import { describe, expect, it } from "vitest";
import { ACCOUNT_PLATFORM_TABLE, platformsInOrder } from "../../../src/core/accounts/platforms.js";
import { ACCOUNT_PLATFORMS } from "../../../src/schemas/accounts.js";

describe("account platform table (PLAN.md 14.7)", () => {
  it("covers exactly the seven schema platforms, in schema order", () => {
    expect(Object.keys(ACCOUNT_PLATFORM_TABLE).sort()).toEqual([...ACCOUNT_PLATFORMS].sort());
    expect(platformsInOrder().map((p) => p.platform)).toEqual([...ACCOUNT_PLATFORMS]);
    for (const [key, spec] of Object.entries(ACCOUNT_PLATFORM_TABLE)) expect(spec.platform).toBe(key);
  });

  it("has an https login URL, at least one domain and at least one non-empty cookie group per platform", () => {
    for (const spec of platformsInOrder()) {
      expect(new URL(spec.loginUrl).protocol).toBe("https:");
      expect(spec.domains.length).toBeGreaterThan(0);
      expect(spec.sessionCookies.required.length).toBeGreaterThan(0);
      for (const group of spec.sessionCookies.required) expect(group.length).toBeGreaterThan(0);
      // The session cookie's domain is one the platform owns, so disconnect clears it.
      expect(spec.domains.some((d) => spec.sessionCookies.domain === d || spec.sessionCookies.domain.endsWith(`.${d}`))).toBe(true);
    }
  });

  it("names the session cookies the plan lists", () => {
    const t = ACCOUNT_PLATFORM_TABLE;
    expect(t.reddit.sessionCookies).toEqual({ domain: "reddit.com", required: [["reddit_session"]] });
    expect(t.x.sessionCookies).toEqual({ domain: "x.com", required: [["auth_token"]] });
    expect(t.facebook.sessionCookies).toEqual({ domain: "facebook.com", required: [["c_user"]] });
    expect(t.instagram.sessionCookies).toEqual({ domain: "instagram.com", required: [["sessionid"]] });
    // Google needs both; Amazon needs either.
    expect(t.google.sessionCookies).toEqual({ domain: "google.com", required: [["SID"], ["SAPISID"]] });
    expect(t.amazon.sessionCookies).toEqual({ domain: "amazon.com", required: [["x-main", "at-main"]] });
    expect(t.linkedin.sessionCookies).toEqual({ domain: "linkedin.com", required: [["li_at"]] });
  });

  it("says which tools read through each login", () => {
    const t = ACCOUNT_PLATFORM_TABLE;
    expect(t.reddit.usedBy).toEqual(["social_search (reddit)"]);
    expect(t.x.usedBy).toEqual(["social_search (x)"]);
    expect(t.facebook.usedBy).toEqual(["social_search (facebook)"]);
    expect(t.google.usedBy).toEqual([
      "search_hotels",
      "search_reviews (google_maps, google_play)",
      "search_flights (consent and personalisation only)",
    ]);
    expect(t.amazon.usedBy).toEqual(["search_reviews (amazon)"]);
    expect(t.instagram.usedBy).toEqual([]);
    expect(t.linkedin.usedBy).toEqual([]);
  });
});
