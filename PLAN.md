# WEBRUNNER: Implementation Plan

> Repository: github.com/krybaby7/WEBRUNNER (GitHub slugs are case-insensitive). The npm package and all code use lowercase `webrunner`.
> Status: v1 plan, not yet started.
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
- PDFs are not supported by the fast path (`FetchError` code `invalid_input`). Until a PDF path exists (WP14), `fetch_page` returns that error unchanged.
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
    stopped_reason: "converged" | "iterations" | "budget" | "searches" | "reads" | "no_results";
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

Field definitions (DECIDED, as implemented in `src/schemas/flights.ts`): `airline` is the 2-character IATA carrier code and `flight_number` is carrier code plus number with no space (`BA117`). `depart_at` and `arrive_at` are local times; the UTC offset is present only when the source provides it. Each slice has exactly `segments.length - 1` layovers. `query` echoes `NormalizedFlightsQuerySchema` (resolved IATA codes, fully populated passengers, resolved sources, currency always set). Passenger limits: at least 1 adult, infants no more than adults, at most 9 in total. Duffel prices children at an assumed age of 8 and infants at 1 because the contract carries counts only; an optional `child_ages` input is deferred. Duffel returns offers in the airline's currency and cannot convert, so when any offer's currency differs from `query.currency` the tool adds a caveat and sorts within currency groups rather than across them. `max_stops` unset means "provider default", which differs between sources (Duffel defaults to 1 connection); the tool says so in a caveat when sources disagree. Each provider caps at 30 offers before the tool merges and re-sorts.

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

Implemented shape (WP4): the tree comes from Playwright's `ariaSnapshot()` parsed into nested nodes; `Snapshot` also carries `refs: Map<string, Locator>` (role-plus-name locators, `getByText` for text-only nodes) and `refInfo: Map<string, {role, name}>`. Refs are deterministic for an unchanged page but go stale after any DOM change, so the agent takes a fresh snapshot after every action and prefers interactive refs. Iframe content is not in the tree. Names are truncated to 120 characters in the text but locators use the full name. The tree is capped at 400 lines; nodes past the cap have no ref. A screenshot is taken only when requested, or when the tree is empty and a `screenshotDir` was given.

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
| RESEARCH_MAX_COST_USD   | no       | default 3.00 per deep_research call      |
| WEBRUNNER_CACHE_DIR  | no       | default ~/.cache/webrunner            |
| WEBRUNNER_LOG_LEVEL  | no       | default info                             |

\* Optional at startup by decision (Section 1). Config-file keys are the lowercase variable names (`brave_api_key`, `model_planner`, ...); unknown keys are rejected; the environment overrides the file; empty env vars count as unset. All keys above already exist in `src/config.ts`; work packages read them from `deps.config` and do not edit `config.ts` unless their brief says so.

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
- Prompts live in `prompts.ts` with a version string included in cache keys for evals.

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
- Deliver: `engine.ts` implementing Section 5 with injectable search/fetch/llm; `prompts.ts`; budget enforcement; notes data model.
- Accept: a fully mocked run (fixture search results, fixture pages, scripted LLM responses) completes in under 2 s, produces the right number of iterations for each depth, stops on convergence, and stops on budget. Every claim in mocked output has at least one source id.

**WP8: `deep_research` tool and report formatting** (after WP7)
- Depends on: WP7.
- Deliver: the tool, `report.ts` with stable citation numbering, `brief` mode, `stats`.
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

**WP14: Hardening**
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

---

## 13. Decision log

- **2026-10-18, after WP2/WP9/WP12**: `Deps` now carries `llm` and `browser` with `closeDeps` on shutdown, so WP5, WP10 and WP11 consume rather than create them. 3.3 gained `published_at` on sources, `quote` on findings, `depth`, `stats.pages_failed`, `stats.stopped_reason`, the citation invariants and the engine entry point, all from the WP9 judge's needs. 3.5 gained field definitions, passenger limits and the currency and `max_stops` caveats from WP12. Canonicalization list unified between 3.1 and 4.1. SDK-level input validation accepted in place of `invalid_input` envelopes for malformed input.
- **2026-10-18, after WP1/WP3/WP4/WP6**: recorded the implemented shapes for search normalization, bot-wall semantics (returned vs thrown), the browser session and snapshot contracts, and the LLM client (`Usage`, `LlmError`, per-run `CostMeter`, `maxTokens: 16000` for planner calls). WP5 now depends on WP2 for the cache and owns wiring the shared `BrowserSession` into `Deps` and shutdown. Jina's `X-Return-Format` header is dropped in WP5. PDF extraction and a Chromium CI job were added to WP14. Playwright is pinned to 1.56.1 to match the Chromium build shipped with the dev environment; the README (WP13) must say to run `npx playwright install chromium` elsewhere. `vitest.config.ts` includes `test/integration/**` only when `RUN_INTEGRATION=1`.
- **2026-10-18, after WP0**: added `src/deps.ts`, `src/schemas/result.ts`, `src/tools/index.ts` and the tool wiring convention; moved `ping` to `src/tools/ping.ts`. Added config keys for browser profile dir, screenshots, currency and per-role model overrides so WP4, WP6, WP10 and WP11 do not each edit `config.ts`. Pinned MCP SDK to the 1.32.x line for v1. Made `ANTHROPIC_API_KEY` optional at startup. Fixed `published_at` normalization. All raised by the WP0 implementer's report.
