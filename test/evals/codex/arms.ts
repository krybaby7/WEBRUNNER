/**
 * How each Codex test arm is started (PLAN.md 17.4, WP55).
 *
 * Both arms run `codex exec` with the owner's config.toml ignored
 * (`--ignore-user-config`), so the owner's other MCP servers, Perplexity among
 * them, never load; Codex still signs in with the owner's ChatGPT plan from
 * CODEX_HOME. Everything an arm may use is set here with `-c`:
 *
 * - `alone`: Codex's own live web search, no MCP server.
 * - `webrunner`: Codex's web search off, and webrunner as the only MCP server,
 *   limited to its reach tools (no `deep_research`, so the agent runs its own
 *   search loop).
 *
 * Codex's other agent tools (shell, subagents, browser, apps, plugins, image
 * tools) are off in both arms, so the only way to the web is the arm's own;
 * `enable` switches named ones back on for an experiment.
 */

export const ARMS = ["alone", "webrunner"] as const;
export type Arm = (typeof ARMS)[number];

/** The webrunner tools the `webrunner` arm may call. */
export const WEBRUNNER_TOOLS = [
  "web_search",
  "fetch_page",
  "browse_task",
  "social_search",
  "search_reviews",
  "search_flights",
  "search_hotels",
  "market_quote",
  "exchange_rate",
  "weather",
] as const;

/** Added for the smoke check, which asks the agent to call `health`. */
export const SMOKE_TOOLS = ["health"] as const;

/**
 * Codex features switched off in both arms unless named in `enable`. The same
 * list the codex-cli backend uses (`src/core/llm/codex-cli.ts`); names a Codex
 * release does not know are ignored by `-c`, where `--disable` would fail.
 */
export const OFF_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "multi_agent",
  "browser_use",
  "computer_use",
  "image_generation",
  "goals",
  "skill_search",
  "tool_suggest",
  "view_image",
  "sleep_tool",
  "hooks",
  "workspace_dependencies",
] as const;

/** Variables that would make Codex bill an API key instead of the ChatGPT plan. */
export const API_KEY_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

/** The owner's own Codex model (config.toml, 2026-11-05). */
export const DEFAULT_MODEL = "gpt-6-astra";
/** Below the owner's usual "ultra", which uses a lot of plan quota. */
export const DEFAULT_EFFORT = "high";
/** Codex's default MCP tool timeout is 60 s; a browser recipe can take minutes. */
export const TOOL_TIMEOUT_SEC = 900;
export const STARTUP_TIMEOUT_SEC = 30;

/**
 * Which model backend the webrunner server uses for its own model calls
 * (browser recipes, review and social summaries, `browse_task`):
 * - `config`: the owner's config.json (claude-cli, on the Claude plan), as in daily use.
 * - `none`: no backend, so nothing touches the Claude plan; those steps fail or degrade.
 */
export const SERVER_LLMS = ["config", "none"] as const;
export type ServerLlm = (typeof SERVER_LLMS)[number];

/** A path no claude executable lives at: `claude-cli` then finds none, and the server runs without a backend. */
export const NO_CLAUDE_PATH = "webrunner-eval-no-claude/claude.exe";

export interface ArmOptions {
  /** The empty working directory Codex runs in (`-C`). */
  workDir: string;
  /** Where Codex writes its last message (`-o`). */
  lastMessageFile: string;
  model: string;
  effort: string;
  /** webrunner's built entry point, `dist/index.js`. */
  webrunnerEntry: string;
  /** The Node that starts webrunner. Default "node", as scripts/install-codex.sh registers it. */
  nodeCommand?: string;
  /** BROWSER_CDP_URL for the server: the owner's own Chrome. Unset: webrunner launches its own browser. */
  cdpUrl?: string;
  serverLlm: ServerLlm;
  /** OFF_FEATURES to leave on. */
  enable?: readonly string[];
  /** Adds SMOKE_TOOLS to the webrunner arm. */
  smoke?: boolean;
}

/** A TOML basic string. JSON's escapes are valid TOML for every character a path or URL holds. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/** The `codex` arguments for one run of `arm`. The prompt goes on stdin (the final `-`). */
export function codexArgs(arm: Arm, o: ArmOptions): string[] {
  const enable = new Set(o.enable ?? []);
  const off = OFF_FEATURES.filter((f) => !enable.has(f));
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "-s", "read-only",
    "--json",
    "-C", o.workDir,
    "-o", o.lastMessageFile,
    "-m", o.model,
    "-c", `model_reasoning_effort=${tomlString(o.effort)}`,
    "-c", "project_doc_max_bytes=0",
    ...off.flatMap((f) => ["-c", `features.${f}=false`]),
    "-c", `web_search=${tomlString(arm === "alone" ? "live" : "disabled")}`,
  ];
  if (arm === "webrunner") {
    const server = "mcp_servers.webrunner";
    const tools = [...WEBRUNNER_TOOLS, ...(o.smoke === true ? SMOKE_TOOLS : [])];
    args.push(
      "-c", `${server}.command=${tomlString(o.nodeCommand ?? "node")}`,
      "-c", `${server}.args=${tomlArray([o.webrunnerEntry.replaceAll("\\", "/")])}`,
      "-c", `${server}.enabled_tools=${tomlArray(tools)}`,
      // exec mode cannot ask for approval; without this a tool Codex judges to need one is refused.
      "-c", `${server}.default_tools_approval_mode="approve"`,
      "-c", `${server}.startup_timeout_sec=${STARTUP_TIMEOUT_SEC}`,
      "-c", `${server}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
    );
    if (o.cdpUrl !== undefined) args.push("-c", `${server}.env.BROWSER_CDP_URL=${tomlString(o.cdpUrl)}`);
    if (o.serverLlm === "none") {
      args.push(
        "-c", `${server}.env.WEBRUNNER_LLM_BACKEND="claude-cli"`,
        "-c", `${server}.env.WEBRUNNER_CLAUDE_PATH=${tomlString(NO_CLAUDE_PATH)}`,
        "-c", `${server}.env.WEBRUNNER_LLM_FALLBACK="none"`,
      );
    }
  }
  args.push("-");
  return args;
}

/** One-line description of an arm's setup, for the run's manifest and the dry run. */
export function describeArm(arm: Arm, o: Pick<ArmOptions, "cdpUrl" | "serverLlm" | "enable">): string {
  const extra = (o.enable ?? []).length > 0 ? `; also on: ${(o.enable ?? []).join(", ")}` : "";
  if (arm === "alone") return `Codex with its own live web search, no MCP servers${extra}`;
  const browser = o.cdpUrl !== undefined ? `the owner's Chrome at ${o.cdpUrl}` : "webrunner's own browser";
  const llm = o.serverLlm === "config" ? "the server's configured model backend" : "no server model backend";
  return `Codex with webrunner only (${WEBRUNNER_TOOLS.length} tools, no deep_research), web search off, ${browser}, ${llm}${extra}`;
}
