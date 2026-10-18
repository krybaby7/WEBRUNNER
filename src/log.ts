/**
 * Minimal JSON-lines logger. Writes to stderr only: stdout is the MCP
 * protocol channel and must never carry anything else.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

let levelOverride: LogLevel | undefined;

/** Override the level at runtime (for example from the config file). */
export function setLogLevel(level: LogLevel | undefined): void {
  levelOverride = level;
}

/** Effective level: runtime override, else WEBRUNNER_LOG_LEVEL, else info. */
export function currentLogLevel(): LogLevel {
  if (levelOverride !== undefined) return levelOverride;
  const fromEnv = process.env["WEBRUNNER_LOG_LEVEL"]?.trim().toLowerCase();
  return isLogLevel(fromEnv) ? fromEnv : DEFAULT_LEVEL;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLogLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  process.stderr.write(line + "\n");
}

export const log: Logger = {
  debug: (msg, fields) => write("debug", msg, fields),
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
};
