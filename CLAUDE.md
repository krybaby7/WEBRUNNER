# CLAUDE.md

webrunner is a local MCP server (TypeScript, Node 22+, stdio only) that gives Claude Code and Codex web search, page fetching, server-side deep research, live browsing, and live-data and opinion tools (flights, hotels, market quotes, weather, exchange rates, social search, reviews) read through APIs or the owner's own browser profile. It is a personal tool for one owner, never a hosted service.

- **stdout is the MCP protocol channel.** Never write to stdout in `src/` (no `console.log`, no `process.stdout.write`). All logging goes to stderr through `src/log.ts`. A single stray line breaks the server; a test and a lint rule enforce this.
- **Before committing, run `npm run lint && npm run typecheck && npm test`.** `npm test` builds first.
- **`PLAN.md` is the source of truth** for tool contracts (section 3), internal interfaces (section 4), configuration (4.8) and costs (section 10). Do not change an exported interface in `src/core/*/types.ts` or `src/schemas/*` without first changing `PLAN.md` in its own PR. Work on one work package per branch (`wp<N>-<slug>`), touching only the files its brief allows.
- **Integration tests are gated** behind `RUN_INTEGRATION=1`, and evals behind `RUN_EVALS=1` (`npm run eval:research`); both spend real money or hit real services. Unit tests must run offline.
- Never commit keys. Use `<your-key>` placeholders in docs and redact secrets from fixtures.
- Config is read in `src/config.ts` (environment, then `~/.config/webrunner/config.json`); tools get it through `Deps`.
- **The opinion tools (`social_search`, `search_reviews`) and every browser recipe read passively.** They navigate, scroll and read through whatever session the browser profile already has; they never type, log in, post, like, follow or reply (tests spy on `fill`/`type`/`press`). A login wall is a `blocked` error with `needsLogin: true` that names the `accounts` tool; a CAPTCHA or checkpoint is `blocked`. Cookie values never appear in a result or a log line: `BrowserSession.cookies()` drops them at the source, and `accounts` and `health` report platform names only.
