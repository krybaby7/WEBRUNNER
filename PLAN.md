# WEBRUNNER: Implementation Plan

> Repository: github.com/krybaby7/WEBRUNNER (GitHub slugs are case-insensitive). The npm package and all code use lowercase `webrunner`.
> Status: v0.1 shipped 2026-10-18; v0.2 (section 14) built 2026-10-21 on `v02-all-rounder`, pending the owner's review into `main`.
> Audience: an orchestrator model (Claude Fable 5.1) that delegates work packages to implementer models (Claude Sonnet 5.5), and the human owner who reviews PRs.

## 0. How to use this document

This plan is written to be executed by agents, so it is more prescriptive than a plan for humans would be.

- **Section 3 (tool contracts) and Section 4 (internal interfaces) are the source of truth.** Every work package implements against them. Changing a contract requires editing this file first, in its own PR, so parallel workers never drift.
- **Section 6 is the work breakdown.** Each work package (WP) is sized for one implementer session, lists its dependencies, and has acceptance criteria that can be checked mechanically. The orchestrator should not hand out a WP whose dependencies are not merged.
- **Section 7 is the orchestration protocol.** It says how to brief an implementer, what "done" means, and what the orchestrator must verify before merging.
- Decisions marked **DECIDED** are not to be reopened by implementers. Decisions marked **OPEN** need the owner.

---

## 1. Goal and non-goals

### Goal

A single MCP server, run locally over stdio, that gives Claude Code and Codex four capabilities:

1. **Web search** that fans out to multiple search APIs and returns a merged, deduplicated, ranked result list.
2. **Page fetching** that turns any URL into clean Markdown, with a real-browser fallback for JavaScript-heavy or logged-in pages.
3. **Deep research** that runs a plan-search-read-reflect loop server-side and returns a cited report, with depth controlled by the caller. The bar is "better than Perplexity Deep Research for the owner's questions", achieved by more iterations, more sources, and a stronger synthesis model.
4. **Live browsing** for data that only exists behind interactive pages, with a recipe system for sites the owner cares about. The first recipe is Google Flights, exposed as `search_flights` returning exact fares and times.

### Non-goals

- Not a hosted or multi-user service. One owner, one machine, the owner's own browser profile.
- Not a general-purpose "book this for me" agent. Browsing tools read and extract. They do not submit payment forms.
- Not a replacement for Playwright MCP's UI-testing use case.
- No attempt to bypass CAPTCHAs or anti-bot systems beyond using a normal persistent browser profile. If a site blocks, the tool reports it.

### Constraints that shape the design

- **DECIDED: TypeScript, Node 22+.** The MCP SDK and Playwright are TypeScript-first, and Codex and Claude Code both launch stdio servers via `node`/`npx`.
- **DECIDED: stdio transport only for v1.** No HTTP transport. Simpler security story for a personal tool.
- **DECIDED: all logging to stderr.** stdout is the MCP protocol channel. A single stray `console.log` breaks the server. Lint rule enforces this.
- **DECIDED: the server calls the Claude API directly** for research and extraction, via the official `@anthropic-ai/sdk`. Claude Code and Codex see one tool call, not forty.
- **DECIDED: MCP SDK 1.32.x (the v1 line) for v1 of this project.** The SDK's v2 packages (`@modelcontextprotocol/server`) became the stable line in July 2026 and v1 is in maintenance for at least six months from then. v1 is what the scaffold, tests and docs are built on; WP14 evaluates the migration.
- **DECIDED: `ANTHROPIC_API_KEY` is optional at startup.** Search and fetch work without it. Tools that need the LLM (`deep_research`, `browse_task`, LLM extraction in recipes) return error code `config` when it is unset.
- Terms of service: scraping Google Flights violates Google's ToS. Acceptable for personal use by the owner's explicit decision. The repo README must say so and the server must not be published as a hosted service.

---

## 2. Architecture

```
 Claude Code / Codex
        │  MCP over stdio
        ▼
┌─────────────────────────────────────────────────────────────┐
│  webrunner server (Node)                                 │
│                                                             │
│  tools/                                                     │
│   web_search ─┐                                             │
│   fetch_page ─┼─► core/search   (SearchProvider[] + fusion) │
│   deep_research ─► core/research (loop; uses search+fetch)  │
│   browse_task ───► core/browser (Playwright, recipes)       │
│   search_flights ► recipes/google-flights (+ Duffel option) │
│                                                             │
│  core/fetch     fast path (Firecrawl/Jina/direct+readability)│
│                 browser path (Playwright page → Markdown)   │
│  core/llm       Anthropic SDK wrapper, model routing, cost  │
│  core/cache     disk cache for search + fetch results       │
│  core/config    env + config file, validated at startup     │
└─────────────────────────────────────────────────────────────┘
        │                 │                   │
   Search APIs       Fetch services      Local Chromium /
 Brave, Exa, Tavily,  Firecrawl, Jina    owner's Chrome (CDP)
 Perplexity Search
```

Two engines share the fetcher and the LLM client but nothing else:

- **Research engine**: read-mostly, many cheap calls, optimizes for coverage and citation quality.
- **Browser engine**: interactive, few expensive steps, optimizes for reliability on specific sites.

Keeping them separate keeps fragile scraping code out of the research path.

### Repository layout

```
webrunner/
  PLAN.md                     this file
  README.md                   install, config, ToS note
  package.json
  tsconfig.json
  src/
    index.ts                  entry: build server, register tools, stdio
    server.ts                 McpServer construction, calls registerTools
    deps.ts                   Deps passed to every tool: config, log, later cache/llm/search/fetch/browser
    config.ts                 env/config loading + validation (zod)
    log.ts                    stderr logger
    tools/
      index.ts                registerTools(server, deps): one line per tool
      ping.ts
      web_search.ts
      fetch_page.ts
      deep_research.ts
      browse_task.ts
      search_flights.ts
    core/
      search/
        types.ts              SearchProvider interface, ProviderError
        normalize.ts          published_at normalization
        canonical.ts          URL canonicalization (WP2)
        fusion.ts             dedupe + reciprocal rank fusion (WP2)
        index.ts              SearchService (WP2)
        providers/
          brave.ts
          exa.ts
          tavily.ts
          perplexity.ts
      fetch/
        types.ts              Fetcher interface, FetchError
        botwall.ts            bot-wall signatures, isThin(), visibleText()
        fast/                 firecrawl.ts, jina.ts, direct.ts, extract.ts, shared.ts, index.ts (buildFastFetchers, runFastChain)
        browser.ts            Playwright page → Markdown (BrowserFetcher)
        index.ts              auto mode selection (WP5)
      browser/
        types.ts              BrowserSession, Snapshot, pool stats
        session.ts            persistent context / CDP attach
        snapshot.ts           accessibility tree + screenshot
        agent.ts              generic step loop for browse_task
        recipes/
          types.ts            Recipe interface
          registry.ts
          google-flights.ts
      research/
        engine.ts             plan → search → read → reflect → write
        prompts.ts
        report.ts             report + citation formatting
      llm/
        client.ts             Anthropic SDK wrapper
        models.ts             model routing table
        cost.ts               token/cost accounting
      cache/
        index.ts              disk cache (content-addressed JSON)
    schemas/                  zod schemas shared by tools and tests
      error.ts                error envelope + toolError()
      result.ts               jsonResult() success helper
  test/
    unit/
    fixtures/                 recorded provider responses
    integration/              gated by env var, hits real services
    evals/
      research/questions.json  20 questions + rubrics
      run.ts
  scripts/
    install-claude-code.sh
    install-codex.sh
```

---

## 3. Tool contracts (source of truth)

All tools return JSON in the MCP `content` as a single `text` block containing a JSON string, plus `structuredContent` where the client supports it. Use `jsonResult(data)` from `src/schemas/result.ts` for success and `toolError(code, message, retryable, details?)` from `src/schemas/error.ts` for failure. All errors use the error envelope in 3.6. All timestamps are ISO 8601 UTC.

Tool wiring convention (DECIDED): each tool lives in `src/tools/<name>.ts` and exports `register<Name>Tool(server: McpServer, deps: Deps)`. It is wired by adding one line to `src/tools/index.ts`. Tools receive everything they need through `Deps` (`src/deps.ts`). `Deps` already carries `config`, `log`, `cache`, `search`, `llm` and `browser` (lazy `BrowserSession`, closed by `closeDeps` on shutdown); WP5 adds `fetch`. Input validation: tools pass their zod schema as `inputSchema`, so the MCP SDK rejects malformed input before the handler runs with the SDK's own error rather than a 3.6 envelope. This is accepted (DECIDED); the envelope's `invalid_input` code is for semantic failures the schema cannot express, such as an unresolvable city name.

### 3.1 `web_search`

Purpose: merged search across providers. Cheap and fast. Called constantly by the model and by the research engine.

Input:
```ts
{
  query: string;                       // required
  max_results?: number;                // default 10, max 30
  recency?: "day" | "week" | "month" | "year";
  include_domains?: string[];
  exclude_domains?: string[];
  providers?: ("brave" | "exa" | "tavily" | "perplexity")[]; // default: all configured
}
```

Output:
```ts
{
  query: string;
  results: Array<{
    url: string;                       // canonicalized (see 4.1)
    title: string;
    snippet: string;
    published_at?: string;
    providers: string[];               // which providers returned it
    score: number;                     // fused score, higher is better
  }>;
  providers_used: string[];
  providers_failed: Array<{ provider: string; error: string }>;
  cached: boolean;
  latency_ms: number;
}
```

Behavior:
- Query all requested providers in parallel with a per-provider timeout (default 8 s). A failed provider is reported, not fatal. If all fail, return the error envelope.
- Dedupe by canonical URL, fuse with reciprocal rank fusion (k = 60), then truncate.
- Cache by `(query, recency, domains, providers, max_results)` for 1 hour.
- Brave, Tavily and Perplexity return at most 20 results per call and are not paginated, so `max_results` above 20 may return fewer rows. A provider cut off by the per-provider timeout appears in `providers_failed` with a message containing "timed out".

### 3.2 `fetch_page`

Purpose: URL to Markdown.

Input:
```ts
{
  url: string;
  mode?: "auto" | "fast" | "browser";  // default "auto"
  max_chars?: number;                  // default 40000; truncation is flagged, never silent
  wait_for?: string;                   // browser mode: CSS selector to await
}
```

Output:
```ts
{
  url: string;
  final_url: string;
  title: string;
  markdown: string;
  truncated: boolean;
  method: "firecrawl" | "jina" | "direct" | "browser";
  fetched_at: string;
  cached: boolean;
}
```

Behavior:
- `fast`: try configured fast fetchers in order (Firecrawl, Jina, then direct HTTP + Readability + Turndown). Stop at the first that returns more than 500 chars of body text.
- `browser`: open in the browser engine, wait for network idle or `wait_for`, extract main content, convert to Markdown.
- `auto`: `fast`, then fall back to `browser` when any of these holds: the fast result has `botWall: true` (a wall served with HTTP 200), the fast result is thin (`isThin`, 500 visible characters or fewer), or the fast chain threw `FetchError` with code `blocked` (a wall served with 403/429/503). The browser fetcher never returns `botWall: true`; it throws `blocked`, which auto mode surfaces as the error envelope.
- Thin without wall evidence is not an error: when the fast result is merely thin and the browser is unavailable or fails, the thin fast result is returned. When the browser result is also thin and has less than twice the fast result's visible text, the fast result wins (the page is simply short). When the fast result is a bot wall and the browser fails for any reason, the tool returns `blocked`, never wall text.
- Jina Reader executes JavaScript, so a JS-rendered page is usually served by the fast path; the browser fallback matters mostly for sites that block Jina and direct fetches.
- Cache: keyed on the canonical request URL plus `mode`, `max_chars` and `wait_for`; a second alias entry is written under `final_url` when it differs. Thin and bot-walled results are never cached.
- PDFs are extracted by the direct fetcher (WP14b, `pdf-parse` with pdf.js verbosity set to errors so nothing reaches stdout): `# <title or file name>` then page text with `---` separators, 25 MB and 300 page caps, `invalid_input` for corrupt PDFs or PDFs without a text layer. Jina and Firecrawl PDF text passes through.
- Cache by `final_url` for 24 hours; `browser` results cache for 1 hour.

### 3.3 `deep_research`

Purpose: a cited report answering a question, produced by a server-side loop.

Input:
```ts
{
  question: string;
  depth?: "quick" | "standard" | "deep";   // default "standard"
  focus_domains?: string[];
  exclude_domains?: string[];
  recency?: "day" | "week" | "month" | "year";
  output?: "report" | "brief";             // default "report"
  max_cost_usd?: number;                   // hard stop; default from config
}
```

Depth budgets (DECIDED defaults, configurable):

| depth    | max search calls | max page reads | max loop iterations | writer model      |
|----------|------------------|----------------|---------------------|-------------------|
| quick    | 4                | 6              | 1                   | claude-sonnet-5-5 |
| standard | 12               | 20             | 3                   | claude-opus-5-5   |
| deep     | 30               | 50             | 6                   | claude-opus-5-5   |

Output:
```ts
{
  question: string;
  report_markdown: string;      // with inline [n] citations
  findings: Array<{
    claim: string;
    confidence: "high" | "medium" | "low";
    source_ids: number[];
  }>;
  sources: Array<{
    id: number;
    url: string;
    title: string;
    accessed_at: string;
    published_at?: string;      // ISO 8601 UTC when the page or search result carried a date
    used_for: string;           // one line on what this source supported
  }>;
  gaps: string[];               // what could not be established
  depth: "quick" | "standard" | "deep";   // echo of the effective depth
  stats: {
    searches: number;
    pages_read: number;
    pages_failed: number;       // fetches that errored and were skipped
    iterations: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;           // LLM spend only; search and fetch provider fees are not metered
    elapsed_ms: number;
    stopped_reason: "converged" | "iterations" | "budget" | "searches" | "reads" | "no_results" | "error";
  };
}
```

`findings[]` also carries an optional `quote: string` (verbatim supporting text from the source, 300 characters max) so a judge can check that a source actually supports the claim.

Invariants (DECIDED): every `[n]` in `report_markdown` has a matching `sources[].id`; every `findings[].source_ids` entry exists in `sources`; `sources[].id` are contiguous from 1 in first-citation order; no claim in the report lacks a citation except in the `gaps` section.

