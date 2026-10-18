import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DEFAULT_MODELS, type Config } from "../../../src/config.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/browser/", import.meta.url));

export interface FixtureServer {
  /** Base URL without trailing slash, e.g. http://127.0.0.1:41234 */
  url: string;
  close(): Promise<void>;
}

/**
 * Local HTTP server for the browser tests. Serves `test/fixtures/browser/<name>`
 * at `/<name>`, plus a few behaviors the fixtures cannot express:
 *   /cloudflare-403   the Cloudflare-style page with HTTP 403
 *   /forbidden        a bare 403
 *   /missing          a 404
 *   /set-cookie       sets a persistent cookie (Max-Age) named wr_test
 *   /long             an article with many paragraphs (for maxChars)
 *   /hang             accepts the request and never answers (for timeouts)
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        if (path === "/cloudflare-403") {
          const body = await readFile(join(FIXTURE_DIR, "cloudflare.html"));
          res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(body);
        } else if (path === "/hang") {
          // Intentionally never respond; closeAllConnections() in close() cleans up.
          return;
        } else if (path === "/forbidden") {
          res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
        } else if (path === "/missing") {
          res.writeHead(404, { "content-type": "text/html" }).end("<title>Not found</title><p>nothing here</p>");
        } else if (path === "/set-cookie") {
          res
            .writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "set-cookie": "wr_test=persisted-value; Max-Age=3600; Path=/",
            })
            .end("<title>cookie</title><p>cookie set</p>");
        } else if (path === "/long") {
          const paragraphs = Array.from(
            { length: 40 },
            (_, i) =>
              `<p>Paragraph ${i + 1} of the long article, containing enough words, commas, and clauses to look like real prose to the scoring heuristics.</p>`,
          ).join("\n");
          res
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(`<!doctype html><title>Long Article</title><article><h1>Long Article</h1>${paragraphs}</article>`);
        } else if (/^\/[\w-]+\.html$/.test(path)) {
          const body = await readFile(join(FIXTURE_DIR, path.slice(1)));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
        } else {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        }
      } catch {
        res.writeHead(500).end("fixture error");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function makeConfig(profileDir: string, browser: Partial<Config["browser"]> = {}): Config {
  return {
    browser: { headless: true, profile_dir: profileDir, ...browser },
    research_max_cost_usd: 3,
    cache_dir: join(profileDir, "cache"),
    log_level: "error",
    save_screenshots: false,
    currency: "USD",
    models: { ...DEFAULT_MODELS },
  };
}

export async function makeTempDir(prefix = "webrunner-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface ChromiumProbe {
  available: boolean;
  /** Why Chromium is not launchable; shown when the browser tests are skipped. */
  reason: string;
}

/** Try a real headless launch once. The browser tests skip, with this reason, when it fails. */
export async function probeChromium(): Promise<ChromiumProbe> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return { available: true, reason: "" };
  } catch (err) {
    const reason = `Chromium is not launchable (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}); browser tests skipped`;
    console.warn(`[webrunner browser tests] ${reason}`);
    return { available: false, reason };
  }
}
