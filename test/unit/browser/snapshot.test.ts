import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../src/core/browser/types.js";
import {
  MAX_SNAPSHOT_LINES,
  formatTree,
  parseAriaSnapshot,
  takeSnapshot,
} from "../../../src/core/browser/snapshot.js";
import { makeConfig, makeTempDir, probeChromium, removeDir, startFixtureServer, type FixtureServer } from "./helpers.js";

const probe = await probeChromium();

describe("parseAriaSnapshot (no browser needed)", () => {
  it("parses roles, names, states, inline values, props and nesting", () => {
    const tree = parseAriaSnapshot(
      [
        "- heading \"Hi\" [level=1]",
        "- link \"Docs\":",
        "  - /url: /docs",
        "- textbox \"Name\": Ada",
        "- list:",
        "  - listitem: first",
        "  - listitem:",
        "    - link \"Nested\"",
        "- 'button \"Say: hi\"'",
        "- checkbox \"Agree\" [checked]",
      ].join("\n"),
    );
    expect(tree.map((n) => n.role)).toEqual(["heading", "link", "textbox", "list", "button", "checkbox"]);
    expect(tree[0]).toMatchObject({ name: "Hi", states: ["level=1"] });
    expect(tree[1]?.props["url"]).toBe("/docs");
    expect(tree[2]).toMatchObject({ name: "Name", value: "Ada" });
    expect(tree[3]?.children.map((c) => c.name)).toEqual(["first", ""]);
    expect(tree[3]?.children[1]?.children[0]?.name).toBe("Nested");
    expect(tree[4]?.name).toBe("Say: hi");
    expect(tree[5]?.states).toEqual(["checked"]);
  });
});