Engine entry point (DECIDED): `src/core/research/engine.ts` exports `runResearch(input: DeepResearchInput, deps: ResearchDeps): Promise<DeepResearchResult>` where `ResearchDeps = { search: SearchService; fetch: FetchService; llm: LlmClient; log: Logger; config: Config; now?: () => number }`. The input and result zod schemas live in `src/schemas/deep_research.ts`; the eval runner (`test/evals/research/schema.ts`) switches to importing them in WP8.

Behavior: see Section 5.

### 3.4 `browse_task`

Purpose: a goal-directed browser session for live data with no recipe. Read and extract only.

Input:
```ts
{
  goal: string;                 // natural language
  start_url?: string;
  max_steps?: number;           // default 15, max 40
  extract_schema?: object;      // JSON Schema; if present, output.extracted conforms to it
  allow_navigation_off_domain?: boolean;  // default false
  max_cost_usd?: number;        // hard cap on LLM spend for this run; default 1.00
}
```

Output:
```ts
{
  goal: string;
  outcome: "completed" | "partial" | "blocked";
  summary: string;
  extracted?: unknown;          // conforms to extract_schema if provided
  final_url: string;
  steps_taken: number;
  blocked_reason?: "captcha" | "login_required" | "bot_wall" | "timeout" | "max_steps";
  screenshots?: string[];       // file paths under the run dir, only if config.save_screenshots
}
```

Behavior:
- Never performs: form submissions on payment pages, clicking buttons whose text matches a configurable deny list (`Buy`, `Pay`, `Confirm purchase`, `Place order`, etc.), file downloads outside the run dir.
- Uses the owner's persistent profile (4.3). Stops with `blocked` on CAPTCHA detection rather than attempting to solve it.
- Implemented semantics (WP10): `steps_taken` counts page actions that actually ran (click, type, select, navigate, scroll, wait); refused or failed actions and the `screenshot`, `extract`, `done` and `blocked` decisions do not count, while `max_steps` bounds model decisions. `extract` without an `extract_schema` runs one extractor call that answers the goal in prose and becomes `summary`. `blocked_reason` is omitted for budget exhaustion and for model-reported blocks that fit no enum value; the explanation goes in `summary`. The deny rules match whole path tokens (`checkout`, `payment`, `pay`, `billing`, `order/confirm`), not substrings. Off-domain navigation is blocked by request interception so link clicks, script redirects and server redirects are all caught. A ten-minute wall-clock cap returns `partial` with `timeout`. Label refs act on the label's control, so element facts (password, card fields) are read from the control, not the label.

### 3.5 `search_flights`

Purpose: exact fares and schedules for a route and dates.

Input:
```ts
{
  origin: string;               // IATA code or city name
  destination: string;
  depart_date: string;          // YYYY-MM-DD
  return_date?: string;         // omit for one-way
  passengers?: { adults?: number; children?: number; infants?: number }; // default 1 adult
  cabin?: "economy" | "premium_economy" | "business" | "first";  // default economy
  max_stops?: 0 | 1 | 2;
  sources?: ("google_flights" | "duffel")[];  // default: all configured
  currency?: string;            // ISO 4217; default config.currency (WEBRUNNER_CURRENCY, USD)
}
```

Output:
```ts
{
  query: { /* echo of normalized input, with resolved IATA codes */ };
  offers: Array<{
    id: string;
    source: "google_flights" | "duffel";
    price: { amount: number; currency: string };
    total_duration_min: number;
    stops: number;
    slices: Array<{                       // 1 for one-way, 2 for round trip
      segments: Array<{
        airline: string;                  // IATA carrier code
        airline_name: string;
        flight_number: string;
        depart_airport: string;
        depart_at: string;                // local time, ISO 8601 with offset if known
        arrive_airport: string;
        arrive_at: string;
        duration_min: number;
        aircraft?: string;
      }>;
      layovers: Array<{ airport: string; duration_min: number }>;
    }>;
    booking_url?: string;
    fare_notes?: string[];                // e.g. "Basic economy, no carry-on"
  }>;
  sources_used: FlightSource[];
  sources_failed: Array<{ source: FlightSource; error: string }>;
  fetched_at: string;
  caveats: string[];            // e.g. "Google Flights showed 'prices may change'"
}
```

Field definitions (DECIDED, as implemented in `src/schemas/flights.ts`): `airline` is the 2-character IATA carrier code and `flight_number` is carrier code plus number with no space (`BA117`), omitted when the source does not show it (Google Flights result lists do not; Duffel always does). A round-trip search against Google Flights returns offers with one slice and `itinerary: "outbound_only"`, because the results list shows only the outbound leg while the price is the round-trip total; the tool adds a caveat saying so. Clicking into each result for the return leg or the flight number was rejected as too many requests per search. Google Flights needs the literal words `one way` in the query URL for a one-way search; omitting the return clause yields a round trip with a Google-chosen return date. `depart_at` and `arrive_at` are local times; the UTC offset is present only when the source provides it. Each slice has exactly `segments.length - 1` layovers. `query` echoes `NormalizedFlightsQuerySchema` (resolved IATA codes, fully populated passengers, resolved sources, currency always set). Passenger limits: at least 1 adult, infants no more than adults, at most 9 in total. Duffel prices children at an assumed age of 8 and infants at 1 because the contract carries counts only; an optional `child_ages` input is deferred. Duffel returns offers in the airline's currency and cannot convert, so when any offer's currency differs from `query.currency` the tool adds a caveat and sorts within currency groups rather than across them. `max_stops` unset means "provider default", which differs between sources (Duffel defaults to 1 connection); the tool says so in a caveat when sources disagree. Each provider caps at 30 offers before the tool merges and re-sorts.

Implemented behavior (WP11, verified live from a headless Chromium on 2026-10-18): Google served real results with no consent dialog and no CAPTCHA, but after a handful of searches from one IP within a few minutes it intermittently answered HTTP 429 or the "unusual traffic" page; both surface as `blocked`. Cabin and passenger counts are expressed in the query text (`in business class`, `for 2 adults and 1 child`) and read back from the page's controls, with a caveat on mismatch. The extractor fills a flat per-itinerary record; code resolves airports via `resolveIata` and airlines via a static 171-name table, splits segments at layover airports, cross-checks the model's price against the label and the dates against the query, and drops offers it cannot resolve. The "view more flights" button exists but adds no rows, so the incompleteness caveat appears on most searches. Default per-source timeouts: 90 s Google Flights, 45 s Duffel. An empty results page after a 10 s grace period is "no flights" with a caveat.

Behavior:
- Google Flights via recipe (Section 4.5). Build the search URL directly from parameters where possible, fall back to form interaction.
- Duffel via its REST API if `DUFFEL_API_KEY` is set. Offers are tagged by source and never merged into one row, since the same flight can legitimately show different prices.
- Sort by price ascending. Return at most 30 offers.

### 3.6 Error envelope

Every tool failure returns `isError: true` with:
```ts
{
  error: {
    code: "config" | "provider" | "timeout" | "blocked" | "budget_exceeded" | "invalid_input" | "internal";
    message: string;            // human-readable, no stack traces
    retryable: boolean;
    details?: unknown;
  }
}
```

---

## 4. Internal interfaces

### 4.1 `SearchProvider`

```ts
interface SearchProvider {
  readonly name: "brave" | "exa" | "tavily" | "perplexity";
  isConfigured(): boolean;
  search(q: SearchQuery, signal: AbortSignal): Promise<RawResult[]>;
}
interface SearchQuery { query: string; maxResults: number; recency?: Recency; includeDomains?: string[]; excludeDomains?: string[]; }
interface RawResult { url: string; title: string; snippet: string; publishedAt?: string; rank: number; }
```

URL canonicalization (used for dedupe and cache keys): lowercase scheme and host, strip `www.`, strip fragment, strip tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, `ref_src`, `mc_cid`, `mc_eid`, `igshid`), strip trailing slash except on the root path, remove default ports, sort remaining query params. Implemented in `canonical.ts` (WP2).

`published_at` normalization (DECIDED, implemented in `normalize.ts`): a mapper converts anything `Date.parse` accepts to ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`); a date-only or zone-less value is read as UTC; numbers are epoch seconds (values of 1e12 and above are milliseconds); strings without a 4-digit year and anything unparseable are omitted, never passed through raw.

### 4.2 `Fetcher`

```ts
interface Fetcher {
  readonly name: "firecrawl" | "jina" | "direct" | "browser";
  isConfigured(): boolean;
  fetch(url: string, opts: FetchOpts, signal: AbortSignal): Promise<FetchResult>;
}
```

`FetchResult` matches the `fetch_page` output minus `cached`. Each fetcher classifies bot walls: a wall served with HTTP 200 is returned with `botWall: true`; a wall served with a non-2xx status throws `FetchError` code `blocked`. `FetchOpts.waitFor` applies to the browser fetcher only. `max_chars` defaults live in the tool, not in `FetchOpts`. `runFastChain` returns the best available result when no fetcher produced a good one and throws only when every fetcher threw (the last error wins).

### 4.3 `BrowserSession`

```ts
interface BrowserSession {
  acquire(): Promise<Page>;        // Playwright Page from a shared persistent context
  release(page: Page): Promise<void>;
  close(): Promise<void>;
}
```

DECIDED behavior:
- Default: `chromium.launchPersistentContext(config.browser.profile_dir, {...})` with a profile directory owned by this tool. First run creates it; the owner can log into sites once and cookies persist.
- Optional: `BROWSER_CDP_URL` set means attach to the owner's running Chrome via `chromium.connectOverCDP`. Documented in README with the `--remote-debugging-port` flag.
- Headful by default when a display exists, headless otherwise. `BROWSER_HEADLESS` overrides.
- One context, pages pooled, max 3 concurrent pages.
- Every page gets a realistic viewport (1366x768), the system locale and timezone, set at context level in persistent mode. In CDP mode the owner's Chrome settings apply, so recipes must not assume a viewport. No automation-flag overrides beyond Playwright defaults. No stealth plugins. If that is not enough for a site, the recipe reports `blocked`.
- Headful detection: macOS and Windows always count as having a display; Linux requires `DISPLAY` or `WAYLAND_DISPLAY`.
- `BROWSER_CDP_URL` takes the form `http://127.0.0.1:9222`. In CDP mode `release()` closes pages this tool opened and `close()` only disconnects; the owner's Chrome keeps running.
- One `BrowserSession` is created lazily in `buildDeps` and shared through `Deps.browser`; the server's shutdown path must call `close()` so Chromium is never orphaned (WP5 wires this).
- Pages opened by clicks (popups) are not tracked by the pool; `close()` on the context still kills them.

### 4.4 `Snapshot` (for the generic browse agent)

```ts
interface Snapshot {
  url: string;
  title: string;
  axTree: string;              // compact accessibility tree with stable ref ids, like Playwright MCP's snapshot
  screenshotPath?: string;     // only when the model requests a visual or axTree is empty
}
```

The generic agent works primarily from the accessibility tree and refs, and requests a screenshot only when needed. This is cheaper and more reliable than a pure vision loop.

Implemented shape (WP4): the tree comes from Playwright's `ariaSnapshot()` parsed into nested nodes; `Snapshot` also carries `refs: Map<string, Locator>` (role-plus-name locators, `getByText` for text-only nodes) and `refInfo: Map<string, {role, name}>`. Refs are deterministic for an unchanged page but go stale after any DOM change, so the agent takes a fresh snapshot after every action and prefers interactive refs. Iframe content is not in the tree. Names are truncated to 120 characters in the text but locators use the full name. The tree is capped at 400 lines; nodes past the cap have no ref. A screenshot is taken only when requested, or when the tree is empty and a `screenshotDir` was given. `ariaSnapshot` reports password inputs as plain `textbox`, so any action layer must check the DOM for sensitive fields; refs on label text point at the `<label>` and Playwright retargets fill and click to its control.

### 4.5 `Recipe`

```ts
interface Recipe<TParams, TResult> {
  readonly site: string;                 // "google_flights"
  readonly paramsSchema: ZodSchema<TParams>;
  readonly resultSchema: ZodSchema<TResult>;
  buildUrl?(params: TParams): string | null;    // direct-URL shortcut when available
  run(page: Page, params: TParams, ctx: RecipeContext): Promise<TResult>;
}
interface RecipeContext { llm: LlmClient; log: Logger; deadline: number; }
```

DECIDED: extraction inside recipes is **schema-driven via the LLM**, not CSS-selector-driven. The recipe navigates and waits; then it hands the page's visible text or accessibility tree to the LLM with the result schema and asks for structured output. Selector-based extraction is allowed only as a fast path that is validated against the schema, with LLM extraction as fallback. This is what makes recipes survive page redesigns.

### 4.6 `LlmClient`

```ts
interface LlmClient {
  complete(req: {
    role: "planner" | "extractor" | "scorer" | "writer";
    system: string;
    messages: MessageParam[];
    schema?: ZodSchema;          // structured output when present
    effort?: "low" | "medium" | "high" | "xhigh";
    maxTokens?: number;
  }): Promise<{ text?: string; parsed?: unknown; usage: Usage; costUsd: number }>;
}
```

Model routing table (DECIDED defaults; override per role with `WEBRUNNER_MODEL_<ROLE>` env vars or `model_<role>` config-file keys, read from `config.models.<role>`):

| role      | model             | effort | notes                                   |
|-----------|-------------------|--------|-----------------------------------------|
| planner   | claude-opus-5-5   | high   | decomposes question, decides next step  |
| scorer    | claude-haiku-5-5  | low    | relevance scoring of search results     |
| extractor | claude-sonnet-5-5 | medium | page → structured notes / recipe output |
| writer    | claude-opus-5-5   | high   | final report with citations             |

