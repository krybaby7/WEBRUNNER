# MCP TypeScript SDK v2: migration evaluation

Status: evaluation only. Nothing in this repository has been migrated.
Written 2026-10-18 against `@modelcontextprotocol/sdk` 1.32.1 (the version installed here).

## Recommendation

Stay on 1.32.x for the first release, then migrate in one dedicated pull request before v1.x support ends (no earlier than 2027-01-27). The migration is small and mostly mechanical (about 12 source files and 7 test files, a codemod exists), so the real cost is the risk of client compatibility, which can be checked in an afternoon. There is no feature this server needs from v2 today, and the 1.x line is still receiving fixes. Prepare now by making the one tool that still passes a raw zod shape (`ping`) pass `z.object(...)` instead, which works on both lines (`health` already does).

## What the sources say

Read for this evaluation:

1. The README shipped in the installed package, `node_modules/@modelcontextprotocol/sdk/README.md` (v1.32.1). Its banner says this is "the maintenance line", that it implements the MCP spec up to 2025-11-25, that support for the 2026-07-28 spec "is not planned for v1.x", that v2 is "the current stable release" shipped as `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, and that v1.x "continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)". Its `package.json` peer range for zod is `^3.25 || ^4.0`. The installed package carries no separate changelog file; the banner is the only v2 note.
2. The v2 migration guide, https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 (fetched in three passes, whole page covered; the content below is a summary produced by the fetch tool, not a verbatim read).
3. The repository README on the default branch, https://github.com/modelcontextprotocol/typescript-sdk (`main` is v2; `v1.x` is a branch; the minimal v2 stdio example is quoted below).

Not read: the separate guide for the 2026-07-28 spec era that the migration page links to, and the v2 API reference. Anything about wire-level behavior under that spec is therefore unverified here.

## What changes from 1.32.x

Surface this project uses, and the v2 equivalent:

| Area | v1 (1.32.x, current) | v2 |
|---|---|---|
| Packages | `@modelcontextprotocol/sdk` | `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/core` (zod `*Schema` constants). Both lines can be installed side by side, but objects must not cross between them (`instanceof` fails). |
| `McpServer` | `@modelcontextprotocol/sdk/server/mcp.js` | `import { McpServer } from '@modelcontextprotocol/server'` |
| `registerTool` | `inputSchema` / `outputSchema` as a zod raw shape or `z.object` | Expects Standard Schema objects (`z.object(...)`). Raw shapes still work through deprecated overloads that wrap them. Zod 3 is dropped. Zod 4.2.0 or later is recommended; zod 4.0 and 4.1 fall back to a bundled copy, lose `.describe()` text and log a warning. This repo uses zod 4.6.7. The `.tool()`, `.prompt()` and `.resource()` variadic methods are removed (not used here). |
| Tool callback | `(args, extra)`; `extra.signal` | `(args, ctx)`; `extra.signal` becomes `ctx.mcpReq.signal`. A tool registered with no input schema receives `ctx` as its only argument. |
| Stdio | `@modelcontextprotocol/sdk/server/stdio.js` | `@modelcontextprotocol/server/stdio` (not exported from the root). New `maxBufferSize` option, default 10 MB. Non-JSON lines on input are skipped rather than erroring. |
| Tests | `Client` from `.../client/index.js`, `InMemoryTransport` from `.../inMemory.js` | `Client` from `@modelcontextprotocol/client`; `InMemoryTransport` is exported by both packages, each with its own private state, so both halves of a linked pair must come from the same package. |
| Types | `CallToolResult` from `.../types.js` | Types, error classes and guards come from `@modelcontextprotocol/server` or `/client`. |
| `structuredContent` | an object | typed `unknown`; presence checks must be `!== undefined`. Non-object `outputSchema` roots are allowed. |
| Advertised schemas | `tools/list` JSON Schema as v1 emits it | JSON Schema 2020-12 with different `additionalProperties` handling. Any golden assertion on `inputSchema` needs re-baselining. |
| Unknown tool | `tools/call` resolves with `isError: true` | The client rejects with `ProtocolError(-32602)`. |
| Errors | `McpError` | `ProtocolError` (wire), `SdkError` (local), `SdkHttpError`. |
| Node | 18+ | 20+ (this project requires 22). ESM-first with a CJS build. |
| Spec | 2025-11-25 | 2026-07-28. Roots, sampling and logging are deprecated under SEP-2577 (this server uses none). |
| Tooling | | `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` rewrites most imports and marks the rest with `@mcp-codemod-error`. |

The v2 minimal stdio server from the repository README, for comparison with `src/server.ts` and `src/index.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'greeting-server', version: '1.0.0' });
server.registerTool('greet', { description: 'Greet someone by name', inputSchema: z.object({ name: z.string() }) },
  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }));
