import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LOG_LEVELS, log, type LogLevel } from "./log.js";

/**
 * Configuration, PLAN.md section 4.8.
 *
 * Sources, highest priority first:
 *   1. environment variables
 *   2. ~/.config/webrunner/config.json (keys are the lowercase variable names,
 *      for example "brave_api_key")
 *   3. built-in defaults
 *
 * Empty environment variables count as unset.
 */

/** Per-role model routing, PLAN.md section 4.6. */
export interface ModelRoles {
  planner: string;
  scorer: string;
  extractor: string;
  writer: string;
}

export const DEFAULT_MODELS: ModelRoles = {
  planner: "claude-opus-5-5",
  scorer: "claude-haiku-5-5",
  extractor: "claude-sonnet-5-5",
  writer: "claude-opus-5-5",
};

export interface Config {
  /**
   * Optional at startup by decision (PLAN.md section 1): search and fetch work
   * without it. Tools that need the LLM return error code "config" when unset.
   */
  anthropic_api_key?: string;
  brave_api_key?: string;
  exa_api_key?: string;
  tavily_api_key?: string;
  perplexity_api_key?: string;
  firecrawl_api_key?: string;
  jina_api_key?: string;
  duffel_api_key?: string;
  browser: {
    /** Attach to the owner's running Chrome instead of launching one. */
    cdp_url?: string;
    /** Undefined means "headful when a display exists, headless otherwise". */
    headless?: boolean;
    profile_dir: string;
  };
  /** Default hard cost cap per deep_research call, in USD. */
  research_max_cost_usd: number;
  /** Wall-clock cap for one deep_research call, in milliseconds. Default 900000 (15 minutes). */
  research_max_ms: number;
  /**
   * Soft cap on LLM spend per UTC day across every tool and call of this
   * machine, in USD. Unset means off. Tracked in a small file under cache_dir.
   */
  daily_cost_cap_usd?: number;
  cache_dir: string;
  log_level: LogLevel;
  /** Save browse_task screenshots under the run dir. */
  save_screenshots: boolean;
  /** ISO 4217 default currency for search_flights. */
  currency: string;
  models: ModelRoles;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Config key, environment variable name. */
const ENV_VARS = {
  anthropic_api_key: "ANTHROPIC_API_KEY",
  brave_api_key: "BRAVE_API_KEY",
  exa_api_key: "EXA_API_KEY",
  tavily_api_key: "TAVILY_API_KEY",
  perplexity_api_key: "PERPLEXITY_API_KEY",
  firecrawl_api_key: "FIRECRAWL_API_KEY",
  jina_api_key: "JINA_API_KEY",
  duffel_api_key: "DUFFEL_API_KEY",
  browser_cdp_url: "BROWSER_CDP_URL",
  browser_headless: "BROWSER_HEADLESS",
  research_max_cost_usd: "RESEARCH_MAX_COST_USD",
  research_max_ms: "WEBRUNNER_RESEARCH_MAX_MS",
  daily_cost_cap_usd: "WEBRUNNER_DAILY_COST_CAP_USD",
  cache_dir: "WEBRUNNER_CACHE_DIR",
  log_level: "WEBRUNNER_LOG_LEVEL",
  browser_profile_dir: "WEBRUNNER_BROWSER_PROFILE_DIR",
  save_screenshots: "WEBRUNNER_SAVE_SCREENSHOTS",
  currency: "WEBRUNNER_CURRENCY",
  model_planner: "WEBRUNNER_MODEL_PLANNER",
  model_scorer: "WEBRUNNER_MODEL_SCORER",
  model_extractor: "WEBRUNNER_MODEL_EXTRACTOR",
  model_writer: "WEBRUNNER_MODEL_WRITER",
} as const;

type RawKey = keyof typeof ENV_VARS;

const ALL_KEYS: readonly RawKey[] = Object.keys(ENV_VARS) as RawKey[];

const SCALAR = z.union([z.string(), z.number(), z.boolean()]);

/** Shape of ~/.config/webrunner/config.json. Unknown keys are rejected (typo guard). */
const FileSchema = z
  .object(Object.fromEntries(ALL_KEYS.map((k) => [k, SCALAR.optional()])))
  .strict();

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

const booleanLike = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const s = v.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
    return v;
  },
  z.boolean({ error: "must be true or false (also accepts 1/0, yes/no, on/off)" }),
);

const positiveNumber = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z
    .number({ error: "must be a number, for example 3.00" })
    .positive({ error: "must be greater than 0" })
    .finite({ error: "must be a finite number" }),
);

/** Whole milliseconds, at least one second. */
const durationMs = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z
    .number({ error: "must be a number of milliseconds, for example 900000" })
    .int({ error: "must be a whole number of milliseconds" })
    .min(1000, { error: "must be at least 1000 (one second)" }),
);

const nonEmptyString = z.string({ error: "must be a string" }).trim().min(1, { error: "must not be empty" });

