import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchable, npmShimTarget, resolveExecutable, Slots, withoutVars } from "../../../src/core/llm/process.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webrunner-process-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveExecutable", () => {
  it("finds a bare name on PATH, with PATHEXT on Windows and never the extensionless sh shim there", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "claude"), "#!/bin/sh\n");
    writeFileSync(join(b, "claude.exe"), "");
    // Lower-case PATHEXT so the lookup also matches on a case-sensitive file system (the Linux CI).
    expect(resolveExecutable("claude", { Path: `${a};${b}`, PATHEXT: ".com;.exe;.cmd" }, "win32")).toBe(join(b, "claude.exe"));
    // A POSIX PATH is colon-separated, which Windows drive letters ("C:") would break, so only on POSIX hosts.
    if (process.platform !== "win32") expect(resolveExecutable("claude", { PATH: `${a}:${b}` }, "linux")).toBe(join(a, "claude"));
  });

  it("takes a path with a directory part as it is, and undefined when nothing is there", () => {
    const exe = join(dir, "claude.exe");
    writeFileSync(exe, "");
    expect(resolveExecutable(exe, {}, "win32")).toBe(exe);
    expect(resolveExecutable(join(dir, "missing.exe"), {}, "win32")).toBeUndefined();
    expect(resolveExecutable("claude", { PATH: "" }, "linux")).toBeUndefined();
  });
});

describe("launchable", () => {
  it("runs a Node script under this Node, and an npm .cmd shim as the script it wraps", () => {
    expect(launchable("/x/fake.mjs", ["-p"])).toEqual({ command: process.execPath, args: ["/x/fake.mjs", "-p"] });
    const shim = join(dir, "codex.cmd");
    writeFileSync(
      shim,
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    expect(launchable(shim, ["exec"])).toEqual({ command: process.execPath, args: [join(dir, "node_modules\\@openai\\codex\\bin\\codex.js"), "exec"] });
    expect(launchable("C:/bin/claude.exe", ["-p"])).toEqual({ command: "C:/bin/claude.exe", args: ["-p"] });
  });

  it("leaves a .cmd file that is not an npm shim alone", () => {
    expect(npmShimTarget("x.cmd", "@echo off\r\nclaude.exe %*\r\n")).toBeUndefined();
  });
});

describe("withoutVars", () => {
  it("drops variables whatever their case", () => {
    expect(withoutVars({ ANTHROPIC_API_KEY: "a", anthropic_auth_token: "b", PATH: "p" }, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])).toEqual({ PATH: "p" });
  });
});

describe("Slots", () => {
  it("hands out at most `size` slots and the rest in order as they are released", async () => {
    const slots = new Slots(2);
    const r1 = await slots.acquire();
    const r2 = await slots.acquire();
    const order: number[] = [];
    const third = slots.acquire().then((r) => (order.push(3), r));
    const fourth = slots.acquire().then((r) => (order.push(4), r));
    expect(slots.inUse).toBe(2);
    r1();
    r1(); // releasing twice frees one slot only
    const r3 = await third;
    expect(order).toEqual([3]);
    r2();
    const r4 = await fourth;
    expect(order).toEqual([3, 4]);
    r3();
    r4();
    expect(slots.inUse).toBe(0);
  });

  it("stops waiting when the signal aborts", async () => {
    const slots = new Slots(1);
    const held = await slots.acquire();
    const controller = new AbortController();
    const waiting = slots.acquire(controller.signal);
    controller.abort(new Error("gone"));
    await expect(waiting).rejects.toThrow("gone");
    held();
    expect(slots.inUse).toBe(0);
  });
});
