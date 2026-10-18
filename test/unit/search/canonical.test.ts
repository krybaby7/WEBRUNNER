import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../../../src/core/search/canonical.js";

const cases: Array<[name: string, input: string, expected: string]> = [
  ["lowercases scheme and host", "HTTPS://Example.COM/Path", "https://example.com/Path"],
  ["keeps path case", "https://example.com/Some/Path", "https://example.com/Some/Path"],
  ["strips www.", "https://www.example.com/a", "https://example.com/a"],
  ["strips www. after lowercasing", "https://WWW.Example.com/a", "https://example.com/a"],
  ["keeps other subdomains", "https://blog.example.com/a", "https://blog.example.com/a"],
  ["strips the fragment", "https://example.com/a#section-2", "https://example.com/a"],
  ["strips a fragment after a query", "https://example.com/a?x=1#top", "https://example.com/a?x=1"],
  ["strips utm_* params", "https://example.com/a?utm_source=x&utm_medium=y&id=7", "https://example.com/a?id=7"],
  ["strips utm_ case-insensitively", "https://example.com/a?UTM_Campaign=x&id=7", "https://example.com/a?id=7"],
  ["strips fbclid and gclid", "https://example.com/a?fbclid=abc&gclid=def&q=1", "https://example.com/a?q=1"],
  ["strips ref and ref_src", "https://example.com/a?ref=home&ref_src=twsrc&q=1", "https://example.com/a?q=1"],
  ["strips mc_cid, mc_eid and igshid", "https://example.com/a?mc_cid=1&mc_eid=2&igshid=3&q=1", "https://example.com/a?q=1"],
  ["keeps params that only look similar", "https://example.com/a?referrer=x&utmx=1&reference=2", "https://example.com/a?reference=2&referrer=x&utmx=1"],
  ["drops the query entirely when only tracking params remain", "https://example.com/a?utm_source=x&fbclid=y", "https://example.com/a"],
  ["sorts query params by name", "https://example.com/a?b=2&a=1&c=3", "https://example.com/a?a=1&b=2&c=3"],
  ["sorts repeated params by value", "https://example.com/a?t=b&t=a", "https://example.com/a?t=a&t=b"],
  ["strips a trailing slash", "https://example.com/a/b/", "https://example.com/a/b"],
  ["strips repeated trailing slashes", "https://example.com/a///", "https://example.com/a"],
  ["keeps the bare root slash", "https://example.com/", "https://example.com/"],
  ["adds the root slash to a bare host", "https://example.com", "https://example.com/"],
  ["keeps the root slash before a query", "https://example.com/?b=2&a=1", "https://example.com/?a=1&b=2"],
  ["removes default https port", "https://example.com:443/a", "https://example.com/a"],
  ["removes default http port", "http://example.com:80/a", "http://example.com/a"],
  ["keeps a non-default port", "https://example.com:8443/a", "https://example.com:8443/a"],
  ["keeps http:80 on https (non-default there)", "https://example.com:80/a", "https://example.com:80/a"],
  ["decodes unreserved characters in the path", "https://example.com/%7Euser/%61bc", "https://example.com/~user/abc"],
  ["keeps reserved escapes, upper-casing the hex", "https://example.com/a%2fb%3f", "https://example.com/a%2Fb%3F"],
  ["decodes unreserved characters in the query", "https://example.com/a?q=%41%2d%42", "https://example.com/a?q=A-B"],
  ["keeps encoded spaces in the query", "https://example.com/a?q=a%20b", "https://example.com/a?q=a%20b"],
  ["matches tracking params written with escapes", "https://example.com/a?%75tm_source=x&q=1", "https://example.com/a?q=1"],
  [
    "combines every rule",
    "HTTP://WWW.Example.com:80/Docs/%7Eguide/?utm_source=nl&b=2&a=%41&fbclid=z#intro",
    "http://example.com/Docs/~guide?a=A&b=2",
  ],
  [
    "is idempotent on already canonical input",
    "https://example.com/a/b?a=1&b=2",
    "https://example.com/a/b?a=1&b=2",
  ],
  ["trims surrounding whitespace on valid URLs", "  https://www.example.com/a/  ", "https://example.com/a"],
  ["keeps userinfo", "https://user:pw@www.example.com/a", "https://user:pw@example.com/a"],
  ["does not strip www from a bare two-label remainder", "https://www.com/a", "https://www.com/a"],
  ["returns unparseable input trimmed and unchanged", "  not a url/  ", "not a url/"],
  ["returns a relative URL unchanged", "/relative/path/?utm_source=x", "/relative/path/?utm_source=x"],
  ["returns an empty string unchanged", "", ""],
  ["leaves opaque schemes unchanged", "mailto:Someone@Example.com", "mailto:Someone@Example.com"],
];

describe("canonicalizeUrl", () => {
  it("has at least 15 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it.each(cases)("%s", (_name, input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it("is idempotent for every valid case", () => {
    for (const [, , expected] of cases) {
      expect(canonicalizeUrl(expected)).toBe(expected);
    }
  });

  it("maps equivalent spellings to the same string", () => {
    const variants = [
      "https://www.example.com/a/?utm_source=x&b=2&a=1#frag",
      "HTTPS://EXAMPLE.COM:443/a?a=1&b=2",
      "https://example.com/a?b=2&a=1&gclid=q",
    ];
    expect(new Set(variants.map(canonicalizeUrl)).size).toBe(1);
  });
});