Implementer notes for the Anthropic SDK (verify against the current SDK README before coding; these are the known 2026 API shapes):
- Use `@anthropic-ai/sdk`. Thinking is adaptive by default on these models; do not send `budget_tokens` and do not send `thinking: {type: "disabled"}` on Opus 5.5 or Sonnet 5.5, both return 400. Control depth with `output_config.effort`.
- Structured output: `output_config.format` with a JSON schema, or the SDK's `messages.parse()` helper with a zod schema. Do not use forced `tool_choice: any/tool` on 5.5 models, it returns 400.
- Enable server-side refusal fallbacks by default: beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`. Check `stop_reason === "refusal"` before reading content.
- Stream any call with `max_tokens` above roughly 16k and use `finalMessage()`.
- Put stable content (system prompt, tool list) first and use `cache_control` breakpoints; the research loop re-sends large contexts and caching matters for cost.
- Track `usage` on every response and compute cost from a price table in `models.ts`. Prices as of 2026-10: Opus 5.5 $4/$20 per MTok, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (doubles above 100K prompt tokens, so scorer batches stay under that).

Implemented shape (WP6, `src/core/llm/`): `Usage` is camelCase (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`); `LlmResponse` adds `model` (the serving model) and `stopReason`; `LlmRequest` adds optional `meter` and `signal`; `LlmError` carries `code` (maps onto the envelope) and `kind` (`refusal | rate_limit | api | network | not_configured | schema`). Budgets: create one `CostMeter({ maxCostUsd })` per `deep_research` or `browse_task` call and pass it as `req.meter` on every call; the client checks it before each request so overshoot is at most one call. `max_tokens` includes adaptive-thinking tokens: planner and reflect calls at `high` effort must pass `maxTokens: 16000` (the streaming threshold) rather than the 8192 default or structured JSON gets truncated. There is no tool-use path by design (forced `tool_choice` returns 400 on these models); the browse agent's one-action-per-step decision uses structured output with a discriminated union.

### 4.7 `Cache`

Content-addressed JSON files under `config.cache_dir`, key = sha256 of a canonical JSON key, with TTL stored alongside. No external dependency. Clearing is `rm -rf`.

### 4.8 Config

Loaded from env vars first, then `~/.config/webrunner/config.json`, validated with zod at startup. Startup fails loudly on invalid config. Missing optional provider keys disable that provider and log a warning to stderr.

| var                     | required | purpose                                  |
|-------------------------|----------|------------------------------------------|
| ANTHROPIC_API_KEY       | no*      | research and extraction; LLM tools return error `config` when unset |
| BRAVE_API_KEY           | one of   | search                                   |
| EXA_API_KEY             | one of   | search                                   |
| TAVILY_API_KEY          | one of   | search                                   |
| PERPLEXITY_API_KEY      | one of   | Perplexity Search API                    |
| FIRECRAWL_API_KEY       | no       | fast fetch                               |
| JINA_API_KEY            | no       | fast fetch (works unauthenticated, rate-limited) |
| DUFFEL_API_KEY          | no       | licensed flight offers                   |
| BROWSER_CDP_URL         | no       | attach to owner's Chrome                 |
| BROWSER_HEADLESS        | no       | force headless                           |
| WEBRUNNER_BROWSER_PROFILE_DIR | no | persistent Chromium profile; default ~/.config/webrunner/browser-profile |
| WEBRUNNER_SAVE_SCREENSHOTS | no    | browse_task saves screenshots under the run dir; default false |
| WEBRUNNER_CURRENCY      | no       | ISO 4217 default for search_flights; default USD |
| WEBRUNNER_MODEL_PLANNER | no       | override planner model; default claude-opus-5-5 |
| WEBRUNNER_MODEL_SCORER  | no       | override scorer model; default claude-haiku-5-5 |
| WEBRUNNER_MODEL_EXTRACTOR | no     | override extractor model; default claude-sonnet-5-5 |
| WEBRUNNER_MODEL_WRITER  | no       | override writer model; default claude-opus-5-5 |
| WEBRUNNER_RESEARCH_MAX_MS | no     | wall-clock cap per deep_research call; default 900000 |
| WEBRUNNER_DAILY_COST_CAP_USD | no  | soft cap on LLM spend per UTC day across processes; default unset (off) |
| RESEARCH_MAX_COST_USD   | no       | default 3.00 per deep_research call      |
| WEBRUNNER_CACHE_DIR  | no       | default ~/.cache/webrunner            |
| WEBRUNNER_LOG_LEVEL  | no       | default info                             |

\* Optional at startup by decision (Section 1). Config-file keys are the lowercase variable names with the `WEBRUNNER_` prefix dropped (`brave_api_key`, `cache_dir`, `currency`, `model_planner`, `browser_profile_dir`, `save_screenshots`, ...); unknown keys are rejected; the environment overrides the file; empty env vars count as unset. All keys above already exist in `src/config.ts`; work packages read them from `deps.config` and do not edit `config.ts` unless their brief says so.

---

## 5. Deep research engine design

Loop, per iteration until budget or convergence:

1. **Plan** (planner): given the question, notes so far, and gaps, produce 2 to 6 sub-queries with a one-line rationale each, and a stop decision. Structured output.
2. **Search**: run sub-queries through `core/search` in parallel. Collect candidate URLs, dedupe against already-read URLs.
3. **Score** (scorer): batch-score candidates for relevance and source quality on a 0-10 scale with a one-line reason. Drop under 5. Prefer primary sources, official docs, and recent dates when `recency` is set.
4. **Read**: fetch top candidates in parallel up to the per-iteration read budget. For each page, the extractor produces structured notes: `{claims: [{text, quote, confidence}], relevance, published_at}`. Notes are kept; raw pages are not passed to the writer.
5. **Reflect** (planner): update the gap list. Stop if gaps are empty, the iteration budget is spent, or the last iteration added fewer than 2 new claims.
6. **Write** (writer): report from notes only, every claim cited with `[n]`, gaps section mandatory, no claims without a source. For `brief` output, cap at ~300 words.

Guardrails:
- Hard stop at `max_cost_usd`; return what exists with `gaps` explaining the cutoff.
- A page fetch that fails is logged and skipped. Never retried more than once.
- Source list ids are stable across the report; the writer receives notes keyed by id.
- Prompts live in `prompts.ts` with a `PROMPT_VERSION` string logged at run start.

Implemented behavior (WP7): the reflect call also returns the next round's sub-queries, so rounds 2 and up have no separate plan call; a reflect call is skipped when a hard limit already ends the loop. Stop precedence after an iteration: budget, searches, reads, iterations, fewer than 2 new claims (reported as `converged`), then the planner's own stop. Failed fetches do not consume the read budget; the next candidate replaces them within the iteration up to twice the per-iteration cap. If every search in an iteration fails before any note exists the engine throws (`provider`, or `timeout` when all timed out); with notes it stops with `stopped_reason: "searches"` and a gap line. The loop keeps an estimated writer cost in reserve so the writer can still run when the budget is nearly spent; if the writer is refused anyway the report is a deterministic claims list with citations. Dangling `[n]` citations are removed and noted in Gaps; a missing `## Gaps` section is added. `stats.input_tokens` includes cache reads and writes. `sources[].accessed_at` comes from the fetch result's `fetched_at`, which can be a cached time up to 24 h old.

---

## 6. Work breakdown

Each WP is one implementer session. "Parallel with" lists WPs that can run at the same time with no file conflicts. Acceptance criteria are checked by the orchestrator before merge.

### Phase 0: Scaffold

**WP0: Project scaffold and MCP skeleton**
- Depends on: none.
- Deliver: `package.json` (ESM, Node 22), `tsconfig.json` strict, eslint with a rule forbidding `console.log`, vitest, `src/index.ts` starting an `McpServer` over `StdioServerTransport` with one `ping` tool, `src/config.ts` with zod validation, `src/log.ts` writing JSON lines to stderr, GitHub Actions running lint + typecheck + unit tests, `README.md` stub.
- Accept: `npm run build && npm test` pass in CI. `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js` returns a response that includes `ping`. Nothing is written to stdout except protocol frames (test asserts this).

### Phase 1: Search and fetch

**WP1: Search providers** (parallel with WP3, WP4)
- Depends on: WP0.
- Deliver: `SearchProvider` interface and four implementations. Each has a recorded fixture under `test/fixtures/search/<provider>.json` and a unit test that maps the fixture to `RawResult[]`. Integration tests behind `RUN_INTEGRATION=1`.
- Accept: each provider's unit test passes offline. `isConfigured()` reflects env. Timeouts honor `AbortSignal`. Malformed provider responses produce a typed `ProviderError`, never an unhandled rejection.

**WP2: Fusion and `web_search` tool** (after WP1)
- Depends on: WP0, WP1.
- Deliver: URL canonicalization with a table-driven unit test (at least 15 cases), reciprocal rank fusion, the `web_search` tool, cache integration.
- Accept: fixture-based test with 3 providers returning overlapping results yields deduped, fused output with `providers` arrays populated. One provider throwing produces `providers_failed` and still returns results. Cache hit on second identical call.

**WP3: Fast fetch path** (parallel with WP1, WP4)
- Depends on: WP0.
- Deliver: `Fetcher` interface; `firecrawl`, `jina`, `direct` fetchers; direct uses `@mozilla/readability` + `turndown`. Bot-wall classifier with fixture tests (Cloudflare challenge HTML, "Please enable JavaScript", 403 pages). `max_chars` truncation flagged.
- Accept: fixture HTML files convert to Markdown with headings and links preserved. Bot-wall fixtures classify correctly. Direct fetch follows redirects and reports `final_url`.

**WP4: Browser engine and browser fetch** (parallel with WP1, WP3)
- Depends on: WP0.
- Deliver: `BrowserSession` with persistent profile and optional CDP attach; page pool; `browser` fetcher that waits for load, extracts main content via Readability on the live DOM, converts to Markdown. `Snapshot` module producing a compact accessibility tree with refs.
- Accept: integration test (gated) fetches a known JS-rendered page and returns body text over 500 chars. Unit test for snapshot formatting on a saved DOM. Session reuses the profile directory across two launches (cookie persists).

**WP5: `fetch_page` tool with auto mode** (after WP2, WP3, WP4)
- Depends on: WP2 (cache), WP3, WP4.
- Deliver: `core/fetch/index.ts` implementing the auto fallback rules in 3.2; the tool; cache (24 h for fast results keyed on `final_url`, 1 h for browser results); `Deps.fetch` and `Deps.browser` (lazy `BrowserSession`) with `close()` wired into the server shutdown path; drop the `X-Return-Format: markdown` header from the Jina fetcher (live calls showed it returns full page chrome; the default output is cleaner) with a fixture update.
- Accept: with a fixture fast fetcher returning a bot wall, auto mode calls the browser fetcher. Mode `fast` never touches the browser (asserted via spy).

### Phase 2: Deep research

**WP6: LLM client** (parallel with Phase 1 WPs after WP0)
- Depends on: WP0.
- Deliver: `LlmClient` over `@anthropic-ai/sdk`, routing table, structured output via zod, effort, streaming for large outputs, refusal fallback beta, usage and cost accounting, prompt-cache breakpoints for stable prefixes. Mockable via an injected transport for tests.
- Accept: unit tests with a mocked SDK verify request shape (no `budget_tokens`, no forced `tool_choice`, `output_config.effort` present, fallback beta header present). Cost computation matches the price table. A `refusal` stop reason surfaces as a typed error.

**WP7: Research engine** (after WP2, WP5, WP6)
- Depends on: WP2, WP5, WP6.
- Deliver: `src/schemas/deep_research.ts`; `engine.ts` implementing Section 5 end to end including the writer, via `runResearch(input, deps)`; `prompts.ts`; `report.ts` with citation renumbering and invariant checks; budget enforcement through a per-run `CostMeter`; notes data model. The engine returns a complete `DeepResearchResult`.
- Accept: a fully mocked run (fixture search results, fixture pages, scripted LLM responses) completes in under 2 s, produces the right number of iterations for each depth, stops on convergence, and stops on budget. Every claim in mocked output has at least one source id.

**WP8: `deep_research` tool** (after WP7)
- Depends on: WP7.
- Deliver: `src/tools/deep_research.ts` wired through `Deps`; switch `test/evals/research/schema.ts` and `cli.ts` to import the result schema and `runResearch` from `src/`; an end-to-end stdio test that calls `deep_research` against mocked services and checks the envelope for the no-key case; progress logging to stderr per iteration.
- Accept: snapshot test of report Markdown from fixed notes. Report has no `[n]` that is missing from `sources`. `gaps` is always present.

**WP9: Research eval set** (parallel with WP7, WP8)
- Depends on: WP0.
- Deliver: `test/evals/research/questions.json` with 20 questions across types (recent event, technical comparison, numeric fact, multi-hop), each with a rubric of 3 to 6 checkable criteria; `run.ts` that runs `deep_research` at a chosen depth and grades with Haiku 5.5 as judge, outputting a table and total cost. Gated behind `RUN_EVALS=1`.
- Accept: runner executes against the mocked engine in CI. Owner runs it live once per prompt change.

### Phase 3: Live browsing

**WP10: Generic browse agent and `browse_task`** (after WP4, WP6)
- Depends on: WP4, WP6.
- Deliver: step loop: snapshot → model decides one action (`click ref`, `type ref text`, `navigate url`, `scroll`, `extract`, `done`, `blocked`) → execute → repeat. Deny-list for purchase actions. `extract_schema` support via extractor role. CAPTCHA and login detection. Optional screenshots to run dir.
- Accept: unit test with a scripted model drives a saved local HTML fixture (a simple form plus results table) to `completed` with correct extraction. Clicking a `Buy` button in the fixture is refused and logged. `max_steps` produces `partial`.

**WP11: Recipe framework and Google Flights recipe** (after WP4, WP6; parallel with WP10)
- Depends on: WP4, WP6.
- Deliver: `Recipe` interface, registry, `google-flights.ts` with `buildUrl` for one-way and round-trip, wait strategy, "show more flights" expansion, LLM extraction to the `search_flights` offer schema, city-to-IATA resolution via the existing `resolveIata` (WP12) plus an LLM fallback through the `extractor` role when it returns `undefined`, currency caveats per 3.5. `search_flights` tool merging Duffel (`buildAllFlightProviders` in WP12 lists unconfigured providers for `sources_failed`) and the Google Flights recipe.
- Accept: fixture test: saved Google Flights results DOM text → extractor → offers that validate against the schema with prices, times, airlines and stops populated. Integration test (gated) runs a real search for a route 30 days out and returns at least 5 offers. Blocked page returns `blocked` error, not garbage.

