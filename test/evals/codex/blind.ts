import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARMS } from "./arms.js";
import type { Question } from "./schema.js";

/**
 * Blind grading for the Codex question set (PLAN.md 17.4, WP55).
 *
 * The owner pastes Perplexity's answers into templates (`writePerplexityTemplates`),
 * then `blind` puts every answer to a question in one file under a letter, in
 * an order shuffled per question, with the key kept apart. The owner fills in
 * `grades.csv` without opening the key; `reveal` joins the two.
 */

/** Every source of answers: the Codex arms, and Perplexity pasted by hand. */
export const SOURCES = [...ARMS, "perplexity"] as const;
export type Source = (typeof SOURCES)[number];

export const BLIND_DIR = "blind";
export const KEY_FILE = "key.json";
export const GRADES_FILE = "grades.csv";
const LABELS = ["A", "B", "C", "D", "E"];

/** The first line of a Perplexity template. Everything below the template's comment lines is the answer. */
const TEMPLATE_MARK = "<!-- webrunner eval:";

export function perplexityTemplate(q: Pick<Question, "id" | "prompt">): string {
  return [
    `${TEMPLATE_MARK} paste Perplexity's whole answer to ${q.id} below these lines, citations included. -->`,
    `<!-- Prompt, typed exactly: ${q.prompt.replaceAll("--", "- -")} -->`,
    "",
  ].join("\n");
}

/** Writes one empty template per question into `<out>/perplexity/`, never over a file that exists. */
export function writePerplexityTemplates(out: string, questions: readonly Pick<Question, "id" | "prompt">[]): { written: string[]; kept: string[] } {
  const dir = join(out, "perplexity");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const kept: string[] = [];
  for (const q of questions) {
    const file = join(dir, `${q.id}.md`);
    if (existsSync(file)) {
      kept.push(q.id);
      continue;
    }
    writeFileSync(file, perplexityTemplate(q), "utf8");
    written.push(q.id);
  }
  const prompts = questions.map((q) => `${q.id}: ${q.prompt}`).join("\n\n");
  writeFileSync(join(dir, "prompts.md"), prompts + "\n", "utf8");
  return { written, kept };
}

/** The answer in an answer file: the text after any leading HTML comment lines (a template's), trimmed. */
export function answerText(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || (line.startsWith("<!--") && line.endsWith("-->"))) i += 1;
    else break;
  }
  return lines.slice(i).join("\n").trim();
}

/** The answer `source` gave to `id`, or undefined when there is none (no file, or an empty template). */
export function readAnswer(out: string, source: Source, id: string): string | undefined {
  const file = join(out, source, `${id}.md`);
  if (!existsSync(file)) return undefined;
  const text = answerText(readFileSync(file, "utf8"));
  return text !== "" ? text : undefined;
}

/** A product's name would unblind an answer; nothing else in the text is changed. */
export function maskNames(text: string): string {
  return text.replace(/\b(?:webrunner|perplexity)\b/gi, "[tool]");
}

