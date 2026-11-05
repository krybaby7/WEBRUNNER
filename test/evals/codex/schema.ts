import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The phase 8 question set (PLAN.md 17.4, WP55): the owner's own questions
 * (U1, U2, ...), which the owner grades blind, and probes (P1, P2, ...), each
 * testing one ability with a check the owner can run on the day.
 *
 * Prompts are typed to the agent exactly as written, with nothing added.
 */

export const GROUPS = ["owner", "probe"] as const;
export type Group = (typeof GROUPS)[number];

export const QuestionSchema = z
  .object({
    id: z.string().regex(/^[UP][0-9]+$/, { error: "id must be U<n> for an owner question or P<n> for a probe" }),
    group: z.enum(GROUPS),
    prompt: z.string().min(10),
    /** What a good answer does. */
    good: z.string().min(10),
    /** Probes only: the one ability the prompt tests. */
    probes: z.string().min(1).optional(),
    /** Probes only: how the owner checks the answer on the day. */
    check: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const wantGroup: Group = q.id.startsWith("U") ? "owner" : "probe";
    if (q.group !== wantGroup) {
      ctx.addIssue({ code: "custom", path: ["group"], message: `${q.id} belongs to group "${wantGroup}"` });
    }
    if (q.group === "probe") {
      for (const key of ["probes", "check"] as const) {
        if (q[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `a probe needs "${key}"` });
      }
    }
  });
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionsFileSchema = z
  .array(QuestionSchema)
  .min(1)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [i, q] of items.entries()) {
      if (seen.has(q.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate question id "${q.id}"` });
      seen.add(q.id);
    }
  });

/** Default location of the question set, next to this file. */
export const QUESTIONS_PATH = new URL("./questions.json", import.meta.url);

/** Reads and validates the question set. Throws a readable error when invalid. */
export function loadQuestions(path: string | URL = QUESTIONS_PATH): Question[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = QuestionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid question set:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** The questions named in `only` (case-insensitive), in file order; throws on an unknown id. */
export function selectQuestions(all: readonly Question[], only: readonly string[] | undefined): Question[] {
  if (only === undefined || only.length === 0) return [...all];
  const wanted = new Set(only.map((id) => id.trim().toUpperCase()).filter((id) => id !== ""));
  const unknown = [...wanted].filter((id) => !all.some((q) => q.id === id));
  if (unknown.length > 0) throw new Error(`Unknown question id(s): ${unknown.join(", ")}`);
  return all.filter((q) => wanted.has(q.id));
}
