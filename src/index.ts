#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { BROWSER_CLOSE_TIMEOUT_MS, buildDeps, closeDeps } from "./deps.js";
import { log, setLogLevel } from "./log.js";
import { buildServer } from "./server.js";

/** Hard stop for a shutdown that has not finished: the browser close timeout plus room for the server close. */
const FORCED_EXIT_MS = BROWSER_CLOSE_TIMEOUT_MS + 2000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`webrunner: ${err.message}\n`);
    } else {
      log.error("failed to load config", { error: String(err) });
    }
    process.exitCode = 1;
    return;
  }
  setLogLevel(config.log_level);

  const deps = buildDeps(config);
  const server = buildServer(deps);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { reason });
    // Last resort so a stuck close never leaves the process hanging. It is longer than the browser
    // close timeout in closeDeps, so it only fires when something else is stuck, never in a race with
    // a Chromium that is still closing. Exit code 1: something did not shut down cleanly.
    setTimeout(() => {
      log.error("shutdown did not finish in time; forcing exit");
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
    try {
      await server.close();
    } catch (err) {
      log.error("error while closing server", { error: String(err) });
      process.exitCode = 1;
    }
    await closeDeps(deps);
    // Everything is released. Exit now: a tool call still in flight holds timers (wall-clock caps,
    // request timeouts) that would otherwise keep the process alive for up to minutes.
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The client went away (stdin closed): same as a signal.
  process.stdin.on("end", () => void shutdown("stdin closed"));

  await server.connect(transport);
  log.info("webrunner MCP server ready on stdio");
}

main().catch((err: unknown) => {
  log.error("fatal error", { error: String(err) });
  process.exitCode = 1;
});
