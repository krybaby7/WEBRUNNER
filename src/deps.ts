import type { Config } from "./config.js";
import { log, type Logger } from "./log.js";

/**
 * Shared dependencies handed to every tool at registration time.
 * Later work packages add fields here (cache, llm, search, fetch, browser);
 * each addition is one optional field so parallel branches merge cleanly.
 */
export interface Deps {
  config: Config;
  log: Logger;
}

export function buildDeps(config: Config): Deps {
  return { config, log };
}