/** The line that opens a numbered source list: "Citations:", "Sources:" or "References:". */
const CITATION_HEADER = /^\s*(?:citations|sources|references)\s*:?\s*$/i;
/** One entry of that list: "[3] https://...". */
const CITATION_LINE = /^\s*\[(\d+)\]\s+(https?:\/\/.+?)\s*$/;
/** One marker ("[3]" or "[web:3]") or several side by side, with the spaces before them; not "[3](url)", which is a link. */
const MARKER_RUN = /[ \t]*(?:\[(?:[a-z]+:)?\d+\][ \t]*)*\[(?:[a-z]+:)?\d+\](?!\()/g;
const MARKER = /\[(?:[a-z]+:)?(\d+)\]/g;

function citationLink(url: string): string {
  let label = "source";
  try {
    label = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // keep "source"
  }
  const dest = /[\s()<>]/.test(url) ? `<${url.replaceAll("<", "%3C").replaceAll(">", "%3E")}>` : url;
  return `[${label}](${dest})`;
}

/**
 * Numbered citations ("... rate [web:3][web:7]" over a "Citations:" list of
 * "[3] https://...") mark an answer as Perplexity's at a glance, where the Codex
 * arms link inside the text. This turns each marker into an inline link named
 * after its site, drops a link the line already holds, and removes the list.
 * Text without such a list at its end, or with anything else under the
 * list's heading, is returned unchanged. Used on the blind sheet only; the
 * saved answers keep their own form.
 */
export function inlineCitations(text: string): string {
  const lines = text.split("\n");
  let header = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CITATION_HEADER.test(lines[i] ?? "")) {
      header = i;
      break;
    }
  }
  if (header < 0) return text;
  const urls = new Map<string, string>();
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === "") continue;
    const m = CITATION_LINE.exec(line);
    if (m === null) return text;
    urls.set(m[1] as string, m[2] as string);
  }
  if (urls.size === 0) return text;
  const body = lines.slice(0, header).map((line) =>
    line.replace(MARKER_RUN, (run: string, offset: number) => {
      const cited = [...run.matchAll(MARKER)].map((m) => urls.get(m[1] as string));
      const links = [...new Set(cited.filter((u): u is string => u !== undefined && !line.includes(u)))].map(citationLink);
      if (links.length === 0) return "";
      return `${offset === 0 ? "" : " "}${links.join(" · ")}`;
    }),
  );
  return body.join("\n").trimEnd();
}

/** A small seeded generator (mulberry32), so a shuffle can be repeated from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

/** `items` in an order fixed by `seed` and `salt`. */
export function shuffled<T>(items: readonly T[], seed: number, salt: string): T[] {
  const next = rng(seed ^ hash(salt));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Question id -> letter -> source. */
export type BlindKey = Record<string, Record<string, Source>>;

export interface BlindResult {
  key: BlindKey;
  seed: number;
  /** Questions left out because fewer than two sources answered them. */
  skipped: string[];
  /** Question id -> sources with no answer. */
  missing: Record<string, Source[]>;
}

/**
 * Writes `<out>/blind/<id>.md` for every question that at least two sources
 * answered, the key to `<out>/blind/key.json` and an empty `grades.csv`.
 * An existing grades.csv is never overwritten.
 */
export function writeBlind(out: string, questions: readonly Question[], seed: number): BlindResult {
  const dir = join(out, BLIND_DIR);
  mkdirSync(dir, { recursive: true });
  const key: BlindKey = {};
  const skipped: string[] = [];
  const missing: Record<string, Source[]> = {};
  const gradeRows: string[] = ["question,answer,score,notes"];

  for (const q of questions) {
    const answers = SOURCES.map((source) => ({ source, text: readAnswer(out, source, q.id) }));
    const absent = answers.filter((a) => a.text === undefined).map((a) => a.source);
    if (absent.length > 0) missing[q.id] = absent;
    const present = answers.filter((a): a is { source: Source; text: string } => a.text !== undefined);
    if (present.length < 2) {
      skipped.push(q.id);
      continue;
    }
    const order = shuffled(present, seed, q.id);
    key[q.id] = {};
    const parts = [
      `# ${q.id}`,
      "",
      `**Prompt:** ${q.prompt}`,
      "",
      `**What a good answer does:** ${q.good}`,
      ...(q.check !== undefined ? ["", `**How to check it:** ${q.check}`] : []),
      "",
      "Grade each answer from 1 (useless or wrong) to 5 (as good as it gets) in grades.csv. Do not open key.json until every grade is in.",
    ];
    for (const [i, a] of order.entries()) {
      const label = LABELS[i] ?? String(i + 1);
      (key[q.id] as Record<string, Source>)[label] = a.source;
      parts.push("", "---", "", `## Answer ${label}`, "", maskNames(inlineCitations(a.text)));
      gradeRows.push(`${q.id},${label},,`);
    }
    writeFileSync(join(dir, `${q.id}.md`), parts.join("\n") + "\n", "utf8");
  }

  writeFileSync(join(dir, KEY_FILE), JSON.stringify({ seed, key }, null, 2) + "\n", "utf8");
  const grades = join(dir, GRADES_FILE);
  if (!existsSync(grades)) writeFileSync(grades, gradeRows.join("\n") + "\n", "utf8");
  return { key, seed, skipped, missing };
}

/** Parses CSV (RFC 4180: quoted cells, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface Grade {
  question: string;
  source: Source;
  score: number;
  notes: string;
}

export interface Reveal {
  grades: Grade[];
  /** Rows of grades.csv with no score yet, as "<question> <letter>". */
  ungraded: string[];
  /** Per source: answers graded, mean score, questions won (a tie shares the win). */
  bySource: Record<string, { graded: number; mean: number; wins: number }>;
}