await server.connect(new StdioServerTransport());
```

## What would change here, file by file

Dependencies
- `package.json`: replace `@modelcontextprotocol/sdk` with `@modelcontextprotocol/server`; add `@modelcontextprotocol/client` as a devDependency for the tests. `package-lock.json` regenerates. `engines.node` (>=22) already satisfies v2.

Source (12 files import the SDK)
- `src/server.ts`: `McpServer` import path.
- `src/index.ts`: `StdioServerTransport` from `@modelcontextprotocol/server/stdio`.
- `src/schemas/result.ts`, `src/schemas/error.ts`: `CallToolResult` type import. `structuredContent` becomes `unknown`; both helpers only construct results, so no logic change expected.
- `src/tools/index.ts`, `ping.ts`, `web_search.ts`, `fetch_page.ts`, `browse_task.ts`, `deep_research.ts`, `search_flights.ts`, `health.ts`: `McpServer` type import path.
- `src/tools/ping.ts`: `outputSchema` is currently a raw zod shape; change to `z.object({...})` to avoid the deprecated overload. This change is valid on 1.32.x too and can land first. (`health.ts` already uses `z.object`.)
- `src/tools/search_flights.ts`: `extra.signal` becomes `ctx.mcpReq.signal` (one use, in the per-source timeout). The tool's input schema is already a `z.object`, so it needs no change.
- The other tools already pass `z.object` schemas and already have an input schema, so their callback signatures are unaffected.

Tests (7 files import the SDK)
- `test/unit/tools/helpers.ts`, `test/unit/search/web_search_tool.test.ts`, `test/unit/fetch/fetch_page_tool.test.ts`, `test/unit/research/deep_research_tool.test.ts`, `test/unit/flights/search_flights_tool.test.ts`, `test/unit/browser/agent.test.ts`: import paths for `Client`, `InMemoryTransport` and `McpServer`. Each file must take `InMemoryTransport` from one package for both halves.
- Review anything asserting the advertised `inputSchema` shape, `structuredContent` truthiness, or the result of calling an unknown tool.
- `test/unit/stdout-purity.test.ts` and `test/unit/deep_research_e2e.test.ts` spawn the built server and speak raw JSON-RPC with `protocolVersion: "2025-06-18"`. They exercise the legacy handshake, which the guide says v2 keeps; they are the tests that would catch a handshake regression.

Docs
- `PLAN.md` section 1 (the DECIDED bullet on the SDK line) and the decision log, plus any README or CLAUDE.md mention of "1.32.x", to be updated by whoever owns those files at the time.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude Code or Codex versions that the owner runs fail to negotiate with a v2 server | Low to medium (unverified: the guide says the legacy `initialize` handshake still works, but I did not test any real client) | Server unusable until rolled back | Run the stdio end-to-end tests, then `claude mcp add` and a Codex session against the migrated build before merging. Keep the change in one revertable PR. |
| Advertised tool schemas change (JSON Schema 2020-12, different `additionalProperties`) | Certain | Clients may see different schemas; golden tests break | Re-baseline tests; check a real client lists all tools with their descriptions. |
| zod handling: `.describe()` text lost on zod 4.0 to 4.1 | None here (zod 4.6.7) | Tool parameter descriptions would silently vanish | Keep zod at 4.2.0 or later; add a test that a described field appears in `tools/list`. |
| Behavior of invalid input and thrown handler errors differs from v1 | Unknown (the guide excerpt did not describe handler exceptions) | The envelope audit test (`test/unit/tools/envelope.test.ts`) is the guard: every tool already catches its own errors | Run that test and the per-tool tests first after the swap. |
| Package churn: three new packages (`server`, `client`, `core`) in the lockfile | Certain | Larger dependency review | `core` is only needed if zod `*Schema` constants are imported, which this project does not do. |
| Waiting too long: v1 stops receiving fixes | Date-driven | Unpatched SDK in a tool that fetches arbitrary web content | Migrate before 2027-01-27 at the latest, and move earlier if a security advisory appears for v1. |

## Reasons for the recommendation

- No needed capability. This is a local stdio server with six request/response tools. The v2 additions the guide describes (2026-07-28 spec era, `input_required` rounds, stateless HTTP topologies, framework adapters) are about remote or multi-round deployments, which the plan excludes (stdio only for v1).
- v1 is supported for at least six months after 2026-07-27, so there is no emergency, and the 1.x line is what every test and doc here was built against.
- The migration is cheap and well defined, so deferring it does not compound: the code only touches the SDK at import paths, one `extra.signal` use and one raw-shape schema. Doing it as its own PR after the first release keeps the release diff clean and lets the owner verify real clients once.
- There is a deadline, so "never" is not an option. Scheduling it before 2027-01-27 avoids running a server that reads arbitrary web pages on an SDK with no security updates.

Suggested sequence when it is scheduled: land the `z.object` outputSchema change on 1.32.x, run the codemod on a branch, fix the `ctx.mcpReq.signal` site and the test imports, run `npm run lint && npm run typecheck && npm test`, then check Claude Code and Codex against the built server.
