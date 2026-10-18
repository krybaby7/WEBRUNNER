import type { z } from "zod";
import {
  DEPTH_BUDGETS,
  DeepResearchInputSchema,
  DeepResearchResultSchema,
  QUOTE_MAX_CHARS,
  type DeepResearchInput,
  type DeepResearchResult,
  type ResearchFinding,
  type ResearchSource,
  type StoppedReason,
} from "../../schemas/deep_research.js";
import type { FetchPageOutput } from "../../schemas/fetch_page.js";
import type { WebSearchOutput } from "../../schemas/web_search.js";
import { FetchServiceError } from "../fetch/index.js";
import { CostMeter } from "../llm/cost.js";
import { priceFor, resolveModel } from "../llm/models.js";
import { LlmError, type Effort, type Role } from "../llm/types.js";
import { canonicalizeUrl } from "../search/canonical.js";
import { normalizePublishedAt } from "../search/normalize.js";
import { SearchError } from "../search/index.js";
import {
  ExtractSchema,
  PROMPT_VERSION,
  PlanSchema,
  ScoreSchema,
  WriterSchema,
  extractorPrompt,
  plannerPrompt,
  scorerPrompt,
  writerPrompt,
  type Extraction,
  type Plan,
  type Prompt,
  type WriterOutput,
} from "./prompts.js";
import { makeRedactor } from "./redact.js";
import {
  addGapLines,
  assertInvariants,
  buildFallbackReport,
  buildNoResultsReport,
  clipQuote,
  hasGapsSection,
  noteToSource,
  renumberCitations,
  type DraftReport,
} from "./report.js";
import { ResearchError, type Candidate, type Note, type PlanStep, type ResearchDeps } from "./types.js";

/** Search results requested per sub-query. */
const RESULTS_PER_SEARCH = 10;
/** A candidate scoring below this is dropped. */
const MIN_CANDIDATE_SCORE = 5;
/** A note whose page scored below this is dropped. */
const MIN_NOTE_RELEVANCE = 4;
/** Candidates per scorer call. Keeps the scorer prompt far under 100K tokens. */
const SCORE_BATCH_SIZE = 40;
const READ_CONCURRENCY = 3;
const READ_MAX_CHARS = 60_000;
const MAX_STEPS_PER_ROUND = 6;
const MAX_CLAIMS_PER_NOTE = 12;
/** An iteration that adds fewer claims than this ends the loop. */
const MIN_NEW_CLAIMS = 2;
const PLANNER_MAX_TOKENS = 16_000;
const EXTRACTOR_MAX_TOKENS = 8192;
const WRITER_MAX_TOKENS = 32_000;
/** Rough size of the writer's answer, used to keep money back for it. */
const WRITER_OUTPUT_TOKENS_ESTIMATE: Record<"report" | "brief", number> = { report: 8000, brief: 2500 };

/**
 * Runs the research loop of PLAN.md section 5 and returns a complete
 * `DeepResearchResult`, including the written report.
 *
 * Throws `ResearchError` when nothing useful can be produced: the LLM or the
 * search is not configured, or a provider failed before any source was found.
 * Hitting a limit is not an error: the result carries `stats.stopped_reason`.
 */
