# webrunner

webrunner is a local MCP server, run over stdio, that gives Claude Code and Codex web search merged across several providers, page fetching to clean Markdown with a real-browser fallback, server-side deep research that returns a cited report, and live data that only exists behind interactive pages or specialised APIs: flights and hotels, stock and crypto quotes, weather, exchange rates, what people are saying on social platforms, and reviews of places, products and apps. Browser-based sources read through a browser profile the server owns, or through your own Chrome, so platforms that need a login (X, Facebook, Amazon) work through your own account once you connect it.

The server calls the Claude API itself for research and extraction, so the client sees one tool call, not forty. It runs on your machine with your own API keys and, for browsing, your own browser profile. Every tool does something useful without a key; keys widen coverage. It is a personal tool for one owner, not a hosted or multi-user service.

| Tool | What it does | Keys it needs |
|------|--------------|---------------|
| `web_search` | Queries every configured search engine in parallel and returns one merged, deduplicated, ranked list. | At least one of `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `PERPLEXITY_API_KEY` |
| `fetch_page` | Turns a URL into Markdown (PDFs included): fast fetchers first, a real Chromium when the page is bot-walled or empty. | None. `JINA_API_KEY` and `FIRECRAWL_API_KEY` are optional; browser mode needs Chromium |
| `deep_research` | Plans, searches, reads, reflects and writes a cited Markdown report, with depth chosen by the caller. | `ANTHROPIC_API_KEY` and at least one search key |
| `browse_task` | A Claude-driven agent that clicks and reads through a live page toward a goal; read and extract only. | `ANTHROPIC_API_KEY`, plus Chromium |
| `search_flights` | Exact fares and schedules from Google Flights (read through the browser) and, optionally, Duffel. | Google Flights: `ANTHROPIC_API_KEY` plus Chromium. Duffel: `DUFFEL_API_KEY` |
| `search_hotels` | Nightly rates, stay totals, ratings when shown, star class and amenities from Google Hotels, read through the browser. | Chromium. `ANTHROPIC_API_KEY` only as a fallback when the page layout is not recognised |
| `market_quote` | Current prices and OHLCV history for stocks, ETFs, indices and crypto from Yahoo Finance, CoinGecko, Finnhub and Google Finance. | None. `FINNHUB_API_KEY` is optional; Google Finance needs Chromium |
| `weather` | Current conditions and a 1 to 16 day forecast, optionally hourly, from Open-Meteo. | None |
| `exchange_rate` | Converts an amount at the latest or a historical ECB reference rate, from Frankfurter. | None |
| `social_search` | What people are saying across Reddit, Hacker News, Bluesky, YouTube, X and Facebook, as posts and comments, or the comments of one thread; optional summary. | None for Reddit, Hacker News and Bluesky. `REDDIT_CLIENT_ID`+`REDDIT_CLIENT_SECRET` and `YOUTUBE_API_KEY` optional; X and Facebook need Chromium and a connected account; summaries need `ANTHROPIC_API_KEY` |
| `search_reviews` | Reviews of a place, business, product or app from the App Store, Trustpilot, Google Maps, Google Play and Amazon, with the subject each site matched; optional summary. | None for the App Store and Trustpilot; the other three need Chromium (Amazon often a connected account too); summaries need `ANTHROPIC_API_KEY` |
| `accounts` | Connect your own accounts (Reddit, X, Facebook, Instagram, Google, Amazon, LinkedIn) to the server's browser by logging in yourself in a window it opens; list what is connected; disconnect. | Chromium with a display, or your own Chrome over CDP |
| `ping` | Liveness check: returns `ok`, the server version and the time. | None |
| `health` | Reports what is configured (providers, fetchers, every tool's sources, which optional keys are set, models, browser mode, connected accounts by name, cache size, registered tools) without starting a browser or calling any network service. Never includes key or cookie values. | None |

## Status and terms of service

Version 0.2.0. All fourteen tools are implemented and unit-tested offline; integration tests that hit real services exist but are gated (see Development). What was verified live, from the development environment (a cloud IP behind a proxy, headless Chromium) on 2026-10-18, and what was built from documentation only:

- **Verified live:** Google Flights (27 offers for LHR to JFK); Google Hotels (Paris and Lisbon, 18 cards per page, read deterministically with no model call); Google Finance (`AAPL:NASDAQ` and `VOD:LON` quote pages); Hacker News search and items; CoinGecko search, prices and OHLC history; Frankfurter latest, dated and currency-list endpoints; Open-Meteo geocoding; the App Store search, lookup and review feed. Trustpilot answered with an AWS WAF challenge, which is what the bot-wall fallback is built on.
- **From documentation, not exercised live:** Reddit (its JSON endpoints returned 403 from that IP and no API credentials were available), Bluesky (connection reset from that IP), YouTube (no key), Yahoo Finance (429 from that IP), Finnhub (no key), the Open-Meteo forecast endpoint (timed out from that IP), the Trustpilot page parsers, and the login URLs the `accounts` tool opens. Their field mappings follow the published API shapes and the fixtures say "from docs".
- **Browser platforms through your account:** from the development IP, X answered HTTP 403 with an empty body to headless Chromium, even on its login page; Facebook answered 404 to anonymous search (its way of hiding search from visitors); old.reddit.com redirected search to its login page and then served "You've been blocked by network security". So the X, Facebook and Reddit-site recipes are tested against fixture pages on real Chromium (the Facebook login page and Reddit's block page are live captures, the rest is synthetic from the sites' markup), and a gated run on a logged-out profile produced the expected `blocked` and `needs_login` errors rather than items. The Google Maps, Google Play and Amazon review recipes are likewise fixture-tested only. Your first run from a home IP with connected accounts is the real test of those paths, and of whether Google Hotels prints guest ratings for you (it did not for the development IP; see `search_hotels`).

The quality of `deep_research` is judged with the eval set (see Evals).

**Personal use only.** Reading Google Flights, Google Hotels, Google Finance, Google Maps and Google Play automatically violates Google's terms of service; the same goes for X, Facebook, Amazon and Reddit's website (as opposed to Reddit's API). When a site is read through your own account, that account can be rate-limited or suspended. The owner has decided that is acceptable for personal use, at low volume, from their own machine. Do not host this server, publish it as a service, or point other people's traffic at it. Other sites you point `fetch_page` or `browse_task` at have their own terms; you are responsible for respecting them. webrunner does not try to defeat CAPTCHAs or anti-bot systems and never pretends to be a different browser: when a site blocks it, the tool reports `blocked`; when it wants a login, `needs_login`. Hacker News, Bluesky, the Reddit API, the YouTube Data API, CoinGecko, Frankfurter, Open-Meteo, Finnhub and the App Store feed are read through their public APIs under their own terms (quotas apply; see the tool sections).

## Requirements

- **Node.js 22 or newer.**
- **Chromium through Playwright**, needed by `browse_task`, `search_flights` (Google Flights), `search_hotels`, the Google Finance source of `market_quote`, the X and Facebook platforms of `social_search` (and Reddit's browser fallback), the Google Maps, Google Play and Amazon sources of `search_reviews`, `accounts`, and the browser mode of `fetch_page`. On a normal machine run `npx playwright install chromium` once from the checkout. Playwright is pinned to 1.56.1 (`package.json`) so that the Chromium revision it expects is a known one; the installer downloads exactly that revision. If you upgrade Playwright, run the install command again.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`) for `deep_research`, `browse_task`, the Google Flights extractor, the `summarize` option of `social_search` and `search_reviews`, and the fallback extraction the hotel, finance and review recipes use when a page layout is not recognised. The server starts without it, and everything else works; the tools that need it return the error code `config`.
- **At least one search key** for `web_search` and `deep_research`. Start with **Brave plus Exa**; add Tavily or Perplexity Search later if you see failures in `providers_failed`.
- Optional: `JINA_API_KEY` (Jina Reader works without one but is rate-limited), `FIRECRAWL_API_KEY` (better PDFs and complex pages) and `DUFFEL_API_KEY` (licensed flight offers). A reasonable start is Jina only for fetching and no Duffel until the Google Flights recipe has been in use for a few weeks.
- Optional, for the v0.2 tools: `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (a Reddit "script" app; the API path is far more reliable than the public JSON endpoints, which refuse many IPs), `YOUTUBE_API_KEY` (a Google Cloud key with the YouTube Data API v3 enabled; without it the platform is off) and `FINNHUB_API_KEY` (US stock quotes as a second equity source). Hacker News, Bluesky, CoinGecko, Frankfurter, Open-Meteo, Yahoo Finance, the App Store feed and Trustpilot need no key.

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
| `REDDIT_CLIENT_ID` | `reddit_client_id` | none | Reddit API, app-only OAuth, for the `reddit` platform of `social_search`. Set together with the secret. |
| `REDDIT_CLIENT_SECRET` | `reddit_client_secret` | none | The secret of that Reddit app. Setting only one of the two is a startup error. |
| `REDDIT_USER_AGENT` | `reddit_user_agent` | `webrunner/<version> personal MCP server` | User-Agent sent to Reddit; Reddit asks for a descriptive one. |
| `YOUTUBE_API_KEY` | `youtube_api_key` | none | YouTube Data API v3, for the `youtube` platform of `social_search`. Off without it. |
| `FINNHUB_API_KEY` | `finnhub_api_key` | none | Finnhub stock quotes, a second equity source for `market_quote`. |
| `BROWSER_CDP_URL` | `browser_cdp_url` | none | Attach to your running Chrome instead of launching Chromium (see Browser setup). An `http(s)` or `ws(s)` URL such as `http://127.0.0.1:9222`. |
| `BROWSER_HEADLESS` | `browser_headless` | auto | `true` or `false` forces headless or headful. Unset means headful when a display exists. |
| `WEBRUNNER_BROWSER_PROFILE_DIR` | `browser_profile_dir` | `~/.config/webrunner/browser-profile` | The persistent Chromium profile. |
| `WEBRUNNER_SAVE_SCREENSHOTS` | `save_screenshots` | `false` | `browse_task` saves screenshots under `<cache dir>/runs/<run id>/` and lists them in `screenshots`. |
| `WEBRUNNER_CURRENCY` | `currency` | `USD` | Default ISO 4217 currency for `search_flights`, `search_hotels` and crypto quotes in `market_quote`. |
| `RESEARCH_MAX_COST_USD` | `research_max_cost_usd` | `3` | Default hard cost cap per `deep_research` call, in US dollars. |
| `WEBRUNNER_RESEARCH_MAX_MS` | `research_max_ms` | `900000` | Wall-clock cap for one `deep_research` call (15 minutes). Past it the tool returns `timeout`. |
| `WEBRUNNER_DAILY_COST_CAP_USD` | `daily_cost_cap_usd` | unset | Optional soft cap on total LLM spend per UTC day across every tool and every server process, tracked in `<cache dir>/daily-cost.json`. When reached, `deep_research` and `browse_task` return `budget_exceeded` until the next day. |
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
  "reddit_client_id": "<your-reddit-app-id>",
  "reddit_client_secret": "<your-key>",
  "youtube_api_key": "<your-key>",
  "finnhub_api_key": "<your-key>",
  "currency": "EUR",
  "research_max_cost_usd": 5,
  "model_writer": "claude-opus-5-5"
}
```

**Precedence:** an environment variable beats the file, and an empty environment variable counts as unset (so `BRAVE_API_KEY=` falls through to the file). Missing optional keys disable that provider and log a warning to stderr; they are not errors.

## Browser setup

`browse_task`, the Google Flights source of `search_flights`, `search_hotels`, Google Finance in `market_quote`, the browser platforms of `social_search` and `search_reviews`, `accounts` and `fetch_page` in browser mode all drive one shared browser, started lazily on first use and closed when the server exits. At most 3 pages are open at once (a login window opened by `accounts` is outside that count).

**Default: a tool-owned persistent profile.** webrunner launches Chromium with a profile directory it owns, `~/.config/webrunner/browser-profile` (change it with `WEBRUNNER_BROWSER_PROFILE_DIR`). The first run creates it; cookies and logins persist between runs. Pages get a 1366x768 viewport and your system locale and timezone. There are no stealth plugins and no automation-flag overrides beyond Playwright's defaults; if a site still blocks, the tool reports `blocked`.

**Logging into a site once.** No tool ever logs in for you. For the platforms the opinion tools read through (Reddit, X, Facebook, Google, Amazon, and Instagram and LinkedIn for later), the `accounts` tool opens the login page in the server's own browser window and waits while you sign in; see Accounts below. For any other site, sign in yourself, in that same profile, by running the browser headful from the checkout and closing it when done:

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

## Accounts

Some platforms show nothing, or almost nothing, to a visitor who is not logged in: X redirects anonymous search to its login page, Facebook search needs a session, Amazon limits review pages to signed-in users, and Reddit's website is friendlier to a logged-in browser when its public endpoints refuse an IP. The `accounts` tool lets you log into those platforms **yourself**, once, inside the browser profile the server owns, so that the browser-based sources of `social_search` and `search_reviews` read through your session.

What connecting is, and is not:

- **It is passive reading through your own session.** The recipes navigate, scroll and read. They never type credentials, never log in on your behalf, and never post, like, follow, reply, message or write a review (the tests spy on the browser's typing calls to prove it). A page that still asks for a login is reported, not worked around.
- **Cookie values never leave the server.** The browser session exposes cookie names, domains and expiry only; `accounts` reports a platform name and a boolean, `health` reports connected platform names, and no result or log line ever contains a cookie value. The profile directory (`~/.config/webrunner/browser-profile`) holds your sessions and is a secret like a key; keep it private.
- **It needs a window you can see.** `connect` opens the platform's login page in the server's browser, so the server must run where a display exists (a desktop; `BROWSER_HEADLESS=false` if detection gets it wrong), or be attached to your own Chrome with `BROWSER_CDP_URL` (see Browser setup). In headless mode `connect` returns a `config` error that names both ways out.

The flow, with `accounts`:

1. `{ "action": "list" }` shows every platform (`reddit`, `x`, `facebook`, `instagram`, `google`, `amazon`, `linkedin`): whether its session cookies are present, which tools read through it (`used_by`), the domains involved and, when known, when the login expires. `list` starts the browser if it is not running.
2. `{ "action": "connect", "platform": "x" }` opens `https://x.com/i/flow/login` in the webrunner browser window (or as a tab in your Chrome in CDP mode) and polls the cookies every 2 seconds for up to `wait_seconds` (default 120, max 300). Log in there yourself. The call returns `connected` as soon as the session cookies appear, `already_connected` if they were there, or `pending` when the wait ran out: the page then stays open for 10 minutes, and calling `connect` again after you finish picks the login up and closes the page. A verification checkpoint on X or Facebook is fine to complete in that window; it is your own session.
3. `{ "action": "disconnect", "platform": "x" }` removes that platform's cookies from the server's profile and says how many were cleared. The platform's servers still consider the session valid until it expires; log out there too if you care.

