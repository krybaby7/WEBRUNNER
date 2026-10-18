# webrunner

webrunner is a local MCP server, run over stdio, that gives Claude Code and Codex four capabilities: web search merged across several providers, page fetching to clean Markdown with a real-browser fallback, server-side deep research that returns a cited report, and live browsing for data that only exists behind interactive pages. The first browsing recipe is Google Flights, exposed as a flight search that returns exact fares and times.

The server calls the Claude API itself for research and extraction, so the client sees one tool call, not forty. It runs on your machine with your own API keys and, for browsing, your own browser profile. It is a personal tool for one owner, not a hosted or multi-user service.

| Tool | What it does | Keys it needs |
|------|--------------|---------------|
| `web_search` | Queries every configured search engine in parallel and returns one merged, deduplicated, ranked list. | At least one of `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `PERPLEXITY_API_KEY` |
| `fetch_page` | Turns a URL into Markdown: fast fetchers first, a real Chromium when the page is bot-walled or empty. | None. `JINA_API_KEY` and `FIRECRAWL_API_KEY` are optional; browser mode needs Chromium |
| `deep_research` | Plans, searches, reads, reflects and writes a cited Markdown report, with depth chosen by the caller. | `ANTHROPIC_API_KEY` and at least one search key |
| `browse_task` | A Claude-driven agent that clicks and reads through a live page toward a goal; read and extract only. | `ANTHROPIC_API_KEY`, plus Chromium |
| `search_flights` | Exact fares and schedules from Google Flights (read through the browser) and, optionally, Duffel. | Google Flights: `ANTHROPIC_API_KEY` plus Chromium. Duffel: `DUFFEL_API_KEY` |
| `ping` | Liveness check: returns `ok`, the server version and the time. | None |
| `health` | Reports what is configured (providers, fetchers, flight sources, models, browser mode, cache size, registered tools) without starting a browser or calling any network service. Never includes key values. | None |

## Status and terms of service

Version 0.1.0. All six tools are implemented and unit-tested offline. Integration tests that hit real services exist but are gated (see Development). The Google Flights recipe was verified live from a headless Chromium on 2026-10-18; the quality of `deep_research` is judged with the eval set (see Evals), and a hardening pass (global timeouts, retries, a `health` tool, PDF support) has not landed yet.

**Personal use only.** Reading Google Flights automatically violates Google's terms of service. The owner has decided that is acceptable for personal use, at low volume, from their own machine. Do not host this server, publish it as a service, or point other people's traffic at it. Other sites you point `fetch_page` or `browse_task` at have their own terms; you are responsible for respecting them. webrunner does not try to defeat CAPTCHAs or anti-bot systems: when a site blocks it, the tool reports `blocked`.

## Requirements

- **Node.js 22 or newer.**
- **Chromium through Playwright**, needed by `browse_task`, `search_flights` (Google Flights) and the browser mode of `fetch_page`. On a normal machine run `npx playwright install chromium` once from the checkout. Playwright is pinned to 1.56.1 (`package.json`) so that the Chromium revision it expects is a known one; the installer downloads exactly that revision. If you upgrade Playwright, run the install command again.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`) for `deep_research`, `browse_task` and the Google Flights extractor. The server starts without it, and search and fetch work; the tools that need it return the error code `config`.
- **At least one search key** for `web_search` and `deep_research`. Start with **Brave plus Exa**; add Tavily or Perplexity Search later if you see failures in `providers_failed`.
- Optional: `JINA_API_KEY` (Jina Reader works without one but is rate-limited), `FIRECRAWL_API_KEY` (better PDFs and complex pages) and `DUFFEL_API_KEY` (licensed flight offers). A reasonable start is Jina only for fetching and no Duffel until the Google Flights recipe has been in use for a few weeks.

## Install

Clone the repository, then run one of the install scripts from anywhere. Each builds the project (`npm ci && npm run build`) and registers `node <checkout>/dist/index.js` with the client. Both are safe to run again.

Export the keys you want first. The scripts only pass on variables that are set in your shell:

```bash
export BRAVE_API_KEY=<your-key>
export EXA_API_KEY=<your-key>
export ANTHROPIC_API_KEY=<your-key>
```

### Claude Code

