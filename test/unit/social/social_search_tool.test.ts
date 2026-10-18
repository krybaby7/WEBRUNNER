import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DailyCostCap } from "../../../src/core/llm/daily-cap.js";
import { SocialProviderError } from "../../../src/core/social/types.js";
import type { Deps } from "../../../src/deps.js";
import { ErrorEnvelopeSchema } from "../../../src/schemas/error.js";
import { SocialSearchOutputSchema } from "../../../src/schemas/social.js";
import { registerTools } from "../../../src/tools/index.js";
import { registerSocialSearchTool, type SocialSearchToolOptions } from "../../../src/tools/social_search.js";
import { makeConfig } from "../llm/helpers.js";
import { scriptedLlm } from "../research/helpers.js";
import { callTool, connectServer, type Connected } from "../tools/helpers.js";
import { fakePlatform, forever, item, makeLogger } from "./helpers.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

function deps(over: Partial<Deps> = {}): Deps {
  return { config: makeConfig(), log: makeLogger(), ...over };
}

async function connect(d: Deps, options: SocialSearchToolOptions): Promise<Connected> {
  const c = await connectServer((server) => registerSocialSearchTool(server, d, options));
  open.push(() => c.close());
  return c;
}

function envelope(result: Awaited<ReturnType<typeof callTool>>) {
  expect(result.isError).toBe(true);
  const parsed = ErrorEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(parsed);
  return parsed.error;
}

describe("social_search tool", () => {
  it("registers under registerTools with a description that names keys, accounts, url mode and the terms of service", async () => {
    const c = await connectServer((server) => registerTools(server, deps()));
    open.push(() => c.close());
    const tool = (await c.client.listTools()).tools.find((t) => t.name === "social_search");
    expect(tool).toBeDefined();
    const d = tool?.description ?? "";
    expect(d).toContain("YOUTUBE_API_KEY");
    expect(d).toContain("REDDIT_CLIENT_ID");
    expect(d).toContain("accounts");
    expect(d).toMatch(/needs_login/);
    expect(d).toMatch(/`url`/);
    expect(d).toMatch(/comments/);
    expect(d).toMatch(/terms of service/);
    expect(d).toMatch(/X and Facebook/);
    expect(d).toMatch(/180 seconds/);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("returns a schema-valid result with items from the fake platforms", async () => {
    const hn = fakePlatform("hackernews", { search: () => Promise.resolve([item({ id: "hackernews:1", score: 3 })]) });
    const { client } = await connect(deps(), { platforms: () => [hn] });
    const result = await callTool(client, "social_search", { query: "rust", platforms: ["hackernews"], kind: "posts" });
    expect(result.isError).toBeUndefined();
    const out = SocialSearchOutputSchema.parse(result.structuredContent);
    expect(out.items.map((i) => i.id)).toEqual(["hackernews:1"]);
    expect(out.query).toMatchObject({ mode: "search", query: "rust", platforms: ["hackernews"], kind: "posts" });
    expect(hn.searches[0]?.q.kind).toBe("posts");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(out);
  });

  it("returns invalid_input for a URL no platform owns, and the SDK rejects schema violations before the handler", async () => {
    const { client } = await connect(deps(), { platforms: () => [fakePlatform("hackernews", { owns: () => false })] });
    const err = envelope(await callTool(client, "social_search", { url: "https://example.org/thread/1" }));
    expect(err.code).toBe("invalid_input");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("example.org");
    // Neither query nor url: the SDK's own schema check answers (PLAN.md section 3), not a 3.6 envelope.
    const sdk = await callTool(client, "social_search", {});
    expect(sdk.isError).toBe(true);
    expect(sdk.content[0]?.text).toContain("Input validation error");
    expect(sdk.structuredContent).toBeUndefined();
  });

  it("returns config when nothing is configured", async () => {
    const { client } = await connect(deps(), { platforms: () => [fakePlatform("youtube", { configured: false })] });
    const err = envelope(await callTool(client, "social_search", { query: "rust" }));
    expect(err.code).toBe("config");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("YOUTUBE_API_KEY");
  });

  it("returns timeout with the per-platform cap when every platform is too slow", async () => {
    const slow = fakePlatform("hackernews", { search: () => forever() });
    const { client } = await connect(deps(), { platforms: () => [slow], timeoutsMs: { api: 40 } });
    const err = envelope(await callTool(client, "social_search", { query: "rust" }));
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ platforms_failed: [{ platform: "hackernews", needs_login: false }] });
  });

  it("returns timeout from the wall clock when the whole call runs past its cap", async () => {
    const slow = fakePlatform("hackernews", { access: "browser", search: () => forever() });
    const { client } = await connect(deps(), { platforms: () => [slow], wallClockMs: 60 });
    const err = envelope(await callTool(client, "social_search", { query: "rust" }));
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/did not finish within/);
  });

  it("returns budget_exceeded before doing any work when summarize is on and the daily cap is spent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webrunner-social-cap-"));
    open.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));
    const cap = new DailyCostCap({ capUsd: 1, dir, now: () => Date.parse("2026-10-18T10:00:00Z"), log: makeLogger() });
    cap.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1.5);
    const hn = fakePlatform("hackernews");
    const { client } = await connect(deps({ dailyCap: cap, llm: scriptedLlm({ extractor: [] }) }), { platforms: () => [hn] });
    const err = envelope(await callTool(client, "social_search", { query: "rust", summarize: true }));
    expect(err.code).toBe("budget_exceeded");
    expect(hn.searches).toHaveLength(0);
    // Without summarize the cap does not apply: no LLM spend is possible.
    const ok = await callTool(client, "social_search", { query: "rust" });
    expect(ok.isError).toBeUndefined();
  });

  it("maps a login wall on the only platform to blocked, with needs_login in the details", async () => {
    const x = fakePlatform("x", {
      access: "browser",
      search: () => Promise.reject(new SocialProviderError("X asks for a login", { platform: "x", code: "blocked", retryable: false, needsLogin: true })),
    });
    const { client } = await connect(deps(), { platforms: () => [x] });
    const err = envelope(await callTool(client, "social_search", { query: "rust" }));
    expect(err.code).toBe("blocked");
    expect(err.details).toEqual({ platforms_failed: [{ platform: "x", error: "X asks for a login", needs_login: true }] });
  });

  it("builds the service once so platform state (a Reddit token) survives across calls", async () => {
    let built = 0;
    const hn = fakePlatform("hackernews");
    const { client } = await connect(deps(), {
      platforms: () => {
        built += 1;
        return [hn];
      },
    });
    await callTool(client, "social_search", { query: "a" });
    await callTool(client, "social_search", { query: "b" });
    expect(built).toBe(1);
    expect(hn.searches).toHaveLength(2);
  });
});