export async function runResearch(input: DeepResearchInput, deps: ResearchDeps): Promise<DeepResearchResult> {
  const parsedInput = DeepResearchInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const issues = parsedInput.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
    throw new ResearchError("internal", `Invalid deep_research input: ${issues.join("; ")}`, false);
  }
  const req = parsedInput.data;
  const { log, config } = deps;
  const now = deps.now ?? Date.now;
  const redact = makeRedactor(config);
  const started = now();
  const budget = DEPTH_BUDGETS[req.depth];
  const maxCostUsd = req.max_cost_usd ?? config.research_max_cost_usd;
  const meter = new CostMeter({ maxCostUsd });
  // Quick depth writes with the Sonnet-class model (PLAN.md 3.3 table). The
  // writer role is routed to Opus, so the `extractor` role stands in for it.
  const writerRole: Role = budget.writerRole;

  log.debug("research start", {
    prompt_version: PROMPT_VERSION,
    depth: req.depth,
    output: req.output,
    max_cost_usd: maxCostUsd,
    max_searches: budget.searches,
    max_pages: budget.pages,
    max_iterations: budget.iterations,
  });

  // ---- run state ----------------------------------------------------------
  let searches = 0;
  let pagesRead = 0;
  let pagesFailed = 0;
  let iterations = 0;
  const notes: Note[] = [];
  let nextSourceId = 1;
  /** Every canonical URL ever seen as a candidate or read: nothing is scored or read twice. */
  const seen = new Set<string>();
  /** Scored candidates that passed but have not been read yet. */
  let backlog: Candidate[] = [];
  const queriesRun: string[] = [];
  const queriesSeen = new Set<string>();
  let openGaps: string[] = [];
  const engineGaps: string[] = [];
  let stopped: StoppedReason | undefined;
  let stopNote: string | undefined;

  // ---- helpers ------------------------------------------------------------

  async function ask<S extends z.ZodType>(
    role: Role,
    prompt: Prompt,
    schema: S,
    opts: { effort: Effort; maxTokens: number },
  ): Promise<z.output<S>> {
    const res = await deps.llm.complete({
      role,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      schema,
      effort: opts.effort,
      maxTokens: opts.maxTokens,
      meter,
    });
    const checked = schema.safeParse(res.parsed);
    if (!checked.success) {
      throw new LlmError("provider", "schema", `The ${role} model returned output that does not match the expected schema`, {
        retryable: false,
      });
    }
    return checked.data;
  }

  const isBudgetError = (err: unknown): err is LlmError => err instanceof LlmError && err.code === "budget_exceeded";

  function fromLlmError(err: LlmError): ResearchError {
    return new ResearchError(err.code, redact(err.message), err.retryable, { kind: err.kind });
  }

  /** Estimated cost of the writer call, so the loop can leave room for it. */
  function writerReserveUsd(): number {
    const price = priceFor(resolveModel(writerRole, config), log);
    const notesChars = notes.reduce(
      (n, note) => n + note.claims.reduce((m, c) => m + c.text.length + c.quote.length + 40, 200),
      0,
    );
    const inputTokens = notesChars / 3.5 + 2500;
    const outputTokens = WRITER_OUTPUT_TOKENS_ESTIMATE[req.output];
    return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  }

  /**
   * Stops the loop early when what is left of the budget would not cover the
   * writer. The meter lets a call that starts under the cap finish over it, but
   * refuses every call once the cap is reached, so the writer needs headroom.
   */
  function guardWriterReserve(): void {
    if (notes.length > 0 && meter.remainingUsd < writerReserveUsd()) {
      throw new LlmError("budget_exceeded", "api", "Not enough budget left for the report writer", {
        retryable: false,
        details: { remaining_usd: meter.remainingUsd, max_cost_usd: maxCostUsd },
      });
    }
  }

  function normalizeSteps(steps: PlanStep[]): PlanStep[] {
    const out: PlanStep[] = [];
    for (const s of steps) {
      const query = s.query.trim();
      const key = query.toLowerCase();
      if (query === "" || queriesSeen.has(key)) continue;
      queriesSeen.add(key);
      out.push({ query, rationale: s.rationale });
      if (out.length >= MAX_STEPS_PER_ROUND) break;
    }
    return out;
  }

  async function plan(round: number): Promise<Plan> {
    return ask(
      "planner",
      plannerPrompt({
        question: req.question,
        recency: req.recency,
        focusDomains: req.focus_domains,
        excludeDomains: req.exclude_domains,
        notes,
        gaps: openGaps,
        previousQueries: queriesRun,
        round,
        maxRounds: budget.iterations,
        searchesLeft: budget.searches - searches,
      }),
      PlanSchema,
      { effort: "high", maxTokens: PLANNER_MAX_TOKENS },
    );
  }

  type SearchOutcome =
    | { ok: true; query: string; output: WebSearchOutput }
    | { ok: false; query: string; code: "config" | "provider" | "timeout" };

  async function runSearch(query: string): Promise<SearchOutcome> {
    try {
      const output = await deps.search.search({
        query,
        max_results: RESULTS_PER_SEARCH,
        ...(req.recency !== undefined && { recency: req.recency }),
        ...(req.focus_domains !== undefined && { include_domains: req.focus_domains }),
        ...(req.exclude_domains !== undefined && { exclude_domains: req.exclude_domains }),
      });
      return { ok: true, query, output };
    } catch (err) {
      const code = err instanceof SearchError ? err.code : "provider";
      log.warn("research search failed", {
        query,
        code,
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return { ok: false, query, code };
    }
  }

  /** Scores new candidates in batches. Candidates the scorer cannot score pass with the minimum score. */
  async function scoreCandidates(fresh: Candidate[]): Promise<Candidate[]> {
    const batches: Candidate[][] = [];
    for (let i = 0; i < fresh.length; i += SCORE_BATCH_SIZE) batches.push(fresh.slice(i, i + SCORE_BATCH_SIZE));
    const settled = await Promise.allSettled(
      batches.map(async (batch) => {
        const out = await ask(
          "scorer",
          scorerPrompt({ question: req.question, recency: req.recency, candidates: batch }),
          ScoreSchema,
          { effort: "low", maxTokens: 8192 },
        );
        const byIndex = new Map<number, { score: number; reason: string }>();
        for (const s of out.scores) if (!byIndex.has(s.index)) byIndex.set(s.index, s);
        return batch.map((c, i): Candidate => {
          const s = byIndex.get(i);
          return { ...c, score: s === undefined ? 0 : clamp(s.score, 0, 10), reason: s?.reason ?? "not scored" };
        });
      }),
    );
    const scored: Candidate[] = [];
    let budgetError: LlmError | undefined;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        scored.push(...r.value);
        return;
      }
      if (isBudgetError(r.reason)) {
        budgetError ??= r.reason;
        return;
      }
      log.warn("research scoring failed, keeping the batch unscored", {
        error: redact(r.reason instanceof Error ? r.reason.message : String(r.reason)),
      });
      for (const c of batches[i] ?? []) scored.push({ ...c, score: MIN_CANDIDATE_SCORE, reason: "unscored" });
    });
    if (budgetError !== undefined) throw budgetError;
    return scored;
  }

  type ReadOutcome =
    | { kind: "failed" }
    | { kind: "read"; page: FetchPageOutput; candidate: Candidate; extraction?: Extraction; budgetError?: LlmError };

  async function readAndExtract(candidate: Candidate): Promise<ReadOutcome> {
    let page: FetchPageOutput;
    try {
      page = await deps.fetch.fetchPage({ url: candidate.url, mode: "auto", max_chars: READ_MAX_CHARS });
    } catch (err) {
      log.warn("research page fetch failed", {
        url: candidate.url,
        code: err instanceof FetchServiceError ? err.code : "internal",
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return { kind: "failed" };
    }
    if (page.markdown.trim() === "") return { kind: "read", page, candidate };
    try {
      const extraction = await ask(
        "extractor",
        extractorPrompt({
          question: req.question,
          url: page.final_url,
          title: page.title || candidate.title,
          markdown: page.markdown,
          truncated: page.truncated,
        }),
        ExtractSchema,
        { effort: "medium", maxTokens: EXTRACTOR_MAX_TOKENS },
      );
      return { kind: "read", page, candidate, extraction };
    } catch (err) {
      if (isBudgetError(err)) return { kind: "read", page, candidate, budgetError: err };
      log.warn("research extraction failed, skipping the page", {
        url: candidate.url,
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return { kind: "read", page, candidate };
    }
  }

  function toNote(outcome: Extract<ReadOutcome, { kind: "read" }>): Note | undefined {
    const { page, candidate, extraction } = outcome;
    if (extraction === undefined) return undefined;
    const relevance = clamp(extraction.relevance, 0, 10);
    const claims = extraction.claims
      .map((c) => ({ text: c.text.trim(), quote: clipQuote(c.quote), confidence: c.confidence }))
      .filter((c) => c.text !== "")
      .slice(0, MAX_CLAIMS_PER_NOTE);
    if (relevance < MIN_NOTE_RELEVANCE || claims.length === 0) return undefined;
    const published = normalizePublishedAt(extraction.published_at) ?? normalizePublishedAt(candidate.published_at);
    return {
      source_id: nextSourceId++,
      url: canonicalizeUrl(page.final_url || candidate.url),
      title: page.title.trim() || candidate.title || candidate.url,
      ...(published !== undefined && { published_at: published }),
      accessed_at: normalizePublishedAt(page.fetched_at) ?? new Date(now()).toISOString(),
      relevance,
      claims,
    };
  }

  // ---- the loop -----------------------------------------------------------

  let steps: PlanStep[] = [];
  const pagesPerIteration = Math.ceil(budget.pages / budget.iterations);

  try {
    for (let iteration = 1; iteration <= budget.iterations; iteration++) {
      iterations = iteration;

      if (iteration === 1) {
        const first = await plan(1);
        openGaps = first.gaps;
        steps = normalizeSteps(first.steps);
        if (steps.length === 0) {
          // A planner that returns nothing on the first round still gets one search: the question itself.
          const query = req.question.slice(0, 300);
          queriesSeen.add(query.toLowerCase());
          steps = [{ query, rationale: "The question as asked." }];
        }
      } else {
        guardWriterReserve();
      }

      // -- search
      const queries = steps.slice(0, Math.max(0, budget.searches - searches));
      for (const s of queries) queriesRun.push(s.query);
      searches += queries.length;
      const outcomes = await Promise.all(queries.map((s) => runSearch(s.query)));
      const failures = outcomes.filter((o) => !o.ok);
      if (outcomes.length > 0 && failures.length === outcomes.length) {
        const codes = new Set(failures.map((f) => (f.ok ? "provider" : f.code)));
        if (codes.size === 1 && codes.has("config")) {
          throw new ResearchError("config", "No search provider is configured. Set at least one search API key.", false);
        }
        if (notes.length === 0) {
          const timeoutOnly = codes.size === 1 && codes.has("timeout");
          throw new ResearchError(
            timeoutOnly ? "timeout" : "provider",
            "Every search failed, so there was nothing to research from. Try again shortly.",
            true,
          );
        }
        engineGaps.push("Searches failed in the last round, so some sub-questions were not researched.");
        stopped = "searches";
        break;
      }

      const fresh: Candidate[] = [];
      for (const o of outcomes) {
        if (!o.ok) continue;
        for (const r of o.output.results) {
          const url = canonicalizeUrl(r.url);
          if (seen.has(url)) continue;
          seen.add(url);
          const published = normalizePublishedAt(r.published_at);
          fresh.push({
            url,
            title: r.title,
            snippet: r.snippet,
            ...(published !== undefined && { published_at: published }),
          });
        }
      }

      // -- score
      const scored = fresh.length > 0 ? await scoreCandidates(fresh) : [];
      const passed = scored.filter((c) => (c.score ?? 0) >= MIN_CANDIDATE_SCORE);
      backlog = [...backlog, ...passed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      // -- read and extract
      if (backlog.length > 0) guardWriterReserve();
      const allowedByNow = Math.min(budget.pages, iteration * pagesPerIteration);
      const readCap = Math.max(0, allowedByNow - pagesRead);
      const maxAttempts = readCap * 2;
      let attempts = 0;
      let readThisIteration = 0;
      let failedThisIteration = 0;
      let newClaims = 0;
      let budgetError: LlmError | undefined;
      while (readThisIteration < readCap && backlog.length > 0 && attempts < maxAttempts && budgetError === undefined) {
        const take = Math.min(READ_CONCURRENCY, readCap - readThisIteration, maxAttempts - attempts);
        const wave = backlog.splice(0, take);
        attempts += wave.length;
        const results = await Promise.all(wave.map(readAndExtract));
        for (const r of results) {
          if (r.kind === "failed") {
            pagesFailed++;
            failedThisIteration++;
            continue;
          }
          pagesRead++;
          readThisIteration++;
          seen.add(canonicalizeUrl(r.page.final_url || r.candidate.url));
          if (r.budgetError !== undefined) {
            budgetError ??= r.budgetError;
            continue;
          }
          const note = toNote(r);
          if (note !== undefined) {
            notes.push(note);
            newClaims += note.claims.length;
          }
        }
      }

      log.info("research iteration", {
        iteration,
        searches,
        searches_failed: failures.length,
        candidates: fresh.length,
        candidates_passed: passed.length,
        pages_read: pagesRead,
        pages_failed: failedThisIteration,
        notes: notes.length,
        new_claims: newClaims,
        cost_usd: round6(meter.totalCostUsd),
      });

      if (budgetError !== undefined) throw budgetError;

      // -- stop conditions that need no model call
      if (searches >= budget.searches) stopped = "searches";
      else if (pagesRead >= budget.pages) stopped = "reads";
      else if (iteration >= budget.iterations) stopped = "iterations";
      else if (newClaims < MIN_NEW_CLAIMS) stopped = notes.length === 0 ? "no_results" : "converged";
      if (stopped !== undefined) break;

      // -- reflect
      guardWriterReserve();
      const next = await plan(iteration + 1);
      openGaps = next.gaps;
      steps = normalizeSteps(next.steps);
      if (next.stop || next.gaps.length === 0 || steps.length === 0) {
        stopped = "converged";
        break;
      }
    }
  } catch (err) {
    if (isBudgetError(err)) {
      stopped = "budget";
    } else if (err instanceof LlmError) {
      if (notes.length === 0) throw fromLlmError(err);
      log.warn("research stopped early after a model call failed", { code: err.code, kind: err.kind });
      engineGaps.push("Research stopped early because a model call failed, so some sub-questions were not researched.");
      stopped = "iterations";
    } else {
      throw err;
    }
  }

  stopped ??= "iterations";
  if (stopped === "budget") {
    engineGaps.push(
      `Research stopped early because the cost cap of $${maxCostUsd.toFixed(2)} was reached, so some sub-questions were not researched.`,
    );
  } else if (notes.length === 0) {
    stopped = "no_results";
  }
  if (notes.length === 0) {
    engineGaps.push("No sources relevant to the question could be found and read.");
  }
  if (stopped === "searches" || stopped === "reads" || stopped === "iterations") {
    const what = { searches: "search", reads: "page-read", iterations: "iteration" }[stopped];
    stopNote = `Research stopped because the ${what} limit for this depth was reached, so open gaps may remain.`;
  }

  // ---- write --------------------------------------------------------------

  /** Writes the report, or builds one from the notes when the writer cannot. Ids in the draft are final. */
  async function writeReport(): Promise<{ draft: DraftReport; gaps: string[] }> {
    const fallback = (): { draft: DraftReport; gaps: string[] } => {
      const built = buildFallbackReport({ question: req.question, output: req.output, notes, gaps: openGaps });
      const renumbered = renumberCitations(built.report_markdown, built.findings, built.sources);
      return { draft: renumbered, gaps: [] };
    };
    let out: WriterOutput;
    try {
      out = await ask(
        writerRole,
        writerPrompt({
          question: req.question,
          output: req.output,
          notes,
          gaps: openGaps,
          stopNote,
          recency: req.recency,
          today: new Date(now()).toISOString().slice(0, 10),
        }),
        WriterSchema,
        { effort: "high", maxTokens: WRITER_MAX_TOKENS },
      );
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      if (err.code === "budget_exceeded") {
        if (stopped !== "budget") {
          stopped = "budget";
          engineGaps.push(
            `Research stopped early because the cost cap of $${maxCostUsd.toFixed(2)} was reached, so some sub-questions were not researched.`,
          );
        }
        engineGaps.push("The report is a list of extracted claims because the cost cap left no budget for a written summary.");
      } else {
        log.warn("research writer failed, using the extracted claims", { error: redact(err.message) });
        engineGaps.push("The report writer failed, so the report is a list of extracted claims rather than a written summary.");
      }
      return fallback();
    }

    const byId = new Map(notes.map((n) => [n.source_id, n]));
    const usedFor = new Map(out.source_notes.map((s) => [s.source_id, s.used_for.trim()]));
    const provisionalSources: ResearchSource[] = notes.map((n) =>
      noteToSource(n, usedFor.get(n.source_id) || "Cited in the report."),
    );
    const findings: ResearchFinding[] = out.findings
      .filter((f) => f.claim.trim() !== "")
      .map((f) => {
        const quote = verifiedQuote(f.quote, f.source_ids.map((id) => byId.get(id)));
        return {
          claim: f.claim.trim(),
          confidence: f.confidence,
          source_ids: [...new Set(f.source_ids)],
          ...(quote !== undefined && { quote }),
        };
      });

    const renumbered = renumberCitations(out.report_markdown, findings, provisionalSources);
    if (renumbered.sources.length === 0) {
      log.warn("research writer cited no known sources, using the extracted claims");
      engineGaps.push(
        "The report writer cited no sources, so the report is a list of extracted claims rather than a written summary.",
      );
      return fallback();
    }
    if (renumbered.dropped_citations.length > 0) {
      log.warn("research writer cited unknown sources, citations removed", { count: renumbered.dropped_citations.length });
      engineGaps.push(
        "Some citations in the report pointed to sources that do not exist and were removed, so the statements they followed may be unsourced.",
      );
    }
    return { draft: renumbered, gaps: out.gaps.map((g) => g.trim()).filter((g) => g !== "") };
  }

  let reportMarkdown: string;
  let findings: ResearchFinding[];
  let sources: ResearchSource[];
  let gaps: string[];
  if (notes.length === 0) {
    reportMarkdown = buildNoResultsReport(req.question, engineGaps);
    findings = [];
    sources = [];
    gaps = [...engineGaps];
  } else {
    const written = await writeReport();
    gaps = unique([...written.gaps, ...(written.gaps.length === 0 ? openGaps : []), ...engineGaps]);
    // A report that already has a Gaps section only needs the engine's own lines added to it.
    reportMarkdown = addGapLines(
      written.draft.report_markdown,
      hasGapsSection(written.draft.report_markdown) ? engineGaps : gaps,
    );
    findings = written.draft.findings;
    sources = written.draft.sources;
  }

  const usage = meter.totalUsage;
  const result: DeepResearchResult = {
    question: req.question,
    report_markdown: reportMarkdown,
    findings,
    sources,
    gaps,
    depth: req.depth,
    stats: {
      searches,
      pages_read: pagesRead,
      pages_failed: pagesFailed,
      iterations,
      input_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      output_tokens: usage.outputTokens,
      cost_usd: meter.totalCostUsd,
      elapsed_ms: Math.max(0, now() - started),
      stopped_reason: stopped,
    },
  };

  assertInvariants(result);
  const checked = DeepResearchResultSchema.safeParse(result);
  if (!checked.success) {
    throw new ResearchError("internal", `Research result does not match the output schema: ${checked.error.message}`, false);
  }

  log.info("research finished", {
    depth: req.depth,
    stopped_reason: stopped,
    searches,
    pages_read: pagesRead,
    pages_failed: pagesFailed,
    iterations,
    sources: sources.length,
    findings: findings.length,
    input_tokens: result.stats.input_tokens,
    output_tokens: result.stats.output_tokens,
    cost_usd: round6(result.stats.cost_usd),
    elapsed_ms: result.stats.elapsed_ms,
  });
  return checked.data;
}

// ---- small pure helpers ---------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The writer's quote, kept only when it is a span of a quote the extractor
 * recorded for one of the cited notes, so a judge can rely on it being verbatim.
 */
function verifiedQuote(quote: string | null, cited: Array<Note | undefined>): string | undefined {
  if (quote === null) return undefined;
  const wanted = normalizeText(quote);
  if (wanted === "") return undefined;
  for (const note of cited) {
    if (note === undefined) continue;
    for (const claim of note.claims) {
      if (normalizeText(claim.quote).includes(wanted)) return clipQuote(quote).slice(0, QUOTE_MAX_CHARS);
    }
  }
  return undefined;
}