```bash
scripts/install-claude-code.sh            # add --dry-run to see the command without running it
claude mcp list                           # webrunner should show as connected
```

This runs `claude mcp add --scope user ...`, so the server is available in every project. An existing `webrunner` registration is removed and re-added. Claude Code stores the `--env` values of a server in its own config file, `~/.claude.json`. If you would rather keep keys out of that file, run the script with `--no-env` and put the keys in `~/.config/webrunner/config.json` instead (see Configuration).

### Codex

```bash
scripts/install-codex.sh                  # add --dry-run to print the block without writing it
codex mcp list
```

This writes an `[mcp_servers.webrunner]` block to `~/.codex/config.toml`, replacing an earlier one, after backing the file up to `config.toml.bak-<timestamp>`. The block names the variables to forward with Codex's `env_vars` list; no key value is ever written to the file. Codex forwards them from the environment Codex itself is started in, so keep exporting them in your shell profile, and run the script again when you add a key. The block also sets `tool_timeout_sec = 900`, because Codex's default of 60 seconds is shorter than a `deep_research` call.

The Codex block follows the Codex MCP documentation; the Claude Code command was checked against the `claude` CLI's own help. Remove either registration with `scripts/uninstall.sh`.

### Manual configuration

Build first: `npm ci && npm run build`. Then use the absolute path of `dist/index.js` below.

Claude Code, one command (add one `--env NAME=value` per key; Claude Code keeps these in `~/.claude.json`):

```bash
claude mcp add --scope user --env BRAVE_API_KEY=<your-key> --transport stdio webrunner -- node /abs/path/to/webrunner/dist/index.js
```

Or in a project's `.mcp.json`, which supports `${VAR}` expansion so no key is stored in the file:

```json
{
  "mcpServers": {
    "webrunner": {
      "command": "node",
      "args": ["/abs/path/to/webrunner/dist/index.js"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}",
        "EXA_API_KEY": "${EXA_API_KEY}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.webrunner]
command = "node"
args = ["/abs/path/to/webrunner/dist/index.js"]
env_vars = ["BRAVE_API_KEY", "EXA_API_KEY", "ANTHROPIC_API_KEY"]
startup_timeout_sec = 30
tool_timeout_sec = 900
```

(`codex mcp add webrunner --env NAME=value -- node /abs/path/to/webrunner/dist/index.js` also works, but it writes the value into the file.)

## Configuration

webrunner reads environment variables first, then `~/.config/webrunner/config.json`, then built-in defaults. The configuration is validated at startup, and an invalid value stops the server with a message on stderr naming the variable.

| Environment variable | Config-file key | Default | Purpose |
|----------------------|-----------------|---------|---------|
| `ANTHROPIC_API_KEY` | `anthropic_api_key` | none | Research, browsing and extraction. Optional at startup; LLM tools return `config` when it is unset. |
| `BRAVE_API_KEY` | `brave_api_key` | none | Brave Search. |
| `EXA_API_KEY` | `exa_api_key` | none | Exa search. |
| `TAVILY_API_KEY` | `tavily_api_key` | none | Tavily search. |
| `PERPLEXITY_API_KEY` | `perplexity_api_key` | none | Perplexity Search API. |
| `FIRECRAWL_API_KEY` | `firecrawl_api_key` | none | Firecrawl as a fast fetcher. |
| `JINA_API_KEY` | `jina_api_key` | none | Jina Reader as a fast fetcher (works unauthenticated, rate-limited). |
| `DUFFEL_API_KEY` | `duffel_api_key` | none | Licensed flight offers for `search_flights`. |
| `BROWSER_CDP_URL` | `browser_cdp_url` | none | Attach to your running Chrome instead of launching Chromium (see Browser setup). An `http(s)` or `ws(s)` URL such as `http://127.0.0.1:9222`. |
| `BROWSER_HEADLESS` | `browser_headless` | auto | `true` or `false` forces headless or headful. Unset means headful when a display exists. |
| `WEBRUNNER_BROWSER_PROFILE_DIR` | `browser_profile_dir` | `~/.config/webrunner/browser-profile` | The persistent Chromium profile. |
| `WEBRUNNER_SAVE_SCREENSHOTS` | `save_screenshots` | `false` | `browse_task` saves screenshots under `<cache dir>/runs/<run id>/` and lists them in `screenshots`. |
| `WEBRUNNER_CURRENCY` | `currency` | `USD` | Default ISO 4217 currency for `search_flights`. |
| `RESEARCH_MAX_COST_USD` | `research_max_cost_usd` | `3` | Default hard cost cap per `deep_research` call, in US dollars. |
| `WEBRUNNER_CACHE_DIR` | `cache_dir` | `~/.cache/webrunner` | Disk cache for search and fetch results, and the `runs/` directory. |
| `WEBRUNNER_LOG_LEVEL` | `log_level` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr as JSON lines. |
| `WEBRUNNER_MODEL_PLANNER` | `model_planner` | `claude-opus-5-5` | Model for planning and reflection in `deep_research`. |
| `WEBRUNNER_MODEL_SCORER` | `model_scorer` | `claude-haiku-5-5` | Model that scores search results for relevance. |
| `WEBRUNNER_MODEL_EXTRACTOR` | `model_extractor` | `claude-sonnet-5-5` | Model for page notes, browse extraction and Google Flights extraction. |
| `WEBRUNNER_MODEL_WRITER` | `model_writer` | `claude-opus-5-5` | Model that writes the final report (standard and deep depth). |