/** Joins grades.csv with the key. Throws on a score outside 1 to 5 or a letter the key does not have. */
export function reveal(gradesCsv: string, key: BlindKey): Reveal {
  const [header, ...rows] = parseCsv(gradesCsv);
  const cols = (header ?? []).map((h) => h.trim().toLowerCase());
  const at = (name: string): number => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`grades.csv has no "${name}" column`);
    return i;
  };
  const [qi, ai, si, ni] = [at("question"), at("answer"), at("score"), cols.indexOf("notes")];
  const grades: Grade[] = [];
  const ungraded: string[] = [];
  for (const row of rows) {
    const question = (row[qi] ?? "").trim();
    const label = (row[ai] ?? "").trim().toUpperCase();
    const scoreText = (row[si] ?? "").trim();
    const source = key[question]?.[label];
    if (source === undefined) throw new Error(`grades.csv names ${question} ${label}, which the key does not have`);
    if (scoreText === "") {
      ungraded.push(`${question} ${label}`);
      continue;
    }
    const score = Number(scoreText);
    if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error(`${question} ${label}: score "${scoreText}" is not between 1 and 5`);
    grades.push({ question, source, score, notes: ni >= 0 ? (row[ni] ?? "").trim() : "" });
  }

  const bySource: Reveal["bySource"] = {};
  for (const g of grades) {
    const s = (bySource[g.source] ??= { graded: 0, mean: 0, wins: 0 });
    s.mean = (s.mean * s.graded + g.score) / (s.graded + 1);
    s.graded += 1;
  }
  const questions = [...new Set(grades.map((g) => g.question))];
  for (const q of questions) {
    const these = grades.filter((g) => g.question === q);
    const best = Math.max(...these.map((g) => g.score));
    const winners = these.filter((g) => g.score === best);
    for (const w of winners) (bySource[w.source] as { wins: number }).wins += 1 / winners.length;
  }
  return { grades, ungraded, bySource };
}

/** The reveal as Markdown: a per-source summary, then every grade by question. */
export function formatReveal(r: Reveal): string {
  const lines = ["| Source | Answers graded | Mean score | Questions won |", "|---|---|---|---|"];
  for (const [source, s] of Object.entries(r.bySource).sort(([, a], [, b]) => b.mean - a.mean)) {
    lines.push(`| ${source} | ${s.graded} | ${s.mean.toFixed(2)} | ${Number.isInteger(s.wins) ? s.wins : s.wins.toFixed(1)} |`);
  }
  lines.push("", "| Question | Source | Score | Notes |", "|---|---|---|---|");
  const sorted = [...r.grades].sort((a, b) => a.question.localeCompare(b.question, "en", { numeric: true }) || b.score - a.score);
  for (const g of sorted) lines.push(`| ${g.question} | ${g.source} | ${g.score} | ${g.notes.replaceAll("|", "\\|").replaceAll("\n", " ")} |`);
  if (r.ungraded.length > 0) lines.push("", `Not graded yet: ${r.ungraded.join(", ")}`);
  return lines.join("\n");
}