**WP12: Duffel provider for `search_flights`** (parallel with WP11, after WP0)
- Depends on: WP0.
- Deliver: Duffel offer request → offers mapped to the shared schema, tagged `source: "duffel"`. Sandbox-key integration test.
- Accept: fixture mapping test. `sources_failed` populated when key missing and `sources` explicitly requests duffel.

### Phase 4: Integration and hardening

**WP13: Client configuration and README** (after WP2, WP5, WP8, WP11)
- Deliver: `scripts/install-claude-code.sh` (adds the server to Claude Code via `claude mcp add` with env passthrough), `scripts/install-codex.sh` (writes the `[mcp_servers.webrunner]` block to `~/.codex/config.toml`), README covering keys, browser profile setup, CDP attach, ToS note, cost expectations, troubleshooting.
- Accept: both scripts are idempotent. A fresh Claude Code session lists all five tools. A fresh Codex session lists all five tools.

**WP14: Hardening** (split into two parallel packages after WP8; both independent of WP13)
- WP14a: `health` tool, `tsconfig.test.json` so typecheck covers tests, a CI job running the browser tests with Chromium installed plus a weekly live-integration workflow driven by repository secrets, the written MCP SDK v2 evaluation, and an error-envelope audit test over every tool.
- WP14b: shared retry-with-jitter helper (max 2, `Retry-After` honored) applied to search, fast fetch and Duffel; per-provider concurrency limiters; wall-clock caps per tool (`web_search` 30 s, `fetch_page` 90 s, `search_flights` 120 s, `deep_research` 15 min via `WEBRUNNER_RESEARCH_MAX_MS`, cancellation threaded through the engine); PDF text extraction in the direct fetcher (`pdf-parse`, 25 MB cap); a SIGTERM shutdown test proving no orphaned Chromium; an optional process-wide daily LLM spend cap `WEBRUNNER_DAILY_COST_CAP_USD`.
- Original deliverable list follows.
- Deliver: global per-call timeouts, concurrency limits per provider, retry with jitter on 429/5xx (max 2), cost cap enforcement across all tools, graceful browser shutdown on SIGTERM, structured error envelope everywhere, a `health` tool reporting configured providers and browser status, a `tsconfig.test.json` so `npm run typecheck` covers `test/`, PDF text extraction in `fetch_page` (`pdf-parse` or equivalent; the fast path currently returns `invalid_input` for PDFs), a CI job that runs the browser tests with Chromium installed, and a written evaluation of migrating to MCP SDK v2 (`@modelcontextprotocol/server`).
- Accept: fault-injection tests for each failure mode return the correct `error.code`. Killing the server mid-browse leaves no orphan Chromium.

### Dependency graph

```
WP0 ─┬─ WP1 ── WP2 ─────────────┐
     ├─ WP3 ─┐                  ├─ WP7 ── WP8 ─┐
     ├─ WP4 ─┴─ WP5 ────────────┘              ├─ WP13 ── WP14
     ├─ WP6 ──┬─ WP10 ─────────────────────────┤
     │        └─ WP11 ─────────────────────────┘
     ├─ WP9 (joins WP8 for live runs)
     └─ WP12 (joins WP11)
```

Maximum parallelism after WP0: WP1, WP3, WP4, WP6, WP9, WP12 at once.

---

## 7. Orchestration protocol

### Roles

- **Orchestrator (Fable 5.1)**: owns this plan, briefs implementers, reviews diffs, runs acceptance checks, merges. Does not implement WPs itself except for contract edits to this file and for fixing merge conflicts.
- **Implementer (Sonnet 5.5)**: one WP per session, on a branch named `wp<N>-<slug>`, opens a PR against `main`.

### Briefing template

Each implementer brief contains exactly:

1. The WP section copied verbatim from Section 6.
2. The relevant contract sections from 3 and 4 copied verbatim, not summarized.
3. The list of files the WP may create or modify. Anything else is out of scope; if the implementer believes another file must change, it stops and reports instead of changing it.
4. The commands that must pass: `npm run lint && npm run typecheck && npm test`.
5. The instruction: "Do not change exported interfaces in `core/*/types.ts` or `schemas/*`. If the contract is wrong, report why and stop."
6. The instruction: "Record real provider responses as fixtures only with secrets redacted. Never commit keys."

### Definition of done for a WP

- All acceptance criteria in Section 6 demonstrably met, with the commands and their output in the PR description.
- No stdout writes outside the MCP transport (CI test).
- New external dependencies justified in one line each in the PR.
- Unit tests run offline. Integration tests are gated by env.

### Orchestrator review checklist

- Diff touches only the allowed files.
- Contracts unchanged, or changed in a prior PR to this file.
- Run the acceptance commands locally, do not trust the PR text alone.
- Spot-check one fixture against the live service when a key is available.
- Reject silent truncation, swallowed errors, `any` types at interface boundaries, and retries without a cap.

### Merge order

Follow the dependency graph. Rebase, do not merge-commit, so the history is linear and bisectable.

---

## 8. Testing strategy

| layer        | runs in CI | needs keys | purpose                                            |
|--------------|-----------|------------|----------------------------------------------------|
| unit         | yes       | no         | mappers, fusion, canonicalization, prompts, engine with mocks |
| integration  | no        | yes        | each provider, browser fetch, Google Flights recipe |
| evals        | no        | yes        | research quality, 20 questions, cost per depth      |
| smoke        | yes       | no         | server starts, `tools/list`, `ping`, stdout purity  |

Fixtures are recorded once per provider and refreshed only when a mapping breaks. Recording script redacts keys and PII.

---

## 9. Risks and mitigations

| risk | likelihood | mitigation |
|------|-----------|------------|
| Google Flights layout change breaks the recipe | certain, a few times a year | LLM schema extraction over selectors; `buildUrl` shortcut; integration test in a weekly scheduled CI run with the owner's key |
| Google rate-limits repeated searches from one IP | observed live | one navigation retry at most, `blocked` surfaced honestly, Duffel as the licensed alternative |
| Bot walls on fetch | common on news and retail sites | persistent profile, browser fallback, report `blocked` honestly |
| Research cost creep | medium | per-call `max_cost_usd`, depth budgets, prompt caching, Haiku for scoring |
| Provider API drift | medium | thin mappers, fixtures, `providers_failed` instead of total failure |
| Anthropic SDK shape drift | medium | WP6 isolates all SDK usage; mocked request-shape tests catch regressions |
| Codex MCP config differences | low | WP13 tests both clients explicitly |
| Owner's browser profile holds real sessions | inherent | profile dir is tool-owned by default; CDP attach is opt-in and documented |

---

## 10. Cost expectations (owner-facing, approximate)

| operation | typical cost |
|-----------|-------------|
| `web_search` | under $0.02 across 3 providers |
| `fetch_page` fast | $0 to $0.01 |
| `deep_research` quick | $0.10 to $0.30 |
| `deep_research` standard | $0.50 to $1.50 |
| `deep_research` deep | $1.50 to $4.00 |
| `search_flights` via Google Flights | $0.02 to $0.08 (one extraction call) |
| `browse_task` 15 steps | $0.20 to $0.60 |

Figures assume the model routing table in 4.6 and 2026-10 pricing. The `stats.cost_usd` field reports actuals.

---

## 11. Open decisions for the owner

- **OPEN**: Which search providers to buy keys for initially. Recommendation: Brave plus Exa to start; add Tavily or Perplexity Search after seeing failures.
- **OPEN**: Firecrawl subscription or Jina-only for the fast path. Recommendation: start Jina-only, add Firecrawl if PDF and complex-page quality matters.
- **OPEN**: Duffel account. Not required for v1. Recommendation: defer until the Google Flights recipe has been in use for a few weeks.
- **OPEN**: Headful or headless default when running on a desktop. Recommendation: headful, so the owner can log into sites and watch the agent when debugging.

---

## 12. Milestones

1. **M1, usable search**: WP0 to WP5 merged. Claude Code can search and read pages through the server.
2. **M2, research**: WP6 to WP9 merged. `deep_research` passes the eval set at `standard` depth with a score the owner is happy with, and beats a Perplexity Deep Research answer on at least 15 of the 20 questions in a side-by-side the owner judges.
3. **M3, live data**: WP10 to WP12 merged. `search_flights` returns real fares for three routes the owner picks.
4. **M4, done**: WP13 and WP14 merged. Both clients configured by script. README complete.

Status on 2026-10-18: all fourteen work packages are merged (WP14 as WP14a and WP14b). M1, M3 and M4 are met as far as can be verified without API keys: a fresh clone passes lint, typecheck over `src/` and `test/`, and 1380 tests; all seven tools list over stdio; CI including the Chromium job is green; Google Flights returned 27 live offers for LHR to JFK from the development environment. M2's quality bar and the live halves of M3 and M4 (a Google Flights run with the real extractor, Codex against a live session, the eval set at standard depth, the Perplexity side-by-side) need the owner's keys and are the first things to do after install.

Status on 2026-10-21 (v0.2.0): phase 5 is merged on the `v02-all-rounder` branch: WP15 (contracts, config keys, caps), WP16 (`accounts`, browser cookies), WP17 (`search_hotels`), WP18a (`social_search` with Reddit, Hacker News, Bluesky and YouTube), WP19a (`search_reviews` with the App Store and Trustpilot), WP20 (`market_quote`, `weather`, `exchange_rate`), WP18b (X, Facebook and the Reddit browser fallback, registered in the social platform list) and WP21 (this integration: `health` reports every source and the connected accounts by name, both installers forward the five new variables, README with one section per tool and an Accounts section, `live.yml` covers the new suites, every README example parses against its input schema). WP19b (Google Maps, Google Play and Amazon reviews) merged after WP21 and is registered in `buildAllReviewSources`; with it the branch has 105 test files and 2137 tests; `health` reports whatever the builders return (checked against the merged branch: `x` and `facebook` appear as browser platforms when a browser exists). A fresh clone passes lint, typecheck over `src/` and `test/`, and 2137 tests (one pre-existing skip); all fourteen tools list over stdio. Verified live from the development environment (cloud IP, headless Chromium, 2026-10-18): Google Hotels (18 cards per page read deterministically, dates through the natural-language URL form, no guest ratings on organic cards), Google Finance (`AAPL:NASDAQ`, `VOD:LON`), Hacker News, CoinGecko, Frankfurter, Open-Meteo geocoding, the App Store search, lookup and review feed, and Trustpilot's WAF challenge. Built from documentation only, because the environment refused or lacked keys: Reddit (403, no credentials), Bluesky (connection reset), YouTube (no key), Yahoo Finance (429), Finnhub (no key), the Open-Meteo forecast endpoint (timeout), Trustpilot's page parsers, the `accounts` login URLs, and every browser platform that needs a logged-in account (X answered 403 to headless Chromium even on its login page, Facebook 404 to anonymous search, old.reddit a login redirect then a network-security block; the recipes are fixture-tested and a gated logged-out run yields the expected `blocked`/`needs_login`/`config` errors). The owner's first run from a home IP with connected accounts is the real test of those.

---

## 13. Decision log

- **2026-10-21, after WP21, v0.2 integration**: phase 5 closed out on `v02-all-rounder`; see 14.10 for the implementation decisions the phase 5 PRs reported (the MCP SDK `outputSchema` constraint behind the `accounts` wrapper, the Google Hotels URL form and missing organic ratings, the Google Finance markup, CoinGecko `/ohlc`, the Trustpilot WAF fallback and its 15 s budget, SDK-level `invalid_input`) and the follow-ups left for the owner's first live run.

- **2026-10-18, after WP14a/WP14b, close-out**: hardening merged. Retries with jitter and `Retry-After` on search, fast fetch and Duffel; per-provider concurrency limits; wall-clock caps per tool; PDF extraction; a SIGTERM test proving no orphaned Chromium (the shutdown path now bounds browser close at 6 s and exits 1 on a forced exit); an optional daily LLM spend cap shared across processes; the `health` tool; typecheck over tests; a Chromium CI job and a weekly live canary; the MCP SDK v2 evaluation (stay on 1.32.x for the first release, migrate in one change before v1 support ends). `search_flights` keeps both the wall-clock guard and a catch-all so no error leaves a handler unwrapped. Follow-ups not done: a clearer error when two server processes share one browser profile directory; `child_ages` for flights; recording live provider fixtures once keys exist.
- **2026-10-18, after WP13**: README, CLAUDE.md and install scripts merged; Claude Code registration verified against the real CLI, Codex block written per the Codex docs but not run against a live Codex. Plan corrected to match code: config-file keys drop the `WEBRUNNER_` prefix; `browse_task` takes `max_cost_usd` (default 1.00). Two clients sharing one profile directory cannot both launch Chromium; a clearer error is a follow-up.
- **2026-10-18, after WP8**: all six tools are on main. WP14 split into WP14a (quality gates) and WP14b (resilience) and started in parallel with WP13, since the three touch disjoint files. Two config keys are added by WP14b: `WEBRUNNER_RESEARCH_MAX_MS` and `WEBRUNNER_DAILY_COST_CAP_USD`.
- **2026-10-18, after WP11**: recorded the live Google Flights findings (rate limiting, query-text cabin and passenger clauses, code-side resolution and cross-checks) in 3.5 and the risk table. WP13 started in parallel with WP8 since the README only needs the 3.3 contract for `deep_research`.
- **2026-10-18, after WP7/WP10**: recorded the browse agent's implemented semantics (3.4, 4.4) and the research engine's stop precedence, writer reserve and search-failure handling (section 5). WP8 adds `error` to `stopped_reason` and `invalid_input` to `ResearchError`, switches the evals to the shared schema, and makes the judge print `published_at` and `quote`.
- **2026-10-18, after WP5**: thin-page and browser-fallback rules in 3.2 made explicit; the bot-wall-plus-browser-failure case returns `blocked` (fixed during review). WP7 now owns the writer and citation renumbering; WP8 is the tool, the eval import switch and the stdio end-to-end test.
- **2026-10-18, WP11 blocker**: `flight_number` made optional and `itinerary: "outbound_only"` added to offers, `blocked` added to `FlightProviderErrorCode`, after the WP11 implementer verified live that Google Flights result lists show neither flight numbers nor the return leg.
- **2026-10-18, after WP2/WP9/WP12**: `Deps` now carries `llm` and `browser` with `closeDeps` on shutdown, so WP5, WP10 and WP11 consume rather than create them. 3.3 gained `published_at` on sources, `quote` on findings, `depth`, `stats.pages_failed`, `stats.stopped_reason`, the citation invariants and the engine entry point, all from the WP9 judge's needs. 3.5 gained field definitions, passenger limits and the currency and `max_stops` caveats from WP12. Canonicalization list unified between 3.1 and 4.1. SDK-level input validation accepted in place of `invalid_input` envelopes for malformed input.
- **2026-10-18, after WP1/WP3/WP4/WP6**: recorded the implemented shapes for search normalization, bot-wall semantics (returned vs thrown), the browser session and snapshot contracts, and the LLM client (`Usage`, `LlmError`, per-run `CostMeter`, `maxTokens: 16000` for planner calls). WP5 now depends on WP2 for the cache and owns wiring the shared `BrowserSession` into `Deps` and shutdown. Jina's `X-Return-Format` header is dropped in WP5. PDF extraction and a Chromium CI job were added to WP14. Playwright is pinned to 1.56.1 to match the Chromium build shipped with the dev environment; the README (WP13) must say to run `npx playwright install chromium` elsewhere. `vitest.config.ts` includes `test/integration/**` only when `RUN_INTEGRATION=1`.
- **2026-10-18, after WP0**: added `src/deps.ts`, `src/schemas/result.ts`, `src/tools/index.ts` and the tool wiring convention; moved `ping` to `src/tools/ping.ts`. Added config keys for browser profile dir, screenshots, currency and per-role model overrides so WP4, WP6, WP10 and WP11 do not each edit `config.ts`. Pinned MCP SDK to the 1.32.x line for v1. Made `ANTHROPIC_API_KEY` optional at startup. Fixed `published_at` normalization. All raised by the WP0 implementer's report.