**Google: use your own Chrome.** Google usually refuses to sign in inside an automated Chromium ("This browser or app may not be secure"). Instead of `connect google`, start your Chrome with remote debugging as shown in Browser setup, set `BROWSER_CDP_URL`, and use the Google session you already have there. In CDP mode `connect` opens the login page as a tab in that Chrome, `list` reports that Chrome's logins, and `disconnect` is refused: webrunner never changes the cookies of your own browser; log out there. Google is listed because `search_hotels`, Google Maps and Google Play reviews and `search_flights` can use it for consent and personalisation, but all of them work logged out too.

**Terms of service and the risk to your account.** Automated reading of X, Facebook, Google Maps, Google Play, Amazon and Reddit's website (as opposed to its API) is against those platforms' terms. Done through your account it can get that account rate-limited, challenged or suspended; a CAPTCHA or checkpoint is reported as `blocked` and never solved. The owner has accepted this for personal, low-volume use from their own machine, as for Google Flights. Keep the volume low (a handful of searches, not a crawl), prefer the API platforms where they exist (Reddit's API with `REDDIT_CLIENT_ID`, Hacker News, Bluesky, YouTube, the App Store feed, Trustpilot), and use an account you would not mind losing for the browser platforms. Instagram and LinkedIn can be connected but no tool reads them yet.

## Using the tools

You normally just ask your assistant in plain language and it picks the tool. The calls below show the arguments the tools take; each example call is checked against the tool's input schema by a test. Results are trimmed (`...`) and the values are illustrative.

### web_search

<!-- example: web_search -->
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

<!-- example: fetch_page -->
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

`mode` is `auto` (default), `fast` (never opens a browser) or `browser` (always renders; `wait_for` takes a CSS selector to wait for). In auto mode the browser is used when the fast result is a bot wall or nearly empty. `method` reports which fetcher produced the page. Truncation is always flagged in `truncated`. Fast results are cached for 24 hours and browser results for 1 hour. PDFs are extracted to text by the direct fetcher (title, then page text with `---` between pages; 25 MB and 300 pages maximum; scanned PDFs with no text layer return `invalid_input`). Each call is capped at 90 seconds and returns a `timeout` error past that.

### deep_research

<!-- example: deep_research -->
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

<!-- example: browse_task -->
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

<!-- example: search_flights -->
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

### search_hotels

<!-- example: search_hotels -->
```json
{
  "destination": "Lisbon",
  "check_in": "2026-12-05",
  "check_out": "2026-12-08",
  "guests": { "adults": 2 },
  "max_price_per_night": 250,
  "star_classes": [3, 4],
  "sort": "price",
  "currency": "EUR"
}
```

```json
{
  "query": { "destination": "Lisbon", "check_in": "2026-12-05", "check_out": "2026-12-08", "nights": 3, "guests": { "adults": 2, "children": 0 }, "max_price_per_night": 250, "star_classes": [3, 4], "sort": "price", "currency": "EUR", "sources": ["google_hotels"], "max_results": 20 },
  "hotels": [
    {
      "id": "google_hotels:3f9a1c2b7d04",
      "source": "google_hotels",
      "name": "Hotel Example Chiado",
      "price_per_night": { "amount": 142, "currency": "EUR" },
      "total_price": { "amount": 489, "currency": "EUR" },
      "star_class": 4,
      "type": "hotel",
      "amenities": ["Breakfast", "Free Wi-Fi", "Air conditioning"],
      "tags": ["GREAT DEAL", "22% less than usual"],
      "url": "https://www.google.com/travel/hotels/entity/...",
      "availability": "available"
    }
  ],
  "sources_used": ["google_hotels"],
  "sources_failed": [],
  "fetched_at": "2026-10-21T10:00:00.000Z",
  "caveats": [
    "Google Hotels printed no guest rating for 18 of 18 hotels.",
    "Prices are quotes at fetch time; taxes and fees vary by booking site and can change before booking."
  ]
}
```

Google Hotels is read through the browser with a deterministic DOM parser, so no model call is made and no key is needed on a normal page; `ANTHROPIC_API_KEY` is used only when the layout is not recognised. The dates reach the page through the natural-language query form (the only form that set them live); the guest count did not change the page's travellers control from the development environment, so the recipe reads the controls back and adds a caveat when the page shows something other than what you asked. Caveats that matter:

- **Guest ratings and review counts.** On 2026-10-21 (verified live from a cloud session, logged out) organic cards carried them: 17 of 18 hotels in Rome and 18 of 18 in Paris, read deterministically. On 2026-10-18 the same kind of IP got them only on sponsored cards. Google varies this, so the fields stay optional, the tool says how many hotels had none, and `min_rating` on a page without ratings removes everything, with a caveat.
- Sponsored rows are returned, tagged `Sponsored`, with prices in the advertiser's currency, which the tool flags and does not convert or compare against `max_price_per_night`.
- `total_price` is the stay total with taxes and fees when the page prints one; otherwise it is omitted and a caveat says the total is nights times the nightly rate before taxes.
- Filters (`max_price_per_night`, `min_rating`, `star_classes`) and `sort` are applied in code after extraction. Stays are 1 to 30 nights, 1 to 8 adults and up to 6 children, at most 40 results. The page shows 18 hotels at a time; "Next" did nothing live (re-checked 2026-10-21: clicking it sends no request at all), so expect about 18 with a caveat saying how many existed.
- Google may rate-limit as it does for flights (`blocked`); wait a few minutes. The tool reads only and never opens a booking site. The call is capped at 120 seconds.

### market_quote

<!-- example: market_quote -->
```json
{ "symbols": ["AAPL", "VOD.L", "bitcoin"], "history": { "range": "1mo" }, "currency": "USD" }
```

```json
{
  "quotes": [
    {
      "requested": "AAPL", "symbol": "AAPL", "name": "Apple Inc.", "asset_type": "stock", "exchange": "NMS", "currency": "USD",
      "price": 343.46, "previous_close": 342.0, "change": 1.46, "change_pct": 0.43, "open": 341.9, "day_high": 345.1, "day_low": 340.8,
      "volume": 48123456, "market_cap": 5100000000000, "market_state": "closed", "as_of": "2026-10-20T20:00:01.000Z", "delayed_min": 15,
      "source": "yahoo",
      "history": { "range": "1mo", "interval": "1d", "bars": [{ "t": "2026-09-21T13:30:00.000Z", "o": 330.1, "h": 333.0, "l": 329.5, "c": 331.2, "v": 41000000 }] }
    },
    { "requested": "bitcoin", "symbol": "BTC", "name": "Bitcoin", "asset_type": "crypto", "currency": "USD", "price": 98765.4, "change_pct": -1.2, "market_cap": 1950000000000, "as_of": "2026-10-21T10:00:00.000Z", "source": "coingecko" }
  ],
  "unresolved": [],
  "sources_used": ["yahoo", "coingecko"],
  "sources_failed": [],
  "fetched_at": "2026-10-21T10:00:05.000Z",
  "caveats": ["Quotes may be delayed; not investment advice.", "yahoo: equity quotes are typically delayed 15 minutes."]
}
```

Each input is routed to the first source that can answer it: anything that looks like crypto (`BTC`, `BTC-USD`, `bitcoin`) goes to CoinGecko, then Yahoo, a coin's name as its ticker (`bitcoin` is quoted as `BTC`); everything else goes to Yahoo Finance, then Finnhub (with `FINNHUB_API_KEY`, US equities, no history), then Google Finance through the browser. A name (`Apple`) is looked up first and the best match quoted, with up to three other matches named in `caveats`. Inputs nobody could quote land in `unresolved` and the call still succeeds when at least one quote exists. Stocks are quoted in their listing currency (London quotes come in `GBX`, pence, from both Yahoo and Google Finance, with a caveat); indices in the currency Yahoo gives them; crypto in `currency` (default `WEBRUNNER_CURRENCY`). `change` and `change_pct` are the day's change, whatever history range you ask for. History is at most 1000 bars; CoinGecko picks its own bar size and the result names the nearest `interval`. Quotes are cached for 60 seconds, history for 10 minutes, lookups for a day.

- **Yahoo Finance rate-limits.** It answered 429 to every request from the v0.2 development environment; on 2026-10-21 (verified live from a cloud session) it answered the server's own requests while still refusing `curl` from the same network, so its block looks at the client as well as the IP. A 429 hands the symbol to the next source, so when Yahoo refuses you and there is no Finnhub key, an equity quote comes from Google Finance, which gives the quote only (no history). Add `FINNHUB_API_KEY` for a key-backed second source.
- Google Finance is read from the page's visible text (the 2026 markup carries no data attributes); a bare ticker is tried on NASDAQ, NYSE and NYSE Arca in turn, Yahoo-style suffixes map to exchanges (`.L` to `LON`, `.DE` to `ETR`, `.T` to `TYO`, ...), Yahoo index tickers to Google's (`^GSPC` to `.INX:INDEXSP`), and share classes to Google's form (`BRK-B` to `BRK.B`, `BT-A.L` to `BT.A:LON`, `VOLV-B.ST` stays `VOLV-B:STO`). Checked live on 2026-10-21: `.L .DE .PA .AS .SW .MC .MI .ST .CO .T .TO .AX .HK .NS .KS .SS .SA .SI`, bare NASDAQ, NYSE and NYSE Arca tickers, and `^GSPC ^FTSE ^DJI ^N225`. Reading Google Finance automatically is against Google's terms.
- Each source gets 10 seconds per symbol and the whole call 30 seconds.

### weather

<!-- example: weather -->
```json
{ "location": "Paris, FR", "days": 5, "units": "metric", "hourly": false }
```

```json
{
  "location": { "name": "Paris", "country": "France", "admin1": "Île-de-France", "latitude": 48.85341, "longitude": 2.3488, "timezone": "Europe/Paris" },
  "current": { "time": "2026-10-21T12:00", "temperature": 14.2, "apparent_temperature": 12.8, "humidity_pct": 71, "wind_speed": 13.0, "wind_direction_deg": 240, "precipitation": 0, "weather_code": 3, "condition": "Overcast", "is_day": true },
  "daily": [
    { "date": "2026-10-21", "temp_max": 16.1, "temp_min": 9.4, "precipitation_sum": 0.3, "precipitation_probability_max": 20, "wind_speed_max": 22.3, "sunrise": "2026-10-21T08:19", "sunset": "2026-10-21T18:51", "weather_code": 3, "condition": "Overcast", "uv_index_max": 2.1 }
  ],
  "units": { "temperature": "°C", "wind_speed": "km/h", "precipitation": "mm" },
  "source": "open_meteo",
  "fetched_at": "2026-10-21T10:00:00.000Z",
  "caveats": ["Times are local to Europe/Paris."]
}
```

Open-Meteo only, no key, no account. A place name goes through Open-Meteo's geocoder and the first match is used; when other matches lie in a different country or region, a caveat lists up to three with their coordinates, and `location` also accepts `{ "latitude": 48.85, "longitude": 2.35 }` to pick one. `hourly: true` adds the next 48 hours. `condition` is the WMO weather code's plain-English text. Forecasts are cached for 10 minutes and geocoding for 30 days; the call is capped at 20 seconds. The geocoder and the forecast endpoint were both verified live on 2026-10-21 (from a cloud session, not yet from the owner's own machine). Open-Meteo's free tier limits requests per IP per day: from that shared cloud IP some forecast requests answered HTTP 429 "Daily API request limit exceeded", which the tool returns as a retryable `provider` error; a home IP is far below the limit.

### exchange_rate

<!-- example: exchange_rate -->
```json
{ "from": "USD", "to": ["EUR", "GBP", "JPY"], "amount": 250 }
```

```json
{
  "base": "USD",
  "date": "2026-10-20",
  "amount": 250,
  "rates": [
    { "currency": "EUR", "rate": 0.9214, "converted": 230.35 },
    { "currency": "GBP", "rate": 0.7786, "converted": 194.65 },
    { "currency": "JPY", "rate": 151.23, "converted": 37807.5 }
  ],
  "source": "frankfurter",
  "fetched_at": "2026-10-21T10:00:00.000Z",
  "caveats": ["ECB reference rates, published once per working day around 16:00 CET; not a trading quote. Crypto is not covered."]
}
```

Frankfurter serves the European Central Bank's reference rates for about 30 major currencies, keyless. **Rates are published once per working day** around 16:00 CET, so `date` in the result is the reference date the rates are for: on a weekend or holiday that is the previous working day, and before the daily fixing it is yesterday's. Pass `date` (YYYY-MM-DD, 1999-01-04 or later) for a historical rate. An unsupported code returns `invalid_input` listing the supported ones; crypto is not covered (use `market_quote`). Latest rates are cached for an hour, historical ones for 30 days; the call is capped at 20 seconds.

### social_search

<!-- example: social_search -->
```json
{
  "query": "Framework Laptop 16 battery life",
  "platforms": ["reddit", "hackernews", "bluesky"],
  "kind": "both",
  "recency": "month",
  "sort": "engagement",
  "max_results": 30,
  "summarize": true
}
```

```json
{
  "query": { "mode": "search", "query": "Framework Laptop 16 battery life", "platforms": ["reddit", "hackernews", "bluesky"], "kind": "both", "recency": "month", "sort": "engagement", "max_results": 30, "per_platform": 15 },
  "items": [
    {
      "id": "reddit:t3_1abc2de", "platform": "reddit", "kind": "post",
      "url": "https://www.reddit.com/r/framework/comments/1abc2de/...", "author": "u_example", "title": "Two months with the FW16: battery is the weak spot",
      "text": "...", "truncated": false, "created_at": "2026-10-02T14:03:00.000Z", "score": 412, "replies": 138, "community": "r/framework"
    },
    { "id": "hackernews:41922001", "platform": "hackernews", "kind": "comment", "url": "https://news.ycombinator.com/item?id=41922001", "author": "hn_user", "text": "...", "truncated": false, "created_at": "2026-10-05T09:12:00.000Z", "score": 57, "parent_url": "https://news.ycombinator.com/item?id=41921000" }
  ],
  "summary": {
    "text": "Most posters find the battery lasts four to six hours of light use [reddit:t3_1abc2de, hackernews:41922001] ...",
    "themes": [{ "theme": "Battery life under light use", "sentiment": "negative", "item_ids": ["reddit:t3_1abc2de", "hackernews:41922001"] }],
    "cost_usd": 0.04
  },
  "platforms_used": ["reddit", "hackernews", "bluesky"],
  "platforms_failed": [],
  "fetched_at": "2026-10-21T10:00:00.000Z",
  "caveats": []
}
```

Give `query` to search, or `url` (a Reddit, Hacker News, Bluesky, YouTube, X or Facebook post URL) to get that thread's comments, in which case the first item is the post itself. `platforms` unset means every platform that is configured: Reddit, Hacker News and Bluesky always; YouTube with `YOUTUBE_API_KEY`; X and Facebook when the browser is available. Each platform returns at most `per_platform` items (default 15); the merge deduplicates by URL, sorts by `engagement` (score, unknown scores last) or `recent`, and cuts at `max_results`. `subreddits` restricts Reddit; `lang` filters Bluesky and X. `summarize: true` makes one extractor-model call over the items and writes `summary.text` (every claim followed by the item ids it rests on) and `themes` with sentiment; it needs `ANTHROPIC_API_KEY`, is capped by `max_cost_usd` (default 0.50), and when the model is unavailable the items still come back with a caveat. Results are cached for 15 minutes per platform and query.

- **Reddit has three steps.** With `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` the Reddit API is used (app-only OAuth, the reliable path). Without them the public `.json` endpoints on `www.reddit.com` are tried with a descriptive User-Agent (`REDDIT_USER_AGENT`); Reddit refuses many IPs with 403 (the development environment included). On a 403 or 429 the browser recipe on `old.reddit.com` takes over, using the profile's Reddit session if you connected one; it parses the page deterministically (no model call) and clicks through the over-18 interstitial once. From the development IP old.reddit redirected search to its login page and then blocked the browser outright; from a home IP it normally serves search anonymously, and if it still redirects to login, `accounts connect reddit` is the fix. The error message names the fix when every step fails.
- **X and Facebook need a connected account** (see Accounts): X redirects anonymous search to its login flow and Facebook answers anonymous search with a 404, so without a login they fail with `needs_login: true` in `platforms_failed` while the other platforms still answer. From the development IP, X answered a bare 403 to headless Chromium even on its login page, which is reported as `blocked` with a message pointing at `accounts connect x`; expect to need a logged-in profile for X to show anything at all. Facebook's DOM is obfuscated, so its posts are extracted by the model (`ANTHROPIC_API_KEY`, refused with `config` before any page opens when the key is missing), under the same `max_cost_usd`; `recency` has no URL form on Facebook and becomes a caveat. X honours `recency` through its `since:` operator and `lang` through `lang:`. A CAPTCHA or checkpoint is `blocked`.
- **YouTube spends quota.** Each search costs 100 of the 10,000 daily units of a default YouTube Data API key, plus small amounts for statistics and comment threads; comments are read for the top 3 videos. Posts are videos; comments are their comment threads.
- Bluesky was verified live on 2026-10-21 (from a cloud session): its cached public host, `public.api.bsky.app`, refuses keyless search with a 403 page, so search goes to `api.bsky.app`, which answers it keyless, while threads and handle lookups stay on the public host; the live shapes matched the documented ones. Hacker News was recorded live. Reddit's JSON endpoints still refused the cloud IPs, so the Reddit mapping follows the documented shape.
- API platforms get 15 seconds each, browser platforms 60; the whole call is capped at 180 seconds. The tool never posts, likes, follows, replies or messages.

### search_reviews

<!-- example: search_reviews -->
```json
{ "subject": "Notion", "kind": "app", "sources": ["app_store"], "min_rating": 1, "max_rating": 3, "sort": "recent", "per_source": 20 }
```

```json
{
  "query": { "subject": "Notion", "kind": "app", "sources": ["app_store"], "max_results": 30, "per_source": 20, "min_rating": 1, "max_rating": 3, "sort": "recent", "app_store_country": "us" },
  "subjects": [
    { "source": "app_store", "name": "Notion: Notes, Tasks, AI", "url": "https://apps.apple.com/us/app/notion-notes-tasks-ai/id1232780281", "rating_avg": 4.7, "review_count": 1056432, "categories": ["Productivity", "Business"] }
  ],
  "reviews": [
    {
      "id": "app_store:14671531500", "source": "app_store", "url": "https://apps.apple.com/us/app/id1232780281?see-all=reviews",
      "author": "Reviewer42", "rating": 2, "title": "Sync keeps failing", "text": "...", "truncated": false,
      "created_at": "2026-10-19T17:42:00.000Z", "version": "1.7.346"
    }
  ],
  "sources_used": ["app_store"],
  "sources_failed": [],
  "fetched_at": "2026-10-21T10:00:00.000Z",
  "caveats": ["Reviews are sorted by date as the App Store feed returns them; at most 3 pages of 50 were read."]
}
```

`subject` is a name or the URL of a product, place or app page; `kind` picks the default sources (`place`: Google Maps; `business`: Google Maps and Trustpilot; `product`: Amazon and Trustpilot; `app`: App Store and Google Play; `any`: all five that are configured), and `location` disambiguates places. Each source contributes one `subjects` entry (what it matched, with its average rating and review count) and at most `per_source` reviews; ratings are normalised to 1 to 5 (10-point scales halved, percentages divided by 20); the merge filters by rating and recency, sorts (`relevance` interleaves the sources in their own order; `recent`, `rating_low`, `rating_high`), and cuts at `max_results`. A review's `created_at` is approximate when the site prints "2 months ago", and a caveat says so. `summarize` works as in `social_search`. Results are cached for an hour per source and subject.

- **App Store** is keyless: the iTunes search finds the app (`app_store_country` picks the storefront, default `us`), then the customer-reviews feed is read, newest first, at most 3 pages of 50. Verified live.
- **Trustpilot** is fetched as a plain page and parsed from its embedded JSON. A subject that is a bare domain (`notion.so`, `booking.com`) goes straight to that company's page; a name goes through Trustpilot's search. Raw requests from cloud IPs get an AWS WAF challenge; the source then renders the page in the browser (the challenge is a script any browser runs; nothing is solved or faked) and reads the same embedded JSON, with no model call. Only if that fails does it fall back to a model extraction over the page text (`ANTHROPIC_API_KEY`). Verified live on 2026-10-21 from a cloud session: past the WAF, in 2 to 4.5 s per subject including a name lookup. The source gets 60 seconds.
- **Google Maps, Google Play and Amazon** are read through the browser. Google Maps reviews come from the first matching place and its reviews tab (consent dialogs dismissed); Google Play from the app's details page; Amazon from the first product's review pages. Amazon usually shows a CAPTCHA (`blocked`) or limits reviews to signed-in users (`needs_login`: connect `amazon` with `accounts`). From the development environment (2026-10-21) Google Play's search and details pages rendered and are the basis of its fixtures; Google Maps' script bundle answered HTTP 403 so the page never rendered and its recipe is tested on synthetic markup only; Amazon's search page rendered but its review list redirected to the sign-in page with a soft bot check, which is what the recipe reports as `needs_login`. Your first run from a home IP, with Amazon connected, is the real test of the Maps and Amazon selectors.
- The App Store gets 15 seconds, Trustpilot and the browser sources 60; the whole call is capped at 180 seconds. The tool never writes a review.

### accounts

<!-- example: accounts -->
```json
{ "action": "connect", "platform": "x", "wait_seconds": 120 }
```

```json
{
  "action": "connect",
  "platform": "x",
  "status": "pending",
  "login_url": "https://x.com/i/flow/login",
  "waited_s": 120,
  "instructions": "The login page for x is open in the webrunner browser window and stays open for 10 minutes. Log in there yourself (webrunner never types credentials), then call accounts with action \"connect\" and platform \"x\" again; it answers connected as soon as the session cookies are present.",
  "caveats": ["webrunner never types into the login page; you log in yourself in the window it opens.", "Cookie values are never returned or logged; only cookie names are checked.", "x may show a verification checkpoint on a new browser; completing it in the window is fine, it is your own session."]
}
```

<!-- example: accounts -->
```json
{ "action": "list" }
```

`list` returns `mode` (`persistent` or `cdp`), the profile directory in persistent mode, and one entry per platform with `connected`, `domains`, `used_by`, `checked_at` and `expires_at` when known. `disconnect` returns `disconnected` with `cookies_cleared`, or `not_connected`. See Accounts above for the flow, the Google recommendation and the risks. The call is capped at 330 seconds (the longest wait plus margin).

### ping

`ping` takes no arguments and returns `{ "ok": true, "version": "0.2.0", "time": "..." }`. It is the quickest way to confirm the client can reach the server.

### health

`health` takes no arguments. It returns the server version and uptime; under `config`, which search providers, fast fetchers, flight sources, hotel sources, market sources, social platforms (with `api` or `browser` access) and review sources are configured, whether `ANTHROPIC_API_KEY`, the Reddit API pair, `YOUTUBE_API_KEY` and `FINNHUB_API_KEY` are set (booleans, never values), the model per role, and the browser mode (persistent profile or CDP attach, with `cdp_url` reduced to scheme and host); under `browser`, whether a browser is currently open and its page pool; under `accounts.connected`, the platforms whose session cookies are present **when the browser is already open**, and `null` when it is not (health never starts Chromium to look); cache directory statistics; and the list of registered tools. It makes no network calls. When any tool returns a `config` error, call `health` first to see which key or service is missing.

### Errors

Failures return `isError: true` with `{ "error": { "code", "message", "retryable", "details?" } }`. The codes are `config` (a key is missing or a value is invalid), `provider` (an upstream service failed), `timeout`, `blocked` (a bot wall, CAPTCHA, login wall or rate limit), `budget_exceeded`, `invalid_input` and `internal`. When a browser platform or source hit a login wall, its entry in `platforms_failed` or `sources_failed` carries `needs_login: true` and the message names the `accounts` tool; when every platform needed a login the whole call is `blocked` with `needs_login` in `details`. Malformed arguments are rejected by the MCP layer before the tool runs, with a plain validation message instead of this envelope.

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
| `search_hotels`, `market_quote`, `weather`, `exchange_rate` | $0 on a recognised page or API answer; $0.02 to $0.08 when a browser recipe (Google Hotels, Google Finance) falls back to one extraction call |
| `social_search`, `search_reviews` without `summarize` | $0 for API and fetch sources; $0.02 to $0.10 per browser source that needs model extraction (Facebook always, the others only on an unrecognised layout) |
| `social_search`, `search_reviews` with `summarize: true` | $0.02 to $0.10 for the summary (one Sonnet-class call over up to 100 items), on top of the above; capped by `max_cost_usd` (default 0.50) |
| `accounts` | $0 |

Provider fees outside the Claude API: YouTube search spends 100 of a key's 10,000 daily quota units per search; the Reddit API, Finnhub, CoinGecko, Frankfurter, Open-Meteo, Hacker News, Bluesky and the App Store feed are free at this volume.

`deep_research` reports its actual spend in `stats.cost_usd`. That figure is **LLM spend only**: search and fetch provider fees (Brave, Exa, Firecrawl and so on) are billed by those providers and are not metered here. `max_cost_usd` is a hard stop on the same LLM spend: the server checks the running total before every model call, so the overshoot is at most one call. When the cap is reached the tool returns what it has, `stats.stopped_reason` is `budget`, and `gaps` explains the cutoff. The server keeps an estimate of the writer's cost in reserve so a report can still be produced. The default cap comes from `RESEARCH_MAX_COST_USD` (3.00); `max_cost_usd` on a call overrides it. `browse_task` has its own `max_cost_usd` (default 1.00).

Two more limits apply everywhere. Every tool has a wall-clock cap (`web_search` 30 s, `fetch_page` 90 s, `search_flights` 120 s, `search_hotels` 120 s, `market_quote` 30 s, `weather` 20 s, `exchange_rate` 20 s, `social_search` 180 s, `search_reviews` 180 s, `accounts` 330 s, `browse_task` 10 min, `deep_research` 15 min via `WEBRUNNER_RESEARCH_MAX_MS`) and returns a retryable `timeout` error when it is hit. Setting `WEBRUNNER_DAILY_COST_CAP_USD` adds a soft daily ceiling on LLM spend shared by all server processes: the call that crosses it completes, the next LLM-dependent call is refused with `budget_exceeded` naming the variable and the day's spend. Upstream calls to search providers, fast fetchers and Duffel are retried at most twice with jitter on retryable failures, honoring `Retry-After` on 429, and are limited to a few concurrent requests per provider so a wide research run cannot flood one API.

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

You should see one JSON line on stdout that includes the fourteen tools, and JSON log lines on stderr. Also check that you built (`npm run build`; `dist/index.js` must exist), that the path in the client config is absolute and correct, and that `node` is version 22 or newer. Run `claude mcp list` or `codex mcp list` to see the client's view.

**`config` errors.** `Invalid configuration:` on stderr, exit code 1: a variable or a `config.json` key has a bad value or an unknown name; the message names it (for example `environment variable RESEARCH_MAX_COST_USD: must be a number`). A tool returning code `config` means a key it needs is unset, for example `ANTHROPIC_API_KEY` for `deep_research`, or no search key for `web_search`. Keys in the client's config reach the server only if they were passed (Claude Code `--env`, Codex `env_vars` and the shell Codex was started from); the `config.json` file is the fallback that always works.

**`blocked` errors.** The site served a bot wall, CAPTCHA, login wall or rate limit. webrunner does not try to get around these. Log in once in the browser profile (see Browser setup), try `fetch_page` with `mode: "browser"`, wait and retry for rate limits, or use another source.

**Chromium does not start.** Run `npx playwright install chromium` from the checkout. On Linux without a display, webrunner runs headless on its own.

**Two processes, one profile** (`ProcessSingleton`, "profile appears to be in use", or a launch that hangs and times out). A Chromium profile directory can be used by one browser at a time. Each Claude Code or Codex session starts its own webrunner server, so two sessions that both need the browser fight over `~/.config/webrunner/browser-profile`, and so does a window you opened by hand for logging in. Close the hand-opened window, keep one browser-using session at a time, or give each client its own `WEBRUNNER_BROWSER_PROFILE_DIR` (logins then have to be repeated per profile). Attaching every session to your own Chrome with `BROWSER_CDP_URL` avoids the problem, since Chrome owns the profile and webrunner only connects.

**`needs_login` in `platforms_failed` or `sources_failed`.** The platform wants a session (X, Facebook, Amazon's review pages, sometimes Reddit's site). Run `accounts` with `action: "connect"` and that platform, log in yourself in the window it opens, and repeat the search; `accounts list` shows what is connected. In headless mode `connect` cannot show a window and says so (`config`): run the server on a desktop with `BROWSER_HEADLESS=false`, or attach to your own Chrome. For Google, attach to your Chrome rather than logging in inside Chromium. The other platforms in the same call still answer; only the entry with `needs_login: true` is missing.

**`blocked` on a social platform or review site.** A CAPTCHA, checkpoint, "unusual traffic" page or rate limit, often on X, Facebook, Amazon and Google after a burst of requests from one account or IP. webrunner never solves these. Wait a while, lower the volume, prefer the API platforms (Reddit API with `REDDIT_CLIENT_ID`, Hacker News, Bluesky, YouTube, the App Store feed), and if a checkpoint appears in the browser window, completing it yourself is fine. Reddit's public JSON endpoints answering 403 is also a block on the IP, not on you: set up a Reddit app for the API path. Trustpilot's WAF challenge is handled by rendering the page in the browser; a `blocked` from Trustpilot means there was no browser to render it and no `ANTHROPIC_API_KEY` for the text fallback.

**`429` from Google, or `blocked` from `search_flights`.** Google rate-limits repeated searches from one IP. Wait several minutes, reduce volume, or use Duffel.

**Timeouts.** Google Flights is given 90 seconds and Duffel 45. `deep_research` can run for minutes; Codex's default tool timeout (60 seconds) is too short, which is why the Codex installer sets 900. If you wrote the Codex block by hand, set `tool_timeout_sec` yourself.

**Stale results.** Search results are cached for an hour and fetches for an hour or a day. Clear the cache with `rm -rf ~/.cache/webrunner` (or your `WEBRUNNER_CACHE_DIR`).

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
```

`npm test` builds first (`pretest`), then runs the offline unit tests, including a stdout-purity test that starts the server and checks that only protocol frames reach stdout. `npm run typecheck` covers both `src/` and `test/`. The browser-backed suites (`test/unit/browser`, the Google Flights recipe tests) run only when Chromium is launchable and skip with a visible notice otherwise.

CI has three workflows. `check` runs lint, typecheck and the unit tests with the browser suites skipped. `browser-tests` installs Chromium and runs the browser suites. `live.yml` runs the gated integration tests every Sunday at 06:00 UTC and on demand, using whichever of these repository secrets are set: `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `DUFFEL_API_KEY` (a sandbox key), `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`, `YOUTUBE_API_KEY`, `FINNHUB_API_KEY`. The keyless suites (Hacker News, Bluesky, Reddit's public endpoints, CoinGecko, Frankfurter, Open-Meteo, Yahoo, the App Store, Trustpilot, Google Hotels) run on every schedule; tests whose key is missing skip, and the job summary says which. A new tool must be added to `TOOL_NAMES` in `src/tools/index.ts` and given a case in `test/unit/tools/envelope.test.ts`, otherwise two tests fail; its README subsection needs an example call marked `<!-- example: <tool> -->`, which `test/unit/readme-examples.test.ts` checks against the tool's input schema. `docs/mcp-sdk-v2-migration.md` records the evaluation of moving to MCP SDK v2 and recommends doing it in one dedicated change before v1 support ends. Integration tests hit real services (search providers, a live browser, Google Flights, Google Hotels, Duffel, the market, weather, exchange-rate, social and review services, and the social browser platforms) and are excluded by default: run them with `RUN_INTEGRATION=1 npm test`. Each integration test also skips itself when the keys it needs are missing; the browser ones need Chromium installed. Evals are separate (see Evals).

`PLAN.md` is the design document and the source of truth for the tool contracts, internal interfaces, configuration and cost model; its decision log records why things are the way they are. The project was built as numbered work packages (WP0 to WP14 for v0.1, WP15 to WP21 for v0.2), each implemented by an agent session on its own branch against the contracts in `PLAN.md`, reviewed and merged in dependency order. A change to a contract starts with an edit to `PLAN.md` in its own pull request. `CLAUDE.md` holds the short rules for agents working in this repository.

## License

MIT. See [LICENSE](LICENSE).
