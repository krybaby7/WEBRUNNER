import {
  QUOTE_MAX_CHARS,
  type DeepResearchResult,
  type OutputFormat,
  type ResearchFinding,
  type ResearchSource,
} from "../../schemas/deep_research.js";
import { ResearchError, type Note } from "./types.js";

/** `[3]` and `[1, 2]`, the same forms the eval judge recognises. */
const CITATION_RE = /([ \t]*)\[(\d+(?:\s*,\s*\d+)*)\]/g;
const GAPS_HEADING = String.raw`^#{1,6}[ \t]*gaps\b[^\n]*$`;
const ANY_HEADING_RE = /^#{1,6}[ \t]+\S/m;

function idsOf(token: string): number[] {
  return token.split(",").map((p) => Number(p.trim()));
}

/** Distinct citation numbers in the order they first appear in the report. */
export function citationOrder(markdown: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const m of markdown.matchAll(CITATION_RE)) {
    for (const n of idsOf(m[2] ?? "")) {
      if (!seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
  }
  return order;
}

export interface RenumberResult {
  report_markdown: string;
  findings: ResearchFinding[];
  sources: ResearchSource[];
  /** Citation numbers in the report that matched no source. They are removed from the text. */
  dropped_citations: number[];
}

/**
 * Turns provisional ids into the final ones (PLAN.md 3.3 invariants).
 *
 * The writer cites notes by their provisional `source_id`. This assigns final
 * ids contiguously from 1 in first-citation order, rewrites every `[n]` token
 * in the report, remaps `findings[].source_ids`, and keeps only sources the
 * report cites. A finding whose sources were all dropped is dropped too. A
 * citation that matches no source is removed from the text and listed in
 * `dropped_citations`, so a made-up number never reaches the caller.
 */
export function renumberCitations(
  reportMarkdown: string,
  findings: readonly ResearchFinding[],
  sources: readonly ResearchSource[],
): RenumberResult {
  const known = new Map<number, ResearchSource>();
  for (const s of sources) if (!known.has(s.id)) known.set(s.id, s);

  const mapping = new Map<number, number>();
  const kept: ResearchSource[] = [];
  const dropped = new Set<number>();

  const report = reportMarkdown.replace(CITATION_RE, (_whole, lead: string, token: string) => {
    const mapped: number[] = [];
    for (const n of idsOf(token)) {
      const src = known.get(n);
      if (src === undefined) {
        dropped.add(n);
        continue;
      }
      let finalId = mapping.get(n);
      if (finalId === undefined) {
        finalId = kept.length + 1;
        mapping.set(n, finalId);
        kept.push({ ...src, id: finalId });
      }
      if (!mapped.includes(finalId)) mapped.push(finalId);
    }
    if (mapped.length === 0) return "";
    return `${lead}[${mapped.join(", ")}]`;
  });

  const remappedFindings: ResearchFinding[] = [];
  for (const f of findings) {
    const ids = [...new Set(f.source_ids.map((n) => mapping.get(n)).filter((n): n is number => n !== undefined))].sort(
      (a, b) => a - b,
    );
    if (ids.length === 0) continue;
    remappedFindings.push({ ...f, source_ids: ids });
  }

  return {
    report_markdown: report,
    findings: remappedFindings,
    sources: kept,
    dropped_citations: [...dropped].sort((a, b) => a - b),
  };
}

/**
 * Throws `ResearchError` `internal` when the result breaks a 3.3 invariant:
 * a `[n]` with no source, a finding that names a missing source, source ids
 * that are not contiguous from 1 in first-citation order, a source the report
 * never cites, or a report without a Gaps section.
 */
export function assertInvariants(result: Pick<DeepResearchResult, "report_markdown" | "findings" | "sources">): void {
  const problems: string[] = [];
  const ids = result.sources.map((s) => s.id);
  const idSet = new Set(ids);

  if (!ids.every((id, i) => id === i + 1)) {
    problems.push(`source ids are not contiguous from 1: [${ids.join(", ")}]`);
  }
  const cited = citationOrder(result.report_markdown);
  const dangling = cited.filter((n) => !idSet.has(n));
  if (dangling.length > 0) problems.push(`citations with no source: [${dangling.join(", ")}]`);

  const missing = [...new Set(result.findings.flatMap((f) => f.source_ids).filter((n) => !idSet.has(n)))];
  if (missing.length > 0) problems.push(`findings reference missing sources: [${missing.join(", ")}]`);

  if (dangling.length === 0 && !cited.every((n, i) => n === i + 1)) {
    problems.push(`sources are not numbered in first-citation order: citations appear as [${cited.join(", ")}]`);
  }
  const uncited = ids.filter((id) => !cited.includes(id));
  if (uncited.length > 0) problems.push(`sources never cited in the report: [${uncited.join(", ")}]`);

  if (!hasGapsSection(result.report_markdown)) problems.push("report has no Gaps section");

  if (problems.length > 0) {
    throw new ResearchError("internal", `Research result violates the citation invariants: ${problems.join("; ")}`, false, {
      problems,
    });
  }
}

export function hasGapsSection(markdown: string): boolean {
  return new RegExp(GAPS_HEADING, "im").test(markdown);
}

/**
 * Adds `lines` as bullets to the report's Gaps section, creating the section
 * at the end when the report has none. Lines already present are skipped.
 */
export function addGapLines(markdown: string, lines: readonly string[]): string {
  const fresh = lines.filter((l) => l.trim() !== "" && !markdown.includes(l));
  if (fresh.length === 0) return markdown;
  const bullets = fresh.map((l) => `- ${l}`).join("\n");

  let last: RegExpMatchArray | undefined;
  for (const m of markdown.matchAll(new RegExp(GAPS_HEADING, "gim"))) last = m;
  if (last?.index === undefined) {
    return `${markdown.trimEnd()}\n\n## Gaps\n\n${bullets}\n`;
  }
  const bodyStart = last.index + last[0].length;
  const rest = markdown.slice(bodyStart);
  const next = ANY_HEADING_RE.exec(rest);
  const bodyEnd = next === null ? markdown.length : bodyStart + next.index;
  const body = markdown.slice(bodyStart, bodyEnd).trimEnd();
  const tail = markdown.slice(bodyEnd);
  return `${markdown.slice(0, bodyStart)}${body}\n${bullets}\n${tail === "" ? "" : `\n${tail}`}`;
}

/** Truncates to the quote limit. A quote that is too long is cut, never rejected. */
export function clipQuote(quote: string): string {
  const q = quote.trim();
  return q.length <= QUOTE_MAX_CHARS ? q : q.slice(0, QUOTE_MAX_CHARS).trimEnd();
}

export interface DraftReport {
  report_markdown: string;
  findings: ResearchFinding[];
  /** Sources with provisional ids, ready for `renumberCitations`. */
  sources: ResearchSource[];
}

const FALLBACK_MAX_CLAIMS: Record<OutputFormat, number> = { report: 40, brief: 8 };

/**
 * A report built from notes without a model: a bulleted list of claims with
 * citations. Used when the writer is refused by the budget or returns nothing
 * citable. Ids are provisional.
 */
export function buildFallbackReport(args: {
  question: string;
  output: OutputFormat;
  notes: readonly Note[];
  gaps: readonly string[];
}): DraftReport {
  const ranked = args.notes
    .flatMap((n) => n.claims.map((c) => ({ note: n, claim: c })))
    .sort((a, b) => b.note.relevance - a.note.relevance || a.note.source_id - b.note.source_id);
  const picked = ranked.slice(0, FALLBACK_MAX_CLAIMS[args.output]);

  const lines = [
    `# ${args.question}`,
    "",
    "A written summary was not available, so these are the claims extracted from the sources, most relevant first.",
    "",
    ...picked.map(({ note, claim }) => `- ${claim.text} [${note.source_id}]`),
    "",
    "## Gaps",
    "",
    ...args.gaps.map((g) => `- ${g}`),
    "",
  ];

  const findings: ResearchFinding[] = picked.map(({ note, claim }) => ({
    claim: claim.text,
    confidence: claim.confidence,
    source_ids: [note.source_id],
    ...(claim.quote !== "" && { quote: clipQuote(claim.quote) }),
  }));
  const usedIds = new Set(picked.map((p) => p.note.source_id));
  const sources = args.notes
    .filter((n) => usedIds.has(n.source_id))
    .map((n) => noteToSource(n, `Supplied ${n.claims.length} extracted claim${n.claims.length === 1 ? "" : "s"}.`));
  return { report_markdown: lines.join("\n"), findings, sources };
}

export function noteToSource(note: Note, usedFor: string): ResearchSource {
  return {
    id: note.source_id,
    url: note.url,
    title: note.title,
    accessed_at: note.accessed_at,
    ...(note.published_at !== undefined && { published_at: note.published_at }),
    used_for: usedFor,
  };
}

/** The report for a run that found nothing to write about. */
export function buildNoResultsReport(question: string, gaps: readonly string[]): string {
  return [
    `# ${question}`,
    "",
    "No usable sources were found for this question, so there is nothing to report.",
    "",
    "## Gaps",
    "",
    ...gaps.map((g) => `- ${g}`),
    "",
  ].join("\n");
}