---

## 14. Phase 5: the all-rounder expansion (v0.2)

> Added 2026-10-18 after the v0.1 close-out, at the owner's request: "expand not just search flights but hotels, stocks and more; search comments or reviews specifically; search Reddit and other social media; connect my own accounts (Facebook, Google, ...) so the AI can browse these platforms through my account for a 'what are people saying' social search."
>
> Sections 14.1 to 14.7 are tool contracts and carry the same authority as Section 3. Section 14.8 extends the internal interfaces of Section 4. Section 14.9 is the work breakdown (WP15 to WP21). Everything marked DECIDED is settled.

### 14.0 Scope and principles

Seven new tools, in three groups:

| group | tools | data path |
|-------|-------|-----------|
| live data recipes | `search_hotels`, `market_quote`, `weather`, `exchange_rate` | public APIs where a keyless or free-key one exists, the browser otherwise |
| opinion search | `social_search`, `search_reviews` | public APIs first (Hacker News, Bluesky, Reddit API, YouTube Data API, App Store feed), the browser through the owner's own logged-in profile for platforms with no usable API (X, Facebook, Google Maps, Google Play, Amazon, Reddit when its API blocks) |
| account plumbing | `accounts` | the persistent browser profile's cookies, or the owner's Chrome over CDP |

Principles (DECIDED):

