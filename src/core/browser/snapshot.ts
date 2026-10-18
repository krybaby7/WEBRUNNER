import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { Snapshot, SnapshotOptions, SnapshotRefInfo } from "./types.js";

/** Hard cap on lines in `axTree`, the truncation note included. */
export const MAX_SNAPSHOT_LINES = 400;

const MAX_NAME_CHARS = 120;
const MAX_STATE_VALUE_CHARS = 100;

/** Unnamed nodes with these roles carry no information; their children are hoisted. */
const TRANSPARENT_ROLES = new Set(["generic", "none", "presentation", "paragraph", "group", "rowgroup"]);

/** Roles whose inline YAML text is the control's value, not its name. */
const VALUE_ROLES = new Set(["textbox", "combobox", "searchbox", "spinbutton", "slider"]);

/** Roles accepted by Playwright's `getByRole`. Anything else falls back to `getByText`. */
const ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion",
  "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
  "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

interface AxNode {
  role: string;
  name: string;
  value?: string;
  states: string[];
  props: Record<string, string>;
  children: AxNode[];
}

// -- parsing the YAML emitted by Locator.ariaSnapshot() ------------------------

function unquoteYamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, s.endsWith('"') ? -1 : undefined);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replaceAll("''", "'");
  return s;
}