Notes on the table:

- Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`. Paths accept a leading `~/`.
- The config-file key is the variable name in lowercase **without** the `WEBRUNNER_` prefix where there is one (`WEBRUNNER_CACHE_DIR` is `cache_dir`, `WEBRUNNER_MODEL_PLANNER` is `model_planner`).
- At quick depth the report is written by the extractor model (Sonnet class) rather than the writer model, per the depth table below.

### Config file

`~/.config/webrunner/config.json` is the alternative to environment variables, handy when you do not want keys in a client's config. Keys are the names in the second column; a typo (an unknown key) stops the server at startup. Restrict its permissions: `chmod 600 ~/.config/webrunner/config.json`.

```json
{
  "brave_api_key": "<your-key>",
  "exa_api_key": "<your-key>",
  "anthropic_api_key": "<your-key>",
  "currency": "EUR",
  "research_max_cost_usd": 5,
  "model_writer": "claude-opus-5-5"
}
```

**Precedence:** an environment variable beats the file, and an empty environment variable counts as unset (so `BRAVE_API_KEY=` falls through to the file). Missing optional keys disable that provider and log a warning to stderr; they are not errors.

## Browser setup

`browse_task`, the Google Flights source of `search_flights`, and `fetch_page` in browser mode all drive one shared browser, started lazily on first use and closed when the server exits. At most 3 pages are open at once.

**Default: a tool-owned persistent profile.** webrunner launches Chromium with a profile directory it owns, `~/.config/webrunner/browser-profile` (change it with `WEBRUNNER_BROWSER_PROFILE_DIR`). The first run creates it; cookies and logins persist between runs. Pages get a 1366x768 viewport and your system locale and timezone. There are no stealth plugins and no automation-flag overrides beyond Playwright's defaults; if a site still blocks, the tool reports `blocked`.

**Logging into a site once.** `browse_task` never logs in for you, so sign in yourself, in that same profile, by running the browser headful from the checkout and closing it when done:

```bash
node --input-type=module -e "import { chromium } from 'playwright'; const dir = process.env.WEBRUNNER_BROWSER_PROFILE_DIR ?? process.env.HOME + '/.config/webrunner/browser-profile'; const c = await chromium.launchPersistentContext(dir, { headless: false, viewport: null }); await new Promise((r) => c.on('close', r));"
```

Log in, then close the window. Close it before using the tools: a profile can be used by only one browser at a time. (If you changed the profile directory in `config.json` rather than the environment, edit `dir` in the command.)

**Attaching to your own Chrome instead (CDP).** Start Chrome with remote debugging, then point webrunner at it:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.config/webrunner/chrome-debug"
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/webrunner/chrome-debug"

export BROWSER_CDP_URL=http://127.0.0.1:9222
```

Recent Chrome versions ignore `--remote-debugging-port` when it is used with the default profile directory, so use a dedicated `--user-data-dir` as above and log into your sites in that Chrome once. Debugging port 9222 gives any local program full control of that browser; do not expose it beyond `127.0.0.1`.

What changes in CDP mode:

