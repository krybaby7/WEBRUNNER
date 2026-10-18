/**
 * URL canonicalization, PLAN.md section 4.1. Used for dedupe in fusion and for
 * the `url` field of web_search results.
 *
 * Rules:
 *   - lowercase scheme and host, strip a leading "www."
 *   - remove the default port (80 for http, 443 for https)
 *   - strip the fragment
 *   - strip tracking parameters: utm_*, fbclid, gclid, ref, ref_src, mc_cid,
 *     mc_eid, igshid (names compared case-insensitively)
 *   - sort the remaining query parameters by name, then value
 *   - strip trailing slashes from the path, except for the bare root "/"
 *   - percent-decode unreserved characters (A-Z a-z 0-9 - . _ ~) and upper-case
 *     the hex digits of the escapes that remain
 *
 * Input that cannot be parsed as an absolute URL is returned trimmed and
 * otherwise unchanged. The function never throws.
 */

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "ref", "ref_src", "mc_cid", "mc_eid", "igshid"]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

/** Decode %XX escapes of unreserved characters; normalize the hex case of the rest. */
function normalizeEscapes(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const code = parseInt(hex, 16);
    const ch = String.fromCharCode(code);
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/** Decoded parameter name, for matching against the tracking list. */
function paramName(rawPair: string): string {
  const raw = rawPair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return "";
  const pairs = raw
    .split("&")
    .filter((p) => p !== "")
    .filter((p) => !isTrackingParam(paramName(p)))
    .map(normalizeEscapes);
  if (pairs.length === 0) return "";
  pairs.sort((a, b) => {
    const [ak = "", ...av] = a.split("=");
    const [bk = "", ...bv] = b.split("=");
    return compareStrings(ak, bk) || compareStrings(av.join("="), bv.join("="));
  });
  return `?${pairs.join("&")}`;
}

export function canonicalizeUrl(url: string): string {
  const trimmed = url.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  // Opaque URLs (mailto:, data:, javascript:) have no host to canonicalize.
  if (u.host === "") return trimmed;

  // The URL parser lowercases scheme and host and already drops default ports.
  let hostname = u.hostname;
  if (hostname.startsWith("www.") && hostname.indexOf(".", 4) !== -1) hostname = hostname.slice(4);
  const host = u.port !== "" ? `${hostname}:${u.port}` : hostname;

  const userinfo =
    u.username !== "" ? `${u.username}${u.password !== "" ? `:${u.password}` : ""}@` : "";

  let path = normalizeEscapes(u.pathname);
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";

  return `${u.protocol}//${userinfo}${host}${path}${canonicalQuery(u.search)}`;
}