const logLevel = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(", ")}` }),
);

const ResolvedSchema = z.object({
  anthropic_api_key: nonEmptyString.optional(),
  brave_api_key: nonEmptyString.optional(),
  exa_api_key: nonEmptyString.optional(),
  tavily_api_key: nonEmptyString.optional(),
  perplexity_api_key: nonEmptyString.optional(),
  firecrawl_api_key: nonEmptyString.optional(),
  jina_api_key: nonEmptyString.optional(),
  duffel_api_key: nonEmptyString.optional(),
  browser_cdp_url: z
    .url({
      protocol: /^(https?|wss?)$/,
      error: "must be an http(s) or ws(s) URL, for example http://127.0.0.1:9222",
    })
    .optional(),
  browser_headless: booleanLike.optional(),
  research_max_cost_usd: positiveNumber.default(3),
  research_max_ms: durationMs.default(15 * 60_000),
  daily_cost_cap_usd: positiveNumber.optional(),
  cache_dir: nonEmptyString.optional(),
  log_level: logLevel.default("info"),
  browser_profile_dir: nonEmptyString.optional(),
  save_screenshots: booleanLike.default(false),
  currency: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z
      .string({ error: "must be a 3-letter ISO 4217 code, for example USD" })
      .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter ISO 4217 code, for example USD" }),
  ).default("USD"),
  model_planner: nonEmptyString.default(DEFAULT_MODELS.planner),
  model_scorer: nonEmptyString.default(DEFAULT_MODELS.scorer),
  model_extractor: nonEmptyString.default(DEFAULT_MODELS.extractor),
  model_writer: nonEmptyString.default(DEFAULT_MODELS.writer),
});

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to ~/.config/webrunner/config.json. A missing file is fine. */
  configPath?: string;
  /** Used for "~" expansion and default paths. Defaults to os.homedir(). */
  home?: string;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function readConfigFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const where = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  - ${where}: ${i.message}`;
    });
    throw new ConfigError(`Config file ${path} is invalid:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

const SEARCH_KEYS = [
  "brave_api_key",
  "exa_api_key",
  "tavily_api_key",
  "perplexity_api_key",
] as const;

const OPTIONAL_FETCH_AND_FLIGHT_KEYS = ["firecrawl_api_key", "jina_api_key", "duffel_api_key"] as const;

/**
 * Load and validate configuration. Throws ConfigError with a readable
 * message on invalid values. Missing optional provider keys log a warning.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? join(home, ".config", "webrunner", "config.json");

  const fileValues = readConfigFile(configPath);

  const merged: Partial<Record<RawKey, unknown>> = {};
  const origin: Partial<Record<RawKey, string>> = {};
  for (const key of ALL_KEYS) {
    const envName = ENV_VARS[key];
    const envRaw = env[envName];
    if (envRaw !== undefined && envRaw.trim() !== "") {
      merged[key] = envRaw;
      origin[key] = `environment variable ${envName}`;
    } else if (fileValues[key] !== undefined) {
      merged[key] = fileValues[key];
      origin[key] = `${configPath} key "${key}"`;
    }
  }

  const result = ResolvedSchema.safeParse(merged);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = issue.path[0] as RawKey | undefined;
      const label = key === undefined ? "(config)" : (origin[key] ?? key);
      return `  - ${label}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const r = result.data;

  const cacheDir = expandHome(r.cache_dir ?? join(home, ".cache", "webrunner"), home);
  const profileDir = expandHome(
    r.browser_profile_dir ?? join(home, ".config", "webrunner", "browser-profile"),
    home,
  );

  const config: Config = {
    ...(r.anthropic_api_key !== undefined && { anthropic_api_key: r.anthropic_api_key }),
    ...(r.brave_api_key !== undefined && { brave_api_key: r.brave_api_key }),
    ...(r.exa_api_key !== undefined && { exa_api_key: r.exa_api_key }),
    ...(r.tavily_api_key !== undefined && { tavily_api_key: r.tavily_api_key }),
    ...(r.perplexity_api_key !== undefined && { perplexity_api_key: r.perplexity_api_key }),
    ...(r.firecrawl_api_key !== undefined && { firecrawl_api_key: r.firecrawl_api_key }),
    ...(r.jina_api_key !== undefined && { jina_api_key: r.jina_api_key }),
    ...(r.duffel_api_key !== undefined && { duffel_api_key: r.duffel_api_key }),
    browser: {
      ...(r.browser_cdp_url !== undefined && { cdp_url: r.browser_cdp_url }),
      ...(r.browser_headless !== undefined && { headless: r.browser_headless }),
      profile_dir: profileDir,
    },
    research_max_cost_usd: r.research_max_cost_usd,
    research_max_ms: r.research_max_ms,
    ...(r.daily_cost_cap_usd !== undefined && { daily_cost_cap_usd: r.daily_cost_cap_usd }),
    cache_dir: cacheDir,
    log_level: r.log_level,
    save_screenshots: r.save_screenshots,
    currency: r.currency,
    models: {
      planner: r.model_planner,
      scorer: r.model_scorer,
      extractor: r.model_extractor,
      writer: r.model_writer,
    },
  };

  warnAboutMissingKeys(config);
  return config;
}

function warnAboutMissingKeys(config: Config): void {
  if (config.anthropic_api_key === undefined) {
    log.warn(
      `${ENV_VARS.anthropic_api_key} is not set; deep_research, browse_task and LLM extraction will be unavailable`,
      { var: ENV_VARS.anthropic_api_key },
    );
  }
  for (const key of SEARCH_KEYS) {
    if (config[key] === undefined) {
      log.warn(`${ENV_VARS[key]} is not set; the ${key.replace("_api_key", "")} search provider is disabled`, {
        var: ENV_VARS[key],
      });
    }
  }
  if (SEARCH_KEYS.every((k) => config[k] === undefined)) {
    log.warn("No search provider key is configured; web_search will have no providers until one is set");
  }
  for (const key of OPTIONAL_FETCH_AND_FLIGHT_KEYS) {
    if (config[key] === undefined) {
      log.debug(`${ENV_VARS[key]} is not set; the related optional provider is disabled`, {
        var: ENV_VARS[key],
      });
    }
  }
}