describe.skipIf(!probe.available)(`takeSnapshot${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: FixtureServer;
  let session: BrowserSession;
  let profileDir: string;
  let shotDir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await makeTempDir();
    shotDir = await makeTempDir("webrunner-shots-");
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
    if (shotDir) await removeDir(shotDir);
  }, 30_000);

  async function withPage<T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await session.acquire();
    try {
      await page.goto(url);
      return await fn(page);
    } finally {
      await session.release(page);
    }
  }

  it("formats a page as one node per line with depth indentation and bracketed refs", async () => {
    const snap = await withPage(`${server.url}/snapshot.html`, (p) => takeSnapshot(p));
    expect(snap.url).toBe(`${server.url}/snapshot.html`);
    expect(snap.title).toBe("Snapshot Fixture");

    const lines = snap.axTree.split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_SNAPSHOT_LINES);
    for (const line of lines) expect(line).toMatch(/^ *\[e\d+\] \S+/);

    // buttons, links, form fields, states
    expect(snap.axTree).toContain('button "Search flights"');
    expect(snap.axTree).toContain('button "Reset" {disabled}');
    expect(snap.axTree).toContain('link "Deals" {href="/deals"}');
    expect(snap.axTree).toContain('form "Search form"');
    expect(snap.axTree).toContain('textbox "From" {value="SFO"}');
    expect(snap.axTree).toContain('checkbox "Flexible dates" {checked}');
    expect(snap.axTree).toContain('heading "Flight Search" {level=1}');

    // nesting: the inner list is indented deeper than the outer one
    const indentOf = (needle: string): number => {
      const line = lines.find((l) => l.includes(needle));
      expect(line, `line containing ${needle}`).toBeDefined();
      return (line as string).search(/\S/);
    };
    expect(indentOf('link "SFO to LAX"')).toBeGreaterThan(indentOf('text "West coast"'));
    expect(indentOf('button "Search flights"')).toBeGreaterThan(indentOf('form "Search form"'));
    expect(indentOf('link "Deals"')).toBeGreaterThan(indentOf('navigation "Main"'));
  });

  it("drops unnamed generic nodes (wrapper divs and spans)", async () => {
    const snap = await withPage(`${server.url}/snapshot.html`, (p) => takeSnapshot(p));
    expect(snap.axTree).not.toMatch(/\] (generic|none|presentation|paragraph|group)\b/);
    for (const info of snap.refInfo.values()) {
      expect(["generic", "none", "presentation"]).not.toContain(info.role);
    }
  });

  it("assigns the same refs to the same nodes across two snapshots, and they are unique and sequential", async () => {
    const [a, b] = await withPage(`${server.url}/snapshot.html`, async (p) => [
      await takeSnapshot(p),
      await takeSnapshot(p),
    ]);
    expect(b?.axTree).toBe(a?.axTree);
    expect([...(b?.refs.keys() ?? [])]).toEqual([...(a?.refs.keys() ?? [])]);
    expect([...(a?.refInfo.entries() ?? [])]).toEqual([...(b?.refInfo.entries() ?? [])]);
    const refs = [...(a?.refs.keys() ?? [])];
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs[0]).toBe("e1");
    expect(refs[refs.length - 1]).toBe(`e${refs.length}`);
  });

  it("maps refs back to the right elements, including duplicate role+name pairs", async () => {
    await withPage(`${server.url}/snapshot.html`, async (p) => {
      const snap = await takeSnapshot(p);
      const refFor = (role: string, name: string, nth = 0): string => {
        const hits = [...snap.refInfo.entries()].filter(([, v]) => v.role === role && v.name === name);
        const hit = hits[nth];
        expect(hit, `${role} ${name} #${nth}`).toBeDefined();
        return (hit as [string, unknown])[0];
      };
      const loc = (ref: string) => {
        const l = snap.refs.get(ref);
        expect(l, ref).toBeDefined();
        return l as NonNullable<typeof l>;
      };

      expect(await loc(refFor("button", "Search flights")).count()).toBe(1);
      expect(await loc(refFor("textbox", "From")).inputValue()).toBe("SFO");
      expect(await loc(refFor("button", "Reset")).isDisabled()).toBe(true);

      // Two links named "Help" resolve to two distinct elements.
      const help0 = loc(refFor("link", "Help", 0));
      const help1 = loc(refFor("link", "Help", 1));
      expect(await help0.count()).toBe(1);
      expect(await help1.count()).toBe(1);
      expect(await help0.evaluate((el, other) => el === other, await help1.elementHandle())).toBe(false);

      // Clicking a ref really clicks the element.
      await loc(refFor("link", "SFO to LAX")).click();
      await p.waitForURL(/\/r\/sfo-lax$/);
    });
  });

  it("caps the tree at 400 lines and says so on the last line", async () => {
    const snap = await withPage("about:blank", async (p) => {
      const items = Array.from({ length: 600 }, (_, i) => `<li><a href="#n${i}">Item ${i}</a></li>`).join("");
      await p.setContent(`<ul>${items}</ul>`);
      return takeSnapshot(p);
    });
    const lines = snap.axTree.split("\n");
    expect(lines).toHaveLength(MAX_SNAPSHOT_LINES);
    expect(lines[lines.length - 1]).toMatch(/^\.\.\. truncated: \d+ more nodes not shown/);
    expect(snap.refs.size).toBe(MAX_SNAPSHOT_LINES - 1);
  });

  it("returns an empty tree for a blank page and takes a screenshot when a directory is given", async () => {
    const snap = await withPage("about:blank", (p) => takeSnapshot(p, { screenshotDir: shotDir }));
    expect(snap.axTree).toBe("");
    expect(snap.screenshotPath).toBeDefined();
    expect(snap.screenshotPath?.startsWith(shotDir)).toBe(true);
  });

  it("writes a PNG when a screenshot is requested", async () => {
    const snap = await withPage(`${server.url}/snapshot.html`, (p) =>
      takeSnapshot(p, { screenshot: true, screenshotDir: join(shotDir, "nested") }),
    );
    const path = snap.screenshotPath as string;
    expect(path).toMatch(/\.png$/);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(500);
    expect(readFileSync(path).subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("does not screenshot unless asked", async () => {
    const snap = await withPage(`${server.url}/snapshot.html`, (p) => takeSnapshot(p, { screenshotDir: shotDir }));
    expect(snap.screenshotPath).toBeUndefined();
  });

  it("formatTree is deterministic for the same parsed input", async () => {
    await withPage(`${server.url}/snapshot.html`, async (p) => {
      const yaml = await p.locator("body").ariaSnapshot();
      const one = formatTree(p, parseAriaSnapshot(yaml));
      const two = formatTree(p, parseAriaSnapshot(yaml));
      expect(one.axTree).toBe(two.axTree);
    });
  });
});