- The browser is yours: your window size and settings apply (webrunner sets no viewport), and the tool-owned profile is not used.
- `close()` only disconnects. When the server exits, your Chrome keeps running. Pages webrunner opened itself are closed after each use; your other tabs are left alone.
- webrunner uses Chrome's default browser context. If the connection fails you get an error naming the URL.

**Headless detection.** `BROWSER_HEADLESS` wins when set. Otherwise: macOS and Windows count as having a display and run headful; on Linux webrunner runs headful only when `DISPLAY` or `WAYLAND_DISPLAY` is set, and headless otherwise (servers, containers, CI). Headful is the default on a desktop so you can watch the agent while debugging.

## Using the tools

You normally just ask your assistant in plain language and it picks the tool. The calls below show the arguments the tools take. Results are trimmed (`...`) and the values are illustrative.

### web_search

```json
{ "query": "Node.js 24 release schedule", "max_results": 5, "recency": "month" }
```

```json
{
  "query": "Node.js 24 release schedule",
  "results": [
    {
      "url": "https://nodejs.org/en/about/previous-releases",
      "title": "Node.js Releases",
      "snippet": "Release schedule ...",
      "published_at": "2026-09-30T00:00:00.000Z",
      "providers": ["brave", "exa"],
      "score": 0.0325
    }
  ],
  "providers_used": ["brave", "exa"],
  "providers_failed": [],
  "cached": false,
  "latency_ms": 840
}
```

Optional arguments: `include_domains`, `exclude_domains`, and `providers` (a subset of `brave`, `exa`, `tavily`, `perplexity`). Results are fused with reciprocal rank fusion and cached for an hour. A failing or slow engine (8 s limit each) is listed in `providers_failed` and does not fail the call. Each engine returns at most about 20 results, so `max_results` above 20 may return fewer rows.

### fetch_page

```json
{ "url": "https://example.com/article", "mode": "auto", "max_chars": 20000 }
```

```json
{
  "url": "https://example.com/article",
  "final_url": "https://example.com/article",
  "title": "Article title",
  "markdown": "# Article title\n\n...",
  "truncated": false,
  "method": "jina",
  "fetched_at": "2026-10-18T10:15:00.000Z",
  "cached": false
}
```

`mode` is `auto` (default), `fast` (never opens a browser) or `browser` (always renders; `wait_for` takes a CSS selector to wait for). In auto mode the browser is used when the fast result is a bot wall or nearly empty. `method` reports which fetcher produced the page. Truncation is always flagged in `truncated`. Fast results are cached for 24 hours and browser results for 1 hour. PDFs are not supported yet.

### deep_research

```json
{
  "question": "What are the main differences between Postgres logical and physical replication, and when should each be used?",
  "depth": "standard",
  "recency": "year",
  "output": "report",
  "max_cost_usd": 2
}
```

```json
{
  "question": "What are the main differences between ...",
  "report_markdown": "## Summary\n\nPhysical replication ships WAL byte for byte [1] ...\n\n## Gaps\n\n- ...",
  "findings": [
    { "claim": "Logical replication can replicate a subset of tables.", "confidence": "high", "source_ids": [1, 2], "quote": "..." }
  ],
  "sources": [
    { "id": 1, "url": "https://www.postgresql.org/docs/current/logical-replication.html", "title": "Logical Replication", "accessed_at": "2026-10-18T10:20:00.000Z", "used_for": "Definition and use cases" }
  ],
  "gaps": ["No benchmark comparing the two on current versions was found."],
  "depth": "standard",
  "stats": {
    "searches": 11, "pages_read": 18, "pages_failed": 2, "iterations": 3,
    "input_tokens": 410000, "output_tokens": 22000,
    "cost_usd": 0.94, "elapsed_ms": 148000, "stopped_reason": "converged"
  }
}
```

| depth | max searches | max page reads | max iterations | writer | typical cost |
|-------|--------------|----------------|----------------|--------|--------------|
| `quick` | 4 | 6 | 1 | Sonnet class | $0.10 to $0.30 |
| `standard` (default) | 12 | 20 | 3 | Opus class | $0.50 to $1.50 |
| `deep` | 30 | 50 | 6 | Opus class | $1.50 to $4.00 |