- **Same architecture as flights.** Each live-data tool is a thin tool file over a provider list built from `Config` plus the shared `BrowserSession`, `LlmClient` and `FetchService` in `Deps`. Browser-based sources are `Recipe`s (4.5): navigate, wait, probe the DOM for a deterministic fast path, fall back to schema-driven LLM extraction. Every provider failure is a typed error whose `code` maps onto the envelope (3.6).
- **Logged-in browsing is passive.** Social and review recipes use whatever session the persistent profile (or the owner's Chrome) already has. They never type credentials, never log in, never post, like, follow, reply or message. The `browse_task` agent's rules (3.4) are unchanged. When a recipe lands on a login wall it fails with `needs_login: true` and names the `accounts` tool.
- **Cookie values never leave the server.** `accounts` reports platform names and a boolean; `health` reports connected platform names; nothing logs or returns a cookie value. The profile directory is the owner's secret, like a key.
- **Terms of service.** Automated reading of X, Facebook, Google Maps, Google Play, Amazon and Reddit's site (as opposed to its API) is against those platforms' terms and, when done through the owner's account, can get that account rate-limited or suspended. The owner has accepted this for personal, low-volume use from their own machine, as for Google Flights. The README says so per platform. No stealth, no CAPTCHA solving: a CAPTCHA or checkpoint is reported as `blocked`.
- **Keyless first, keys optional.** Every tool does something useful with no key at all; keys widen coverage. New keys: `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (Reddit API, app-only auth), `REDDIT_USER_AGENT` (optional), `YOUTUBE_API_KEY` (YouTube Data API v3), `FINNHUB_API_KEY` (stock quotes).
- **Verification honesty.** From the development environment (a cloud IP behind a proxy), Hacker News, Open-Meteo geocoding, Frankfurter, CoinGecko, the App Store review feed, Google Hotels, Google Finance, Google Maps and YouTube pages answered; Yahoo Finance returned 429, Reddit's JSON endpoints 403, Bluesky's public API 403, Trustpilot an AWS WAF challenge, Open-Meteo's forecast host timed out, Stooq reset the connection. Implementers verify live what the environment allows, record what they saw in the PR, and build fixtures from documentation for the rest, with the field mapping marked "from docs" in the fixture file. The owner's first live run from a home IP is the real test for those.

### 14.1 `search_hotels`

Purpose: nightly rates and ratings for a destination and dates, from Google Hotels read through the browser.

Input:
```ts
{
  destination: string;            // city, area, landmark or hotel name, free text, 1..120 chars
  check_in: string;               // YYYY-MM-DD, real date
  check_out: string;              // YYYY-MM-DD, after check_in, at most 30 nights
  guests?: { adults?: number; children?: number };   // default 2 adults; adults 1..8, children 0..6
  max_price_per_night?: number;   // in `currency`, > 0
  min_rating?: number;            // guest rating floor, 0..5
  star_classes?: (2 | 3 | 4 | 5)[];
  sort?: "relevance" | "price" | "rating";   // default relevance (the page's own order)
  sources?: ("google_hotels")[];  // default: all configured
  currency?: string;              // ISO 4217; default config.currency
  max_results?: number;           // default 20, max 40
}
```

Output:
```ts
{
  query: NormalizedHotelsQuery;   // echo: destination, check_in, check_out, nights, guests, filters, sort, currency, sources, max_results
  hotels: Array<{
    id: string;                   // "<source>:<12 hex of a stable hash of name + price text>"
    source: "google_hotels";
    name: string;
    price_per_night?: { amount: number; currency: string };   // absent when the row shows no price (sold out, "View prices")
    total_price?: { amount: number; currency: string };       // only when the page shows a stay total
    rating?: number;              // guest rating 0..5, one decimal
    review_count?: number;
    star_class?: number;          // hotel class 1..5 when printed ("4-star hotel")
    type?: string;                // "hotel", "apartment", "hostel", "resort", ... as printed, lower-case
    location_note?: string;       // "0.3 mi from Louvre", neighbourhood, as printed
    amenities: string[];          // as printed, deduplicated, at most 12
    tags: string[];               // "Great deal", "Free cancellation", "Breakfast included", ... as printed
    url?: string;                 // the hotel's Google Hotels page when the row links to one
    availability: "available" | "sold_out" | "unknown";
  }>;
  sources_used: HotelSource[];
  sources_failed: Array<{ source: HotelSource; error: string }>;
  fetched_at: string;
  caveats: string[];
}
```

Behaviour (DECIDED):
- Recipe `google_hotels` in `src/core/browser/recipes/google-hotels.ts`, provider in `src/core/hotels/providers/google-hotels.ts`, built by `buildAllHotelProviders(config, { browser, llm })` in `src/core/hotels/providers/index.ts`, mirroring flights. Needs the browser; extraction needs `ANTHROPIC_API_KEY` only for the LLM fallback: when the deterministic DOM probe yields rows that validate, no model call is made and the tool works keyless.
- `buildUrl`: candidate forms to verify live, in order: `https://www.google.com/travel/search?q=hotels%20in%20<destination>&hl=en&curr=<CUR>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=N&children=M` and the natural-language `q=hotels in <destination> from <check_in> to <check_out> for 2 adults` form that flights uses. The implementer records which form sets the dates and guests in the page controls, reads those controls back and adds a caveat on mismatch, as the flights recipe does.
- Consent dialog, CAPTCHA and "unusual traffic" handling reuse the flights recipe's patterns (REJECT/ACCEPT names, `detectBotWall`); a wall is `blocked`.
- Filters: `max_price_per_night`, `min_rating` and `star_classes` are applied in code after extraction; when the page offers the same filter in its URL, the recipe may also pass it, but the code-side filter is what guarantees the contract. `sort` is applied in code: `price` ascending (rows without a price last), `rating` descending (unrated last), `relevance` keeps page order.
- Nights are `check_out - check_in`. When the page shows per-night prices only, `total_price` is omitted and a caveat says the total is nights times the nightly rate before taxes.
- The recipe scrolls or clicks "more results" at most twice; the incompleteness caveat says when more rows existed.
- Cache: none (prices move). Per-source timeout 90 s; tool wall clock 120 s.
- Prices are quotes at fetch time, taxes and fees vary by site; the last caveat always says so. The tool reads only; it never opens a booking site.

### 14.2 `market_quote`

Purpose: current prices (and optionally price history) for stocks, ETFs, indices and crypto assets.

Input:
```ts
{
  symbols: string[];              // 1..10 entries; a ticker ("AAPL", "VOD.L", "^GSPC", "BTC-USD") or a name ("Apple", "bitcoin")
  history?: {
    range: "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "5y" | "max";
    interval?: "1m" | "5m" | "15m" | "1h" | "1d" | "1wk" | "1mo";   // default: the coarsest sensible one for the range
  };
  sources?: ("yahoo" | "finnhub" | "coingecko" | "google_finance")[];   // default: every configured source
  currency?: string;              // quote currency for crypto (CoinGecko); default config.currency. Stocks are quoted in their listing currency.
}
```

Output:
```ts
{
  quotes: Array<{
    requested: string;            // the input string this quote answers
    symbol: string;               // the ticker as the source names it
    name?: string;
    asset_type: "stock" | "etf" | "index" | "crypto" | "fund" | "other";
    exchange?: string;
    currency: string;
    price: number;
    previous_close?: number;
    change?: number;
    change_pct?: number;
    open?: number; day_high?: number; day_low?: number;
    volume?: number;
    market_cap?: number;
    week52_high?: number; week52_low?: number;
    market_state?: "pre" | "regular" | "post" | "closed";
    as_of: string;                // ISO 8601 UTC of the quote's own timestamp
    delayed_min?: number;         // 0 for real time, 15 typical for free equity data; omitted when the source does not say
    source: MarketSource;
    history?: {
      range: HistoryRange; interval: HistoryInterval;
      bars: Array<{ t: string; o: number; h: number; l: number; c: number; v?: number }>;   // t ISO UTC, ascending, at most 1000 bars
    };
  }>;
  unresolved: Array<{ requested: string; error: string }>;   // inputs no source could resolve or quote
  sources_used: MarketSource[];
  sources_failed: Array<{ source: MarketSource; error: string }>;
  fetched_at: string;
  caveats: string[];
}
```

Behaviour (DECIDED):
- Sources and what each does: `yahoo` (keyless; quote, history, name lookup via the search endpoint; chart endpoint `query1.finance.yahoo.com/v8/finance/chart/<symbol>` with `range`/`interval`), `finnhub` (needs `FINNHUB_API_KEY`; `/quote` and `/search`; no history on the free tier), `coingecko` (keyless; crypto price, 24 h change, market cap via `/simple/price`, history via `/coins/<id>/market_chart`; coin lookup via `/search`), `google_finance` (browser recipe over `https://www.google.com/finance/quote/<SYMBOL>:<EXCHANGE>?hl=en`; quote only; the keyless fallback when Yahoo rate-limits).
- Routing per input, first configured source wins: names and tickers that look like crypto (`BTC`, `BTC-USD`, `bitcoin`, a CoinGecko search hit) go to `coingecko` then `yahoo`; everything else goes `yahoo`, then `finnhub`, then `google_finance`. A source that fails for one symbol with a retryable error lets the next source try; `sources_failed` lists each source that failed at least once. An input nobody could quote lands in `unresolved` with the last error, and the tool still succeeds when at least one quote exists. When no quote exists at all the tool returns the most specific shared error code, as `search_flights` does.
- Name lookup: when the input is not a plausible ticker (letters, digits, `.`, `-`, `^`, `=`, at most 12 characters, no spaces), the source's lookup runs first and the best match is quoted; a lookup with several plausible matches quotes the first and adds a caveat naming the others (at most 3).
- Cache: quotes 60 s, history 10 min, lookups 24 h, keyed per source. Per-source timeout 10 s. Tool wall clock 30 s.
- Caveats always include "Quotes may be delayed; not investment advice." and name the delay when known.

### 14.3 `weather`

Purpose: current conditions and a daily (optionally hourly) forecast for a place.

Input:
```ts
{
  location: string | { latitude: number; longitude: number };   // place name (city, "Paris, FR", postcode) or coordinates
  days?: number;                  // forecast days, 1..16, default 3
  units?: "metric" | "imperial";  // default metric (°C, km/h, mm); imperial is °F, mph, inch
  hourly?: boolean;               // default false; when true, `hourly` holds the next 48 hours
}
```

Output:
```ts
{
  location: { name: string; country?: string; admin1?: string; latitude: number; longitude: number; timezone: string };
  current: { time: string; temperature: number; apparent_temperature: number; humidity_pct: number; wind_speed: number;
             wind_direction_deg: number; precipitation: number; weather_code: number; condition: string; is_day: boolean };
  daily: Array<{ date: string; temp_max: number; temp_min: number; precipitation_sum: number; precipitation_probability_max?: number;
                 wind_speed_max: number; sunrise: string; sunset: string; weather_code: number; condition: string; uv_index_max?: number }>;
  hourly?: Array<{ time: string; temperature: number; precipitation_probability?: number; precipitation: number;
                   weather_code: number; condition: string; wind_speed: number }>;
  units: { temperature: "°C" | "°F"; wind_speed: "km/h" | "mph"; precipitation: "mm" | "inch" };
  source: "open_meteo";
  fetched_at: string;
  caveats: string[];
}
```

Behaviour (DECIDED): Open-Meteo only (keyless, no account). Geocoding through `geocoding-api.open-meteo.com/v1/search?name=&count=5&language=en`; the first hit is used and, when more than one hit has a different country or admin1, a caveat lists up to three alternatives with their coordinates. Forecast through `api.open-meteo.com/v1/forecast` with `timezone=auto`; `condition` is the WMO weather-code text from a table in code. Times are the location's local time as the API returns them, with the timezone named in `location.timezone`. Cache 10 min for forecasts, 30 days for geocoding. Timeout 10 s per request, tool wall clock 20 s.

### 14.4 `exchange_rate`

Purpose: convert an amount between currencies at the latest or a historical reference rate.

Input:
```ts
{
  from: string;                   // ISO 4217
  to: string[];                   // 1..20 ISO 4217 codes
  amount?: number;                // default 1, > 0
  date?: string;                  // YYYY-MM-DD for a historical rate (1999-01-04 or later); default latest
}
```

Output:
```ts
{
  base: string;
  date: string;                   // the reference date the rates are for (the previous working day on weekends and holidays)
  amount: number;
  rates: Array<{ currency: string; rate: number; converted: number }>;
  source: "frankfurter";
  fetched_at: string;
  caveats: string[];              // always: ECB reference rates, published once per working day around 16:00 CET; not a trading quote; crypto is not covered
}
```

Behaviour (DECIDED): Frankfurter (`api.frankfurter.dev/v1/latest?base=&symbols=` and `/v1/<date>`), keyless, ECB reference rates for about 30 currencies. An unsupported code is `invalid_input` naming the supported list (from `/v1/currencies`, cached 7 days). Cache 1 h for latest, 30 days for historical. Timeout 10 s, wall clock 20 s.

### 14.5 `social_search`

Purpose: what people are saying about something, across social platforms, as posts and comments; or the comments on one specific thread.

Input:
```ts
{
  query?: string;                 // required unless `url` is given; 1..300 chars
  url?: string;                   // a post, thread or video URL on a supported platform: return its comments instead of searching
  platforms?: SocialPlatform[];   // "reddit" | "hackernews" | "bluesky" | "x" | "facebook" | "youtube"; default every configured platform
  kind?: "posts" | "comments" | "both";   // default both
  recency?: "day" | "week" | "month" | "year";
  sort?: "engagement" | "recent"; // default engagement
  max_results?: number;           // merged total, default 30, max 100
  per_platform?: number;          // default 15, max 50
  subreddits?: string[];          // reddit only: restrict the search to these subreddits
  lang?: string;                  // BCP-47 primary tag, for platforms that filter by language (bluesky, x)
  summarize?: boolean;            // default false; needs ANTHROPIC_API_KEY; writes `summary`
  max_cost_usd?: number;          // cap on LLM spend for this call (summary and any LLM extraction), default 0.50
}
```

Output:
```ts
{
  query: { mode: "search" | "thread"; query?: string; url?: string; platforms: SocialPlatform[]; kind; recency?; sort; max_results; per_platform };
  items: Array<{
    id: string;                   // "<platform>:<native id>"
    platform: SocialPlatform;
    kind: "post" | "comment";
    url: string;
    author?: string;              // handle or display name as shown; never an email address
    title?: string;               // reddit and HN posts, YouTube video titles
    text: string;                 // plain text, at most 2000 chars; `truncated` says when it was cut
    truncated: boolean;
    created_at?: string;          // ISO 8601 UTC
    score?: number;               // upvotes, points or likes
    replies?: number;
    reposts?: number;
    community?: string;           // subreddit, YouTube channel, Facebook group or page, HN section
    parent_url?: string;          // for comments: the post they belong to
    lang?: string;
  }>;
  summary?: {
    text: string;                 // 150 to 400 words, every claim followed by the item ids it rests on in square brackets
    themes: Array<{ theme: string; sentiment: "positive" | "negative" | "mixed" | "neutral"; item_ids: string[] }>;
    cost_usd: number;
  };
  platforms_used: SocialPlatform[];
  platforms_failed: Array<{ platform: SocialPlatform; error: string; needs_login: boolean }>;
  fetched_at: string;
  caveats: string[];
}
```

Platform access (DECIDED):

| platform | search | thread (`url`) | access | login |
|----------|--------|----------------|--------|-------|
| reddit | `/search` (posts); comments = top-level comments of the top matching posts (at most 5 posts, by score) | `/comments/<id>` | 1. Reddit API with app-only OAuth when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are set (`POST https://www.reddit.com/api/v1/access_token`, `grant_type=client_credentials`, then `https://oauth.reddit.com/...`); 2. the public `.json` endpoints on `www.reddit.com` with a descriptive User-Agent (`REDDIT_USER_AGENT`, default `webrunner/<version> personal MCP server`); 3. the browser on `old.reddit.com` | optional; the browser path uses the profile's session when there is one |
| hackernews | Algolia `hn.algolia.com/api/v1/search` with `tags=story` or `tags=comment` and `numericFilters=created_at_i>` | `/api/v1/items/<id>` | keyless API | none |
| bluesky | `api.bsky.app/xrpc/app.bsky.feed.searchPosts` (`sort=top|latest`, `since`, `lang`; the cached `public.api.bsky.app` refuses search, see 14.10); comments = replies of the top 3 posts via `getPostThread` depth 1 on `public.api.bsky.app` | `getPostThread` after resolving the handle to a DID, on `public.api.bsky.app` | keyless API | none |
| x | `https://x.com/search?q=<q>&src=typed_query&f=top` (engagement) or `f=live` (recent), scrolled at most 3 times; DOM probe over `article[data-testid="tweet"]` (text, handle, `time[datetime]`, metrics from aria-labels), LLM fallback | the post page; replies below it | browser only | required: X redirects anonymous search to login, reported as `needs_login` |
| facebook | `https://www.facebook.com/search/posts/?q=<q>`; schema-driven LLM extraction over visible text (the DOM is obfuscated) | the post page; comments below it | browser only | required; a checkpoint or CAPTCHA is `blocked` |
| youtube | `search?part=snippet&type=video&q=&order=relevance|date&publishedAfter=` (posts = videos); comments = `commentThreads` for the top 3 videos | `commentThreads?videoId=` | YouTube Data API v3 with `YOUTUBE_API_KEY`; without it the platform is "not configured" | none |

Behaviour (DECIDED):
- `platforms` unset means every platform that `isConfigured()`: API platforms when their key is present or they need none; browser platforms when a browser session exists. A browser platform that lands on a login wall fails with `needs_login: true` and the message names `accounts connect <platform>`; the call still succeeds with the other platforms.
- Merge: each platform returns at most `per_platform` items; the tool deduplicates by `url`, sorts (`engagement`: score descending with unknown scores last, then `created_at` descending; `recent`: `created_at` descending with unknown dates last) and cuts at `max_results`.
- `url` mode (`mode: "thread"`): the platform is inferred from the host; other `platforms` entries are ignored with a caveat; `kind` is forced to `comments`; `items` are that thread's comments and the first item is the post itself with `kind: "post"`.
- `summarize`: one `extractor`-role call over the items (ids, author, text, score), structured output, under a `CostMeter({ maxCostUsd: max_cost_usd })` shared with any LLM extraction the browser recipes did. When the LLM is unavailable the tool still returns items and adds a caveat.
- Cache: 15 min per platform and query. Per-platform timeout: 15 s for API platforms, 60 s for browser platforms. Tool wall clock 180 s.
- Browser platforms never post, like, follow, reply or message; the recipes only navigate, scroll and read.

### 14.6 `search_reviews`

Purpose: reviews of a place, business, product or app, from review sites, with the subject each site matched.

Input:
```ts
{
  subject: string;                // a name ("Hotel Lutetia Paris", "Sony WH-1000XM5", "Notion") or the URL of a product, place or app page; 1..300 chars
  kind?: "place" | "business" | "product" | "app" | "any";   // default any; steers the default sources
  location?: string;              // disambiguates places and businesses
  sources?: ReviewSource[];       // "google_maps" | "trustpilot" | "app_store" | "google_play" | "amazon"
  max_results?: number;           // merged total, default 30, max 100
  per_source?: number;            // default 15, max 50
  min_rating?: number;            // 1..5
  max_rating?: number;            // 1..5
  recency?: "day" | "week" | "month" | "year";
  sort?: "relevance" | "recent" | "rating_low" | "rating_high";   // default relevance
  app_store_country?: string;     // ISO 3166-1 alpha-2, default "us"
  summarize?: boolean;            // default false; needs ANTHROPIC_API_KEY
  max_cost_usd?: number;          // default 0.50
}
```

Output:
```ts
{
  query: { subject; kind; location?; sources: ReviewSource[]; max_results; per_source; min_rating?; max_rating?; recency?; sort; app_store_country };
  subjects: Array<{               // what each source matched the subject to
    source: ReviewSource; name: string; url?: string; rating_avg?: number; review_count?: number;
    rating_distribution?: { "1": number; "2": number; "3": number; "4": number; "5": number };
    address?: string; categories?: string[]; price_level?: string;
  }>;
  reviews: Array<{
    id: string;                   // "<source>:<native id or 12-hex hash>"
    source: ReviewSource;
    url?: string;
    author?: string;
    rating?: number;              // 1..5, half steps allowed, normalised from the source's scale
    title?: string;
    text: string;                 // at most 2000 chars
    truncated: boolean;
    created_at?: string;          // ISO 8601 UTC; approximate when the site prints "2 months ago" (a caveat says so)
    helpful_votes?: number;
    verified?: boolean;           // verified purchase or stay when the site says
    version?: string;             // app version reviewed
    language?: string;
    response?: { text: string; created_at?: string };   // the owner's or developer's reply
  }>;
  summary?: { text: string; themes: Array<{ theme: string; sentiment: "positive" | "negative" | "mixed" | "neutral"; item_ids: string[] }>; cost_usd: number };
  sources_used: ReviewSource[];
  sources_failed: Array<{ source: ReviewSource; error: string; needs_login: boolean }>;
  fetched_at: string;
  caveats: string[];
}
```

Source access (DECIDED):

| source | default for kind | how |
|--------|------------------|-----|
| google_maps | place, business, any | browser: `https://www.google.com/maps/search/<subject> <location>?hl=en`, first result, reviews tab, scroll at most 3 times; DOM probe over `div[data-review-id]` (rating from the `aria-label` "N stars", text, relative time), LLM fallback; consent and CAPTCHA handling as in flights |
| trustpilot | business, product, any | a raw fetch of `https://www.trustpilot.com/review/<domain>` (subject given as a URL or a bare domain, or a name resolved via `https://www.trustpilot.com/search?query=`; a bare domain with no page falls back to the search); reviews are parsed from the page's embedded JSON (`__NEXT_DATA__` or JSON-LD). A WAF challenge falls back to the shared browser, whose rendered HTML is parsed the same way, then to `FetchService` and LLM extraction over the Markdown |
| app_store | app, any | keyless: `itunes.apple.com/search?term=&entity=software&country=&limit=5` to find the app, then `itunes.apple.com/<country>/rss/customerreviews/id=<id>/sortBy=mostRecent/page=<n>/json`, pages 1 to 3 at most (50 reviews each) |
| google_play | app, any | browser: `https://play.google.com/store/search?q=<subject>&c=apps` for the package id, then `/store/apps/details?id=<pkg>&hl=en&showAllReviews=true`; DOM probe, LLM fallback |
| amazon | product, any | browser: `https://www.amazon.com/s?k=<subject>` first product, then `/product-reviews/<ASIN>`; Amazon shows a CAPTCHA or limits review pages to signed-in users, reported as `blocked` or `needs_login` |

Behaviour (DECIDED): `sources` unset means the configured sources whose default kinds include `kind`. Each source returns one `subjects` entry and at most `per_source` reviews; the tool filters by rating and recency in code, sorts (`relevance` keeps each source's order and interleaves sources round-robin; `recent` by `created_at` descending; `rating_low`/`rating_high` by rating), cuts at `max_results`. Rating normalisation: a 10-point scale is halved; a percentage is divided by 20. `summarize` as in 14.5. Cache 1 h per source and subject. Per-source timeout 15 s for the App Store, 60 s for browser sources and for Trustpilot, whose WAF fallback renders in the browser (changed 2026-10-21, see 14.10). Tool wall clock 180 s.

### 14.7 `accounts`

Purpose: let the owner connect their own accounts to the server's browser profile so that browser-based platforms work through their session; see what is connected; disconnect.

Input:
```ts
{
  action: "list" | "connect" | "disconnect";
  platform?: AccountPlatform;     // required for connect and disconnect: "reddit" | "x" | "facebook" | "instagram" | "google" | "amazon" | "linkedin"
  wait_seconds?: number;          // connect only: how long to wait for the login to complete, 0..300, default 120
}
```

Output, by action:
```ts
// list
{ action: "list"; mode: "persistent" | "cdp"; profile_dir?: string;
  accounts: Array<{ platform: AccountPlatform; connected: boolean; domains: string[]; used_by: string[]; checked_at: string; expires_at?: string }>;
  caveats: string[] }
// connect
{ action: "connect"; platform; status: "connected" | "pending" | "already_connected"; login_url: string; waited_s: number; instructions: string; caveats: string[] }
// disconnect
{ action: "disconnect"; platform; status: "disconnected" | "not_connected"; cookies_cleared: number; caveats: string[] }
```

Behaviour (DECIDED):
- Platform table in `src/core/accounts/platforms.ts`: for each platform its cookie domains, the session cookie names that prove a login (`reddit_session`; `auth_token` on x.com; `c_user` on facebook.com; `sessionid` on instagram.com; `SID` and `SAPISID` on google.com; `x-main` or `at-main` on amazon.com; `li_at` on linkedin.com), its login URL, and `used_by` (the tools and platforms that read through it: reddit by `social_search`; x by `social_search`; facebook by `social_search`; google by `search_hotels`, `search_reviews` (google_maps, google_play) and `search_flights` (consent and personalisation only; those work logged out too); amazon by `search_reviews`; instagram and linkedin by nothing yet, listed so the owner can log in ahead of future recipes).
- `list` reads cookies through `BrowserSession.cookies()` (14.8), which launches the browser if needed; `connected` is true when every required session cookie is present and unexpired. Values are never logged or returned.
- `connect`: in persistent mode with a display (headful), opens the login URL in a page held outside the pool, returns `already_connected` at once when the cookies are already there, otherwise polls the cookies every 2 s for up to `wait_seconds`; `connected` closes the page, `pending` leaves it open (closed automatically after 10 minutes, or by the next `connect`/`list` that finds the login done) and the instructions say to finish logging in and call `connect` again. In headless persistent mode it fails with `config` and the instructions name the two ways out: run the server where a display exists with `BROWSER_HEADLESS=false`, or set `BROWSER_CDP_URL` to the owner's own Chrome. In CDP mode it opens the login URL as a tab in the owner's Chrome and polls the same way.
- `disconnect`: persistent mode clears the platform's cookies through `BrowserSession.clearCookies()` and reports how many; CDP mode refuses with `config` ("webrunner never changes the cookies of your own Chrome; log out there").
- Logging into Google inside an automated Chromium is often refused by Google ("this browser may not be secure"); the caveat on `connect google` says so and recommends CDP attach. Facebook and X may show a verification checkpoint on a new browser; completing it in the window is fine, it is the owner's own session.
- Tool wall clock 330 s (the longest wait plus margin). The tool never types into the page.

### 14.8 Internal interface additions

**4.3 `BrowserSession`** gains two methods (DECIDED; implemented by WP16, fakes in tests updated by WP16):
```ts
interface BrowserSession {
  // ... as before
  /** Cookies visible to the shared context, optionally only those sent to these URLs. Launches or attaches if needed. */
  cookies(urls?: string[]): Promise<BrowserCookie[]>;
  /** Remove cookies whose domain matches (exact, or a leading-dot parent). Persistent mode only; CDP mode throws. Returns how many were removed. */
  clearCookies(filter: { domain: string }): Promise<number>;
  /** A page that is not counted against the pool, for long-lived interactive use (login windows). Closed by `close()`. */
  openUnpooledPage(): Promise<Page>;
}
interface BrowserCookie { name: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; }   // no `value`, by design
```

**4.5 `RecipeContext`** is unchanged; recipes that need to say "login required" throw `RecipeError("blocked", ...)` with `needsLogin: true` (a new optional field on `RecipeErrorOptions`, added by WP15) so the owning tool can set `needs_login`.

**New provider interfaces** (contracts, written by WP15 in `src/core/<area>/types.ts`; implementers do not change them):
- `HotelProvider` (`src/core/hotels/types.ts`): `name`, `isConfigured()`, `search(query: NormalizedHotelsQuery, signal, hooks?: { caveats?: string[] }): Promise<HotelResult[]>`; errors are `HotelProviderError` with the flights error codes.
- `MarketProvider` (`src/core/markets/types.ts`): `name`, `assetTypes`, `isConfigured()`, optional `lookup(query, signal): Promise<SymbolMatch[]>`, `quote(symbol, opts: { history?; currency }, signal): Promise<MarketQuote>`; errors are `MarketProviderError` with codes `provider | timeout | config | blocked | not_found | invalid_input`.
- `SocialPlatformProvider` (`src/core/social/types.ts`): `name`, `access: "api" | "browser"`, `isConfigured()`, `search(q: SocialSearchQuery, signal, hooks?): Promise<SocialItem[]>`, `thread(url, q, signal, hooks?): Promise<SocialItem[]>`, `ownsUrl(url): boolean`; errors are `SocialProviderError` with `needsLogin`.
- `ReviewSourceProvider` (`src/core/reviews/types.ts`): `name`, `defaultKinds`, `isConfigured()`, `search(q: NormalizedReviewsQuery, signal, hooks?): Promise<{ subject: ReviewSubject; reviews: Review[] }>`; errors are `ReviewSourceError` with `needsLogin`.
- Hooks carry `caveats?: string[]` and `meter?: CostMeter` so a tool can pool LLM spend across sources under `max_cost_usd`.

**Config (4.8)** gains, all optional: `REDDIT_CLIENT_ID` / `reddit_client_id`, `REDDIT_CLIENT_SECRET` / `reddit_client_secret`, `REDDIT_USER_AGENT` / `reddit_user_agent`, `YOUTUBE_API_KEY` / `youtube_api_key`, `FINNHUB_API_KEY` / `finnhub_api_key`. The secrets join the redaction list in `deps.ts`.

**Wall-clock caps (`src/tools/guard.ts`)**: `search_hotels` 120 s, `market_quote` 30 s, `weather` 20 s, `exchange_rate` 20 s, `social_search` 180 s, `search_reviews` 180 s, `accounts` 330 s.

### 14.9 Work breakdown, phase 5

Branch names `wp<N>-<slug>`, one PR each against `main`, the Section 7 protocol applies. Every WP adds its tool to `TOOL_NAMES` and `registerTools` in `src/tools/index.ts` (one line each; the orchestrator resolves the trivial conflicts), a case to `test/unit/tools/envelope.test.ts` and a tool-list expectation where tests enumerate tools. Unit tests run offline; browser recipes are tested on real Chromium against local fixture pages, as the flights recipe is; anything that hits a real service is gated behind `RUN_INTEGRATION=1`.

**WP15: Plan, contracts, config, caps** (orchestrator)
- Deliver: this section; `src/schemas/{hotels,markets,weather,fx,social,reviews,accounts}.ts`; `src/core/{hotels,markets,social,reviews}/types.ts`; `needsLogin` on `RecipeErrorOptions`; the five config keys; the seven caps; tests for the new config keys and caps.

**WP16: Browser cookies and the `accounts` tool** (parallel with all others)
- Depends on: WP15.
- Files: `src/core/browser/session.ts`, `src/core/browser/types.ts` (the three new methods and `BrowserCookie`), `src/core/accounts/{platforms,index}.ts`, `src/tools/accounts.ts`, every test fake of `BrowserSession` (`test/unit/tools/helpers.ts` and any other), new tests under `test/unit/accounts/` and `test/unit/browser/session.test.ts`.
- Accept: on real Chromium with a local fixture server that sets a cookie named like a platform's session cookie on a fixture domain mapping (tests may inject the platform table), `list` reports connected, `disconnect` clears it and `list` reports not connected; `connect` with `wait_seconds: 0` returns `pending` and leaves a page open that `close()` cleans up; in a CDP-mode fake `disconnect` returns `config`; no cookie value appears in any result or log line (asserted). Headless persistent `connect` returns `config` with both instructions.

**WP17: `search_hotels`** (parallel)
- Depends on: WP15.
- Files: `src/core/browser/recipes/google-hotels.ts`, `src/core/hotels/providers/{google-hotels,index}.ts`, `src/tools/search_hotels.ts`, `test/unit/hotels/**`, `test/fixtures/hotels/**`, one gated integration test.
- Accept: fixture page built from a live Google Hotels results DOM (recorded by the implementer, hotel names kept, any personal data removed) yields at least 10 hotels with name, nightly price, rating and review count through the deterministic probe alone (no LLM call, asserted via a scripted LLM that fails if called); a page where the probe finds nothing goes to the LLM path and validates; filters and sorts behave per 14.1; blocked and empty pages map to `blocked` and to an empty list with a caveat. The PR records the live URL form that worked.

**WP18a: `social_search` tool and API platforms** (parallel)
- Depends on: WP15.
- Files: `src/core/social/{index,merge,summary}.ts`, `src/core/social/platforms/{reddit,hackernews,bluesky,youtube,index}.ts`, `src/tools/social_search.ts`, `test/unit/social/**` (except browser platform tests), `test/fixtures/social/**`.
- Accept: fixture-driven tests per platform map real or documented responses to `SocialItem[]` (Hacker News and Bluesky can be recorded live where the environment allows; Reddit and YouTube from docs); the Reddit provider's three-step fallback is tested with a fetch fake (API when keys present, `.json` otherwise, and a 403 from `.json` hands over to the browser platform when one is registered); thread mode infers the platform from the URL; merge, dedupe, sort and `max_results` are table-tested; `summarize` with a scripted LLM produces a `summary` whose `item_ids` all exist; an LLM failure still returns items plus a caveat; `platforms_failed` carries `needs_login` through from a `SocialProviderError`.

**WP18b: `social_search` browser platforms** (parallel with WP18a)
- Depends on: WP15.
- Files: `src/core/browser/recipes/{x-search,facebook-search,reddit-search}.ts`, `src/core/social/platforms/{x,facebook,reddit-browser}.ts`, `test/unit/social/browser/**`, `test/fixtures/social/browser/**`, plus one line in `src/core/social/platforms/index.ts` registering the three (WP18a owns that file; the orchestrator merges the line).
- Accept: on real Chromium against fixture pages: the X recipe extracts posts from `article[data-testid="tweet"]` markup with handle, text, time and metrics; a fixture that redirects to a login page yields `SocialProviderError` with `needsLogin: true`; the Facebook recipe reaches the LLM extraction path with a scripted model and validates; the old.reddit recipe parses search results and a thread's top-level comments; none of the recipes ever calls `fill`, `type` or `press` (asserted with a Playwright page spy).

**WP19a: `search_reviews` tool, App Store and Trustpilot** (parallel)
- Depends on: WP15.
- Files: `src/core/reviews/{index,merge,summary}.ts`, `src/core/reviews/sources/{app-store,trustpilot,index}.ts`, `src/tools/search_reviews.ts`, `test/unit/reviews/**` (except browser source tests), `test/fixtures/reviews/**`.
- Accept: the App Store source finds an app by name and maps a recorded RSS page to reviews with rating, version, title and text; the Trustpilot source parses a recorded page's embedded JSON and falls back to LLM extraction over Markdown with a scripted model; rating normalisation and filters are table-tested; `sources` defaulting by `kind` is tested; summary as in WP18a.

**WP19b: `search_reviews` browser sources** (parallel with WP19a)
- Depends on: WP15.
- Files: `src/core/browser/recipes/{google-maps-reviews,google-play-reviews,amazon-reviews}.ts`, `src/core/reviews/sources/{google-maps,google-play,amazon}.ts`, `test/unit/reviews/browser/**`, `test/fixtures/reviews/browser/**`, plus one registration line in `src/core/reviews/sources/index.ts` (merged by the orchestrator).
- Accept: on real Chromium against fixture pages: Google Maps reviews with star ratings, text and approximate dates from `div[data-review-id]` markup, with the consent dialog dismissed; Google Play reviews from the details page; an Amazon fixture showing a CAPTCHA maps to `blocked` and one showing the sign-in page to `needsLogin`; no recipe types into the page (spy-asserted).

**WP20: `market_quote`, `weather`, `exchange_rate`** (parallel)
- Depends on: WP15.
- Files: `src/core/markets/providers/{yahoo,finnhub,coingecko,google-finance,index}.ts`, `src/core/markets/{index,resolve}.ts`, `src/core/browser/recipes/google-finance.ts`, `src/core/weather/{index,codes}.ts`, `src/core/fx/index.ts`, `src/tools/{market_quote,weather,exchange_rate}.ts`, tests and fixtures under `test/unit/{markets,weather,fx}/**` and `test/fixtures/{markets,weather,fx}/**`.
- Accept: fixture mapping tests for each provider (CoinGecko and Frankfurter may be recorded live; Yahoo and Finnhub from docs; Open-Meteo geocoding live, forecast from docs); routing table-tested (crypto to CoinGecko first, equities to Yahoo then Finnhub then Google Finance, a 429 from Yahoo hands the symbol to the next source); name lookup with several matches quotes the first and lists the rest in caveats; the Google Finance recipe extracts price, change and currency from a fixture page; weather geocoding ambiguity produces the alternatives caveat; WMO code table covers every code the API documents; an unsupported currency is `invalid_input` listing the supported ones; cache TTLs per 14.2 to 14.4 asserted with an injected clock.

**WP21: Integration, health, README, installers** (after WP16 to WP20)
- Files: `src/tools/health.ts` (configured hotel sources, market sources, social platforms, review sources, connected account platforms by name), `scripts/install-*.sh` and `test/unit/scripts.test.ts` (the five new variables), `README.md` (one section per new tool with examples, an "Accounts" section with the Google-via-CDP recommendation, the per-platform terms-of-service paragraph, the new keys in the configuration table, costs), `CLAUDE.md` (one line on the opinion tools' rules), `.github/workflows/live.yml` (new gated suites), `PLAN.md` status line and decision log.
- Accept: `health` lists the new names; a fresh clone passes lint, typecheck and tests; `tools/list` over stdio shows 14 tools; the README examples parse against the input schemas (a test).

### 14.10 Decision log, phase 5

- **2026-10-21, WP28 (one set of review helpers)**: this closes the WP19b follow-up. WP19a's `src/core/reviews/normalize.ts` and WP19b's `relative-date.ts` and `sources/shared-browser.ts` each had their own `APPROXIMATE_DATE_CAVEAT`, `parseReviewDate`, `truncateReviewText`, `reviewId` and `kindsDefaultingTo`. Now there is one of each: dates live in `relative-date.ts` and `normalize.ts` re-exports them; `normalize.ts` holds the id, text and kind helpers, and `shared-browser.ts` re-exports them for the browser sources. `relative-date.ts`'s parser won because it reads "Oct 2, 2026" in UTC by hand. The `Date.parse` version it replaces read such dates in the server's time zone, which affected Trustpilot's LLM-extracted dates. It also accepts "Reviewed in the United States on ..." and "Edited ..." prefixes. It gained a fallback for absolute dates that name their zone (RFC 2822 "... GMT" or "+0200"), so nothing time-zone-independent that `Date.parse` accepted is lost. `reviewId(source, nativeId, fallback)` keeps the native id only when it looks like an id (`[\w.:=-]+`), and every source passes `"<author>\n<text>"` as the fallback. Hashed ids (sources without a native id) are now 12 hex characters of sha256 for the browser sources too, instead of sha1, so such ids change once; they are not stored anywhere beyond the one-hour cache. No contract changes.
- **2026-10-21, WP27 (Amazon review medley, decided live)**: the WP19b follow-up "should Amazon fall back to the product page's review medley when the review list needs a login" was tried from a Claude Code cloud session, logged out. `/product-reviews/<ASIN>` redirected to `/ap/signin` every time. The product page (`/dp/<ASIN>`) rendered the "Top reviews from the United States" medley, 13 `[data-hook="review"]` blocks rendered client-side, in 5 of 16 loads, and in none of the last 7 from that IP. The medley uses `reviewTitle` and `reviewRichContentContainer` where the list uses `review-title` and `review-body`. **Decision: fall back.** When the list redirects to sign-in, the recipe opens the product page and waits up to 10 s (one scroll) for the medley. If it renders, its reviews are returned with a caveat that names the limit and `accounts connect amazon`; if not, the original `blocked` + `needs_login` stands. The medley never goes to the LLM: product-page text without review blocks has nothing to extract. The cost is one page load and at most about 10 s within the source's 60 s, and a connected account never takes this path. Whether a home IP gets the medley more often is for the owner's first run. Fixture: `amazon-product-medley-live.html` (sanitized, reviewer names replaced, profile links removed).
- **2026-10-21, WP26 (Trustpilot verified live)**, from a Claude Code cloud session (not the owner's machine). Raw requests still got the AWS WAF challenge (HTTP 403, 991 bytes). The old fallback (FetchService browser render, then LLM extraction over the Markdown) timed out at the 15 s budget for a name, as 14.10 predicted. But Chromium passes the challenge on its own (it is a script, not a CAPTCHA: 403, then 308, then 200 in 2.6 to 7 s), and the rendered page's `__NEXT_DATA__` has exactly the documented fields, so `parseNextData` (written from docs) read the live page unchanged: Notion 2.2 from 440 reviews, star histogram, 20 reviews. The source now takes the shared browser and, past a wall, parses the rendered HTML's embedded JSON before trying the Markdown and model path, so Trustpilot works with no key: live, 2.0 to 4.4 s per subject including a name lookup (search page, then review page). The per-source budget is raised from 15 s to 60 s (14.6 updated), because the model fallback still renders two pages and makes a 16k-token extraction call. A bare domain subject (`notion.so`) now goes straight to `/review/<domain>` and falls back to the search on a 404, which the browser reports as the last main-frame navigation status. The search page's results are plain `href="/review/<domain>"` links. JSON-LD on the live page names Trustpilot itself as the organization, so it stays second to `__NEXT_DATA__`. Fixture: `trustpilot-review-live.html` (the embedded JSON only, trimmed, reviewer names pseudonymized).
- **2026-10-21, WP25 (Bluesky verified live)**, from a Claude Code cloud session (not the owner's machine): `public.api.bsky.app/xrpc/app.bsky.feed.searchPosts` answers HTTP 403 with an HTML "403 Forbidden" page (also with other user agents), which is what the v0.2 build saw, while the same host serves `getPostThread`, `resolveHandle` and `getProfile` keyless, and `api.bsky.app` serves `searchPosts` keyless. Search now goes to `api.bsky.app` (the 14.5 table is updated); threads and handles stay on the cached public host. The live search, thread and handle responses matched the documented shapes the mapper was built from; trimmed copies are recorded as `bluesky-*-live.json`. Bridged fediverse posts carry an extra `record.fullText`, which is HTML, so `text` stays the source.
- **2026-10-21, WP24 (search_hotels re-checked live)**, from a Claude Code cloud session (shared cloud IP, headless, logged out; not the owner's machine): Rome 2026-11-25 to 28 and Paris 2026-12-02 to 04, 2 adults, both read deterministically ("google hotels: read deterministically", 18 cards, no model call). **Organic cards now print guest ratings and review counts** (Rome 17 of 18, Paris 18 of 18), as the card aria-label "4.7 out of 5 stars from 228 reviews, <name>", which the existing parser reads unchanged; recorded as `google-hotels-results-rated-live.html` with a test. **"Next" still does not paginate**: the click lands on the button, the page sends no network request and keeps the same 18 cards, so the tool returns one page and caveats the total ("Showing results 1 - 18 of 8,084"). No code change was needed; 14.1's optional `rating`/`review_count` stand, since the earlier run from a similar IP got none.
- **2026-10-21, WP23 (market_quote verified live)**, from a Claude Code cloud session (not the owner's machine). Fixtures `test/fixtures/markets/*-live.*`.
  - **Yahoo answered**, but only to Node's fetch: `curl` from the same network still got 429, so the block looks at the client as well as the IP. The live chart `meta` differs from the documented shape the mapper assumed: no `previousClose` and no `marketState`; it carries `regularMarketChangePercent`, `fulldayChange`/`fulldayPrice` and `currentTradingPeriod`; and `chartPreviousClose` is the close before the chart's first bar, so with `history: 1mo` the "daily" change was the month's change (VOD.L -7.27 % against a real -0.67 %, ^GSPC -0.02 % against +0.65 %). The previous close now comes from `previousClose`, else `fulldayChange` when stated for the regular price, else `regularMarketChangePercent`, else `chartPreviousClose` for range 1d only. London is quoted in pence as `GBp`, which was upper-cased to `GBP` (a price 100 times too high in pounds); `GBp` and `ZAc` now map to `GBX` and `ZAC` with a caveat. The market state is derived from `currentTradingPeriod` when `marketState` is absent, and the session open is the first bar inside the regular period.
  - **CoinGecko quoted the wrong coin for "bitcoin"**: the name was routed upper-cased as `BITCOIN-USD`, and `rankCoins` put exact symbol matches first, so an unranked token whose ticker is literally `BITCOIN` won ($0.015). Known coin names now route as their ticker (`BTC-USD`, also what Yahoo needs), exact matches (id, symbol, name) are ordered by market-cap rank, and the per-process resolve cache keeps only each query's own answer.
  - **Google Finance**: index pages print the level with no currency and a status line that is only a timestamp, so `^GSPC` and `^FTSE` fell to the LLM; and the name "S&P 500" parsed as a price of 500 in a currency "S&P". Index listings now carry Yahoo's currency for the index, a timestamp-only status line is read, and only known currency signs or Unicode currency symbols count as a price prefix. Share classes: Google uses `BRK.B:NYSE` and `BT.A:LON` but `VOLV-B:STO` and `NOVO-B:CPH`, so a Yahoo hyphen becomes a dot on US exchanges and in London only. The suffix table was checked live for `.L .DE .PA .AS .SW .MC .MI .ST .CO .T .TO .AX .HK .NS .KS .SS .SA .SI` and the indices `^GSPC ^FTSE ^DJI ^N225`; no common suffix failed.
- **2026-10-21, WP22 (weather verified live)**, first run after the v0.2 merge, from a Claude Code cloud session (a shared cloud IP, not the owner's machine): the Open-Meteo forecast endpoint answered, and its response had exactly the documented keys, units and parallel arrays the mapper assumed; it is recorded as `test/fixtures/weather/forecast-paris-live.json`. One bug found live: `hourly` held only the hours left in the requested `days` (22 entries for `days: 1`), not the 48 hours 14.3 promises, because Open-Meteo returns hourly data only for `forecast_days`; an hourly request now asks for at least 3 days and `daily` is cut back to `days`. From the shared IP, some forecast requests answered HTTP 429 "Daily API request limit exceeded" (Open-Meteo's per-IP free quota); that stays a retryable `provider` error.

- **2026-10-21, WP19b (Google Maps, Google Play and Amazon reviews)**, merged last: Google Play's search and details pages rendered live from the development IP and seed its fixtures (the reviews dialog and developer reply are synthetic); Google Maps' script bundle answered HTTP 403 so its recipe is tested on synthetic markup; Amazon's review list redirected to `/ap/signin` with a soft `validateCaptcha` check, recorded as the sign-in fixture, and the recipe reports that as `blocked` with `needsLogin` while a hard CAPTCHA form is `blocked` alone. The browser sources take `browser` as optional so they are listed as unconfigured without one. Two follow-ups: unify WP19a's `normalize.ts` date and id helpers with WP19b's `relative-date.ts` and `shared-browser.ts`, and decide whether Amazon should fall back to the product page's review medley when the list needs a login.
- **2026-10-21, WP21 (integration, health, README, installers)**, recording what the phase 5 PRs (#17 to #21) found and decided, so the contracts above are read with these in mind:
  - **MCP SDK 1.32 accepts only a `z.object` as `outputSchema`.** A `z.discriminatedUnion` is dropped from `tools/list` and crashes result validation. `accounts` therefore advertises `AccountsOutputObjectSchema` (one object carrying every per-action field, optional except `action` and `caveats`) whose `superRefine` accepts exactly what the real contract `AccountsOutputSchema` (14.7) accepts, and the handler validates each result against the real discriminated union before returning. The schema file is unchanged; the contract stands.
  - **`invalid_input` for malformed arguments is produced by the SDK**, which validates `inputSchema` before any handler runs and answers with its own validation text (no envelope, no `structuredContent`), for every tool. The handlers keep their `invalid_input` branch for failures the schema cannot express (an unknown place, an unsupported currency, a URL no platform owns, a `check_out` before `check_in` when the refinement is run in code). `search_hotels` registers `z.object(SearchHotelsInputSchema.shape)` so its date refinements produce the envelope rather than SDK text. This continues the 2026-10-18 decision for 3.6.
  - **Google Hotels** (14.1): only the natural-language URL form (`q=hotels in <destination> from <check_in> to <check_out> for N adults`) sets the dates; the `checkin=`/`checkout=` parameter form keeps today's dates. No form set the guest count; the recipe sends both, reads the controls back and caveats on mismatch, as 14.1 asks. From the development IP, organic cards printed no guest rating or review count in any run (two cities, two `gl` values, two user agents); only sponsored cards did. The probe parses both of Google's rating forms, so ratings appear without code changes where Google prints them; `rating` and `review_count` stay optional and the tool caveats how many hotels lack them. Stay totals with taxes and fees are printed per card and fill `total_price`. "Next" did not load more results live; the recipe tries twice and caveats. Sponsored rows are returned, tagged, in the advertiser's currency, excluded from `max_price_per_night` comparison.
  - **Google Finance** (14.2): the 2026 page carries none of the `data-last-price` / `data-currency-code` / `data-exchange` attributes the contract hinted at; the recipe parses the visible text of `c-wiz[data-show-intraday]` and the label/value stats block, falls back to LLM extraction when a header exists but is unreadable, and tries NASDAQ, NYSE and NYSEARCA for a suffix-less ticker (only `LON` and `NASDAQ` verified live). `delayed_min` is set only when the page says so.
  - **CoinGecko history uses `/coins/<id>/ohlc`**, not `/market_chart` as 14.2 says: `ohlc` yields the o/h/l/c bars the `Bar` schema needs, `market_chart` carries closes only. CoinGecko picks the bar size (30 min, 4 h, 4 days); `interval` reports the nearest supported value with a caveat. 14.2's wording is superseded by this entry.
  - **Yahoo Finance answered 429 to every request** from the development IP without `Retry-After`; the provider maps that to a retryable rate-limit error that hands the symbol to the next source, so without `FINNHUB_API_KEY` equity quotes come from Google Finance.
  - **Trustpilot** (14.6): the live site served an AWS WAF challenge (HTTP 403, 991 bytes) on both the review page and search; the WAF fallback (browser render through `FetchService`, then LLM extraction) is implemented as specified but rarely fits in the 15 s per-source budget 14.6 fixes for fetch sources, so on a protected network the source reports `timeout` or `blocked`. The budget is injectable (`timeoutsMs`); raising Trustpilot to 60 s when the fallback is taken is a candidate follow-up, not done in phase 5. The page parsers (`__NEXT_DATA__`, JSON-LD) are from documentation.
  - **Reddit**: `sort: engagement` maps to Reddit's `top` (not `relevance`) with `t=` from `recency`; a 403 from the public endpoints without a browser fallback stays `provider` (open question whether `blocked` fits better). Thread mode keeps the post first regardless of `sort`. `kind: both` splits `per_platform` as ceil(n/2) posts and the rest comments.
  - **WP18b browser platforms** (14.5): Facebook's HTTP 404 on the search URL is `needsLogin` (that is how Facebook hides search from anonymous visitors); X `recency` uses the `since:` operator; Facebook `recency` has no URL form and becomes a caveat, and its `sort: recent` uses the UI's `filters=` value, unverified; Reddit's browser recipe splits `kind: both` as ceil(n/2) posts plus comments and passes the over-18 interstitial by clicking once; thread mode returns the post plus up to `per_platform` comments; `LlmError` `budget_exceeded`/`internal` map to `provider` (open question: add `budget_exceeded` to `SocialProviderErrorCode`); authors are `@handle` on X, display names on Facebook, bare usernames on Reddit with bare subreddit `community`, and dedupe relies on canonical urls. A shared `recipes/social-common.ts` holds the plumbing. Live from the cloud IP: X 403 (empty body) even on `/i/flow/login`, Facebook search 404, old.reddit redirect to login then "blocked by network security".
  - **`health`** builds every source list from the same `buildAll*` functions the tools use and filters by `isConfigured()`, so it reports whatever is registered (including WP18b's and WP19b's platforms once merged) without a hard-coded list; `accounts.connected` is read only when `browser.isOpen()` and is `null` otherwise, since `BrowserSession.cookies()` would launch Chromium (asserted with a fake whose `cookies()` throws when closed). `live.yml` no longer skips the whole job when no secret is set, because phase 5 added keyless canaries; tests whose key is missing still skip themselves.
  - **Installer redaction** now covers `*_SECRET` and `*_CLIENT_ID` as well as `*_KEY` when printing the `claude mcp add` command.
  - **Open for the owner's first live run**: whether organic Google Hotels cards print ratings from a home IP or signed-in profile; the Google Finance exchange-suffix table beyond `LON` and `NASDAQ`; the `accounts` login URLs; the X, Facebook, old.reddit, Google Maps, Google Play and Amazon recipes against the live sites with a connected account; Reddit API and YouTube with real keys; the Trustpilot budget.
- **2026-10-18, WP15**: phase 5 planned at the owner's request. Seven tools, three groups, same provider-and-recipe architecture as flights. Logged-in browsing is passive and account connection is explicit through the `accounts` tool. Keyless sources first. Browser session gains cookie access without ever exposing values. Caps, config keys and contracts fixed here so WP16 to WP20 run in parallel on disjoint files.
