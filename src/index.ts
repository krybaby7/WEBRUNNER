#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { buildServer } from "./server.js";

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

  const server = buildServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { reason });
    // Last resort so a stuck close never leaves the process hanging.
    setTimeout(() => process.exit(0), 2000).unref();
    try {
      await server.close();
    } catch (err) {
      log.error("error while closing server", { error: String(err) });
      process.exitCode = 1;
    }
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