Quick takes under a minute; deep can take several minutes. Every `[n]` in the report matches a `sources[].id`, and `gaps` is always present. `output: "brief"` caps the answer at about 300 words. `focus_domains` and `exclude_domains` steer the sources. `stats.stopped_reason` says why the loop ended: `converged`, `iterations`, `budget`, `searches`, `reads`, `no_results` or `error`. The default cap (`RESEARCH_MAX_COST_USD`, 3.00) is below the top of the deep range, so pass a larger `max_cost_usd` for deep questions you care about.

### browse_task

```json
{
  "goal": "Find the current stable version number and its release date",
  "start_url": "https://example.com/downloads",
  "max_steps": 10,
  "extract_schema": {
    "type": "object",
    "properties": { "version": { "type": "string" }, "released": { "type": "string" } },
    "required": ["version"]
  }
}
```

```json
{
  "goal": "Find the current stable version number and its release date",
  "outcome": "completed",
  "summary": "The downloads page lists version 1.2.3, released 2026-09-12.",
  "extracted": { "version": "1.2.3", "released": "2026-09-12" },
  "final_url": "https://example.com/downloads",
  "steps_taken": 3
}
```

`browse_task` reads and extracts; it is for live data that has no dedicated tool (prefer `fetch_page` for static content). Limits:

- It never pays, buys or submits payment forms: buttons and forms matching a purchase deny list (`buy`, `pay`, `checkout`, `place order`, and similar) and payment URLs are refused, and it never types into password or card fields.
- It never logs in. If the site wants a login it stops with `outcome: "blocked"` and `blocked_reason: "login_required"`; sign in once in the browser profile instead (see Browser setup).
- It stops on CAPTCHAs and bot walls (`captcha`, `bot_wall`) rather than trying to get past them.
- It stays on the start domain unless `allow_navigation_off_domain` is true, never downloads files, and has a ten-minute wall-clock limit.
- `max_steps` (default 15, max 40) bounds the run, and so does `max_cost_usd` (default 1.00). A run that hits a limit returns `outcome: "partial"` with what it has.

### search_flights

```json
{
  "origin": "London",
  "destination": "JFK",
  "depart_date": "2026-12-01",
  "return_date": "2026-12-08",
  "passengers": { "adults": 1 },
  "cabin": "economy",
  "max_stops": 1,
  "currency": "USD"
}
```

```json
{
  "query": { "origin": "LON", "destination": "JFK", "depart_date": "2026-12-01", "return_date": "2026-12-08", "passengers": { "adults": 1, "children": 0, "infants": 0 }, "cabin": "economy", "max_stops": 1, "sources": ["google_flights"], "currency": "USD" },
  "offers": [
    {
      "id": "gf-1",
      "source": "google_flights",
      "price": { "amount": 612, "currency": "USD" },
      "total_duration_min": 465,
      "stops": 0,
      "itinerary": "outbound_only",
      "slices": [
        {
          "segments": [
            { "airline": "BA", "airline_name": "British Airways", "depart_airport": "LHR", "depart_at": "2026-12-01T10:30:00", "arrive_airport": "JFK", "arrive_at": "2026-12-01T13:15:00", "duration_min": 465 }
          ],
          "layovers": []
        }
      ]
    }
  ],
  "sources_used": ["google_flights"],
  "sources_failed": [],
  "fetched_at": "2026-10-18T10:30:00.000Z",
  "caveats": [
    "Google Flights shows only the outbound flight of a round trip. ...",
    "Flight numbers are not shown by Google Flights, so those offers have no flight_number.",
    "Prices are quotes at fetch time and can change before booking."
  ]
}
```

Caveats worth knowing:

- **Round trips from Google Flights are outbound-only.** The results list shows one leg while the price is the round-trip total; such offers have one slice and `itinerary: "outbound_only"`. The return flight is chosen in a second step on Google Flights.
- **Google Flights shows no flight numbers**, so those offers omit `flight_number`. Duffel always has them.
- **Duffel returns prices in the airline's currency** and cannot convert. When currencies differ from the requested one, offers are grouped by currency (requested currency first), sorted by price within each group, and a caveat says not to compare across groups.
- `max_stops` unset means "provider default", which differs: Google Flights lists any number of stops, Duffel returns at most one connection. A caveat appears when both are used. Set `max_stops` to align them.
- **Google may rate-limit after a handful of searches** from one IP within a few minutes: it answers 429 or an "unusual traffic" page, which surfaces as the error code `blocked`. Keep volume low and wait a few minutes. Duffel is the licensed alternative.
- Names are resolved to IATA codes (`London` becomes the metropolitan code `LON`); passenger limits are at least one adult, infants no more than adults, nine in total. Offers are capped at 30, sorted by price, and the page often has more flights than were read, which a caveat notes.