/** Split `key: value` where the key may be YAML-quoted. */
function splitKeyValue(body: string): { key: string; value: string | undefined } {
  const first = body[0];
  if (first === "'" || first === '"') {
    let i = 1;
    let key = "";
    while (i < body.length) {
      const ch = body[i] as string;
      if (first === "'" && ch === "'") {
        if (body[i + 1] === "'") {
          key += "'";
          i += 2;
          continue;
        }
        break;
      }
      if (first === '"' && ch === "\\") {
        key += ch + (body[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (first === '"' && ch === '"') break;
      key += ch;
      i++;
    }
    const after = body.slice(i + 1).trimStart();
    const decoded = first === '"' ? unquoteYamlScalar(`"${key}"`) : key;
    if (!after.startsWith(":")) return { key: decoded, value: undefined };
    const v = after.slice(1).trim();
    return { key: decoded, value: v === "" ? undefined : unquoteYamlScalar(v) };
  }
  const m = /: |:$/.exec(body);
  if (m === null) return { key: body.trim(), value: undefined };
  const v = body.slice(m.index + 1).trim();
  return { key: body.slice(0, m.index).trim(), value: v === "" ? undefined : unquoteYamlScalar(v) };
}

const KEY_RE = /^([^\s"[]+)(?:\s+("(?:[^"\\]|\\.)*"))?((?:\s+\[[^\]]*\])*)\s*$/;

/** Parse `Locator.ariaSnapshot()` output into a tree. Unknown line shapes degrade to a bare role. */
export function parseAriaSnapshot(yaml: string): AxNode[] {
  const roots: AxNode[] = [];
  const stack: Array<{ indent: number; node: AxNode }> = [];

  for (const line of yaml.split("\n")) {
    const m = /^(\s*)- (.*)$/.exec(line);
    if (m === null) continue;
    const indent = (m[1] as string).length;
    const { key, value } = splitKeyValue(m[2] as string);

    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;

    // `- /url: /x` is a property of the enclosing node, not a node.
    if (key.startsWith("/")) {
      if (parent !== undefined && value !== undefined) parent.props[key.slice(1)] = value;
      continue;
    }

    const km = KEY_RE.exec(key);
    const role = km?.[1] ?? key;
    const name = km?.[2] !== undefined ? unquoteYamlScalar(km[2]) : "";
    const states: string[] = [];
    for (const attr of (km?.[3] ?? "").matchAll(/\[([^\]]*)\]/g)) {
      const a = (attr[1] as string).trim();
      if (a !== "" && !a.startsWith("ref=")) states.push(a);
    }

    const node: AxNode = { role, name, states, props: {}, children: [] };
    if (value !== undefined) {
      if (role === "text") {
        node.name = value;
      } else if (VALUE_ROLES.has(role)) {
        node.value = value;
      } else if (name === "" && !TRANSPARENT_ROLES.has(role)) {
        node.name = value;
      } else {
        node.children.push({ role: "text", name: value, states: [], props: {}, children: [] });
      }
    }

    if (parent !== undefined) parent.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

// -- formatting ----------------------------------------------------------------

interface Entry {
  depth: number;
  node: AxNode;
  /** Zero-based index among emitted nodes with the same role and name, in document order. */
  nth: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function flatten(roots: AxNode[]): Entry[] {
  const entries: Entry[] = [];
  const seen = new Map<string, number>();
  const walk = (node: AxNode, depth: number): void => {
    const keep = node.role === "text" ? node.name !== "" : !(TRANSPARENT_ROLES.has(node.role) && node.name === "");
    if (keep) {
      const k = `${node.role}\u0000${node.name}`;
      const nth = seen.get(k) ?? 0;
      seen.set(k, nth + 1);
      entries.push({ depth, node, nth });
    }
    for (const c of node.children) walk(c, keep ? depth + 1 : depth);
  };
  for (const r of roots) walk(r, 0);
  return entries;
}

function formatLine(ref: string, e: Entry): string {
  const { node } = e;
  const parts = [`${"  ".repeat(e.depth)}[${ref}] ${node.role}`];
  if (node.name !== "") parts.push(JSON.stringify(truncate(node.name, MAX_NAME_CHARS)));
  const states = [...node.states];
  if (node.value !== undefined) states.push(`value=${JSON.stringify(truncate(node.value, MAX_STATE_VALUE_CHARS))}`);
  const href = node.props["url"];
  if (href !== undefined) states.push(`href=${JSON.stringify(truncate(href, MAX_STATE_VALUE_CHARS))}`);
  if (states.length > 0) parts.push(`{${states.join(",")}}`);
  return parts.join(" ");
}

function locatorFor(page: Page, e: Entry): Locator {
  const { role, name } = e.node;
  if (role !== "text" && ARIA_ROLES.has(role)) {
    // The cast is safe: ARIA_ROLES is a subset of Playwright's role union.
    const base = page.getByRole(
      role as Parameters<Page["getByRole"]>[0],
      name === "" ? {} : { name, exact: true },
    );
    return base.nth(e.nth);
  }
  return page.getByText(name, { exact: true }).nth(e.nth);
}

export interface FormattedTree {
  axTree: string;
  refs: Map<string, Locator>;
  refInfo: Map<string, SnapshotRefInfo>;
}

/** Turn a parsed tree into the compact text plus the ref maps. Exported for tests. */
export function formatTree(page: Page, roots: AxNode[]): FormattedTree {
  const entries = flatten(roots);
  const overflow = entries.length > MAX_SNAPSHOT_LINES;
  const shown = overflow ? entries.slice(0, MAX_SNAPSHOT_LINES - 1) : entries;

  const refs = new Map<string, Locator>();
  const refInfo = new Map<string, SnapshotRefInfo>();
  const lines: string[] = [];
  shown.forEach((e, i) => {
    const ref = `e${i + 1}`;
    lines.push(formatLine(ref, e));
    refs.set(ref, locatorFor(page, e));
    refInfo.set(ref, { role: e.node.role, name: e.node.name });
  });
  if (overflow) {
    lines.push(`... truncated: ${entries.length - shown.length} more nodes not shown (cap ${MAX_SNAPSHOT_LINES} lines)`);
  }
  return { axTree: lines.join("\n"), refs, refInfo };
}

/**
 * Snapshot a page for the generic browse agent (PLAN.md 4.4).
 *
 * The tree comes from `Locator.ariaSnapshot()` on `body`. Playwright's
 * `page.accessibility.snapshot()` is deprecated and, with its default
 * "interesting only" pruning, flattens list and table structure, so it is not
 * used. Limitation: content inside iframes is not part of the tree.
 *
 * Refs (`e1`, `e2`, ...) are assigned in document order to the nodes that
 * remain after dropping unnamed generic/presentational nodes, so an unchanged
 * page always produces the same refs. Each ref maps to a role+name locator
 * (`getByRole(role, { name, exact: true }).nth(k)`); if the page changes
 * between snapshot and action, the locator may match a different element or
 * none, so take a fresh snapshot after each action.
 */
export async function takeSnapshot(page: Page, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const yaml = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
  const { axTree, refs, refInfo } = formatTree(page, parseAriaSnapshot(yaml));

  const snapshot: Snapshot = {
    url: page.url(),
    title: await page.title(),
    axTree,
    refs,
    refInfo,
  };

  const wantsScreenshot = opts.screenshot === true || (axTree === "" && opts.screenshotDir !== undefined);
  if (wantsScreenshot) {
    if (opts.screenshotDir === undefined) {
      throw new Error("takeSnapshot: screenshot requested without screenshotDir");
    }
    await mkdir(opts.screenshotDir, { recursive: true });
    const path = join(opts.screenshotDir, `snapshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
    await page.screenshot({ path });
    snapshot.screenshotPath = path;
  }
  return snapshot;
}
