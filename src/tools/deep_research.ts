import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runResearch, ResearchError, type ResearchDeps } from "../core/research/index.js";
import { LlmError } from "../core/llm/types.js";
import type { Deps } from "../deps.js";
import {
  DeepResearchInputSchema,
  DeepResearchResultSchema,
  type DeepResearchInput,
  type DeepResearchResult,
} from "../schemas/deep_research.js";
import { toolError } from "../schemas/error.js";
import { jsonResult } from "../schemas/result.js";

const DESCRIPTION =
  "Multi-step web research that returns a cited report. The server plans sub-queries, searches several providers, reads the best pages, reflects on what is still missing and repeats, then writes a Markdown report with inline [n] citations, a findings list, a numbered source list and a mandatory Gaps section for what could not be established. " +
  "depth sets the effort: quick (4 searches, 6 pages, one pass; about $0.10 to $0.30), standard (default; 12 searches, 20 pages, up to 3 passes; about $0.50 to $1.50) or deep (30 searches, 50 pages, up to 6 passes; about $1.50 to $4.00). " +
  "max_cost_usd is a hard cap on LLM spend for the call (default from the server's RESEARCH_MAX_COST_USD); when it is reached the tool returns what it has and says so in the gaps. " +
  "Calls take from under a minute (quick) to several minutes (deep). stats.stopped_reason tells why the loop ended: converged, iterations, budget, searches, reads, no_results or error. " +
  'Use focus_domains, exclude_domains and recency to steer sources, and output "brief" for about 300 words. For a single known URL use fetch_page; for a plain lookup use web_search. Requires ANTHROPIC_API_KEY and at least one search provider key.';

/** The research entry point; tests inject a fake. Production uses `runResearch`. */
export type DeepResearchRunner = (input: DeepResearchInput, deps: ResearchDeps) => Promise<DeepResearchResult>;

export function registerDeepResearchTool(server: McpServer, deps: Deps, runner: DeepResearchRunner = runResearch): void {
  server.registerTool(
    "deep_research",
    {
      title: "Deep research",
      description: DESCRIPTION,
      inputSchema: DeepResearchInputSchema,
      outputSchema: DeepResearchResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (deps.config.anthropic_api_key === undefined) {
        return toolError("config", "ANTHROPIC_API_KEY is not set; deep_research needs the Claude API", false);
      }
      const { search, fetch, llm } = deps;
      if (search === undefined || fetch === undefined || llm === undefined) {
        return toolError("internal", "The search service, fetch service or LLM client is not available.", false);
      }

      const started = Date.now();
      const capUsd = args.max_cost_usd ?? deps.config.research_max_cost_usd;
      // The question is user content: lengths only at info level, text at debug.
      deps.log.info("deep_research started", {
        question_chars: args.question.length,
        depth: args.depth,
        max_cost_usd: capUsd,
      });
      deps.log.debug("deep_research question", { question: args.question });

      try {
        const result = await runner(args, { search, fetch, llm, log: deps.log, config: deps.config });
        deps.log.info("deep_research finished", {
          stopped_reason: result.stats.stopped_reason,
          cost_usd: result.stats.cost_usd,
          elapsed_ms: Date.now() - started,
        });
        return jsonResult(result);
      } catch (err) {
        deps.log.info("deep_research failed", {
          error_code: err instanceof ResearchError || err instanceof LlmError ? err.code : "internal",
          elapsed_ms: Date.now() - started,
        });
        if (err instanceof ResearchError || err instanceof LlmError) {
          return toolError(err.code, err.message, err.retryable, err.details);
        }
        const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
        deps.log.error("deep_research failed unexpectedly", { error: message });
        return toolError("internal", `deep_research failed: ${message}`, false);
      }
    },
  );
}