### ping

`ping` takes no arguments and returns `{ "ok": true, "version": "0.1.0", "time": "..." }`. It is the quickest way to confirm the client can reach the server.

### health

`health` takes no arguments. It returns the server version and uptime, which search providers, fast fetchers and flight sources are configured, the model per role, the browser mode (persistent profile or CDP attach, with `cdp_url` reduced to scheme and host) and whether a browser is currently open, cache directory statistics, and the list of registered tools. It makes no network calls and never starts Chromium. When any tool returns a `config` error, call `health` first to see which key is missing.

### Errors

Failures return `isError: true` with `{ "error": { "code", "message", "retryable", "details?" } }`. The codes are `config` (a key is missing or a value is invalid), `provider` (an upstream service failed), `timeout`, `blocked` (a bot wall, CAPTCHA, login wall or rate limit), `budget_exceeded`, `invalid_input` and `internal`. Malformed arguments are rejected by the MCP layer before the tool runs, with a plain validation message instead of this envelope.

## Costs

Rough, owner-facing figures using the default model routing and 2026-10 prices (Opus 5.5 at $4 input and $20 output per million tokens, Sonnet 5.5 at $2 and $10, Haiku 5.5 at $0.10 and $0.50):

| Operation | Typical cost |
|-----------|--------------|
| `web_search` | under $0.02 across 3 providers |
| `fetch_page` fast | $0 to $0.01 |
| `deep_research` quick | $0.10 to $0.30 |
| `deep_research` standard | $0.50 to $1.50 |
| `deep_research` deep | $1.50 to $4.00 |
| `search_flights` via Google Flights | $0.02 to $0.08 (one extraction call) |
| `browse_task`, 15 steps | $0.20 to $0.60 |

`deep_research` reports its actual spend in `stats.cost_usd`. That figure is **LLM spend only**: search and fetch provider fees (Brave, Exa, Firecrawl and so on) are billed by those providers and are not metered here. `max_cost_usd` is a hard stop on the same LLM spend: the server checks the running total before every model call, so the overshoot is at most one call. When the cap is reached the tool returns what it has, `stats.stopped_reason` is `budget`, and `gaps` explains the cutoff. The server keeps an estimate of the writer's cost in reserve so a report can still be produced. The default cap comes from `RESEARCH_MAX_COST_USD` (3.00); `max_cost_usd` on a call overrides it. `browse_task` has its own `max_cost_usd` (default 1.00).

## Evals

The research eval set is 20 questions with rubrics in `test/evals/research/questions.json`. A runner calls `deep_research` for each question and grades the report with a Haiku-class judge model.

```bash
npm run eval:research -- --depth quick --only recent-nodejs-latest-release --out /tmp/eval-quick.json
npm run eval:research -- --depth standard --out /tmp/eval-standard.json
```

Flags:

- `--depth quick|standard|deep|hint`: depth for every question; `hint` uses each question's own depth hint. Default `standard`.
- `--only id,id`: run only these question ids (an unknown id lists the known ones).
- `--out path`: also write the full JSON report (rows, judgements, reports) to this path. The repository does not ignore an `eval-results/` directory, so write outside the checkout or do not commit it.
- `--concurrency n`: questions in flight at once (default 3).

**This costs real money.** Each question is a real `deep_research` call plus judge calls, so a full 20-question run at standard depth is roughly twenty times the per-call figure above, on the order of $10 to $30. It needs `ANTHROPIC_API_KEY` and a search key, and refuses to run unless `RUN_EVALS=1`, which the npm script sets. Run it deliberately, once per prompt change.

**The M2 comparison.** The project's research milestone (PLAN.md section 12) is a score on the eval set at standard depth that you are happy with, plus a side-by-side: put the same 20 questions to Perplexity Deep Research, read each pair of answers without knowing which is which, and count how many questions webrunner wins. The target is 15 of 20. The `--out` report holds the full webrunner reports to paste into that comparison.

## Troubleshooting

**The client lists no tools or the server will not connect.** stdout is the protocol channel, so anything else written to it breaks the connection; webrunner logs only to stderr. Run the server by hand and watch stderr:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | WEBRUNNER_LOG_LEVEL=debug node dist/index.js
```

You should see one JSON line on stdout that includes the six tools, and JSON log lines on stderr. Also check that you built (`npm run build`; `dist/index.js` must exist), that the path in the client config is absolute and correct, and that `node` is version 22 or newer. Run `claude mcp list` or `codex mcp list` to see the client's view.

**`config` errors.** `Invalid configuration:` on stderr, exit code 1: a variable or a `config.json` key has a bad value or an unknown name; the message names it (for example `environment variable RESEARCH_MAX_COST_USD: must be a number`). A tool returning code `config` means a key it needs is unset, for example `ANTHROPIC_API_KEY` for `deep_research`, or no search key for `web_search`. Keys in the client's config reach the server only if they were passed (Claude Code `--env`, Codex `env_vars` and the shell Codex was started from); the `config.json` file is the fallback that always works.

**`blocked` errors.** The site served a bot wall, CAPTCHA, login wall or rate limit. webrunner does not try to get around these. Log in once in the browser profile (see Browser setup), try `fetch_page` with `mode: "browser"`, wait and retry for rate limits, or use another source.

**Chromium does not start.** Run `npx playwright install chromium` from the checkout. If the error mentions the profile, another browser is using it: close the window you opened for logging in, stop any other running webrunner (each Claude Code or Codex session starts its own server, and two servers cannot share one profile directory), or give each client its own `WEBRUNNER_BROWSER_PROFILE_DIR`. On Linux without a display, webrunner runs headless on its own.

**`429` from Google, or `blocked` from `search_flights`.** Google rate-limits repeated searches from one IP. Wait several minutes, reduce volume, or use Duffel.

**Timeouts.** Google Flights is given 90 seconds and Duffel 45. `deep_research` can run for minutes; Codex's default tool timeout (60 seconds) is too short, which is why the Codex installer sets 900. If you wrote the Codex block by hand, set `tool_timeout_sec` yourself.

**Stale results.** Search results are cached for an hour and fetches for an hour or a day. Clear the cache with `rm -rf ~/.cache/webrunner` (or your `WEBRUNNER_CACHE_DIR`).

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
```

`npm test` builds first (`pretest`), then runs the offline unit tests, including a stdout-purity test that starts the server and checks that only protocol frames reach stdout. `npm run typecheck` covers both `src/` and `test/`. The browser-backed suites (`test/unit/browser`, the Google Flights recipe tests) run only when Chromium is launchable and skip with a visible notice otherwise.

CI has three workflows. `check` runs lint, typecheck and the unit tests with the browser suites skipped. `browser-tests` installs Chromium and runs the browser suites. `live.yml` runs the gated integration tests every Sunday at 06:00 UTC and on demand, using whichever of these repository secrets are set: `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `DUFFEL_API_KEY` (a sandbox key). With none set the live job skips and says so. A new tool must be added to `TOOL_NAMES` in `src/tools/index.ts` and given a case in `test/unit/tools/envelope.test.ts`, otherwise two tests fail. `docs/mcp-sdk-v2-migration.md` records the evaluation of moving to MCP SDK v2 and recommends doing it in one dedicated change before v1 support ends. Integration tests hit real services (search providers, a live browser, Google Flights, Duffel) and are excluded by default: run them with `RUN_INTEGRATION=1 npm test`. Each integration test also skips itself when the keys it needs are missing; the browser ones need Chromium installed. Evals are separate (see Evals).

`PLAN.md` is the design document and the source of truth for the tool contracts, internal interfaces, configuration and cost model; its decision log records why things are the way they are. The project was built as numbered work packages (WP0 to WP14), each implemented by an agent session on its own branch against the contracts in `PLAN.md`, reviewed and merged in dependency order. A change to a contract starts with an edit to `PLAN.md` in its own pull request. `CLAUDE.md` holds the short rules for agents working in this repository.

## License

MIT. See [LICENSE](LICENSE).
