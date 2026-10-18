import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEPTHS } from "../../../src/schemas/deep_research.js";

/**
 * Shared types for the research eval set (PLAN.md WP9).
 *
 * The `deep_research` result schema and the depth type are the engine's own
 * (`src/schemas/deep_research.ts`); they are re-exported here so the runner and
 * the judge validate against exactly what the tool returns.
 */
export {
  DEPTHS,
  DeepResearchResultSchema,
  type DeepResearchResult,
  type Depth,
  type ResearchStats,
} from "../../../src/schemas/deep_research.js";

export const DepthSchema = z.enum(DEPTHS);

export const QUESTION_TYPES = [
  "recent_event",
  "technical_comparison",
  "numeric_fact",
  "multi_hop",
  "how_to",
  "controversial_or_contested",
] as const;
export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const CRITERION_KINDS = [
  "must_state",
  "must_cite",
  "must_not_claim",
  "must_quantify",
  "must_acknowledge_uncertainty",
] as const;
export const CriterionKindSchema = z.enum(CRITERION_KINDS);
export type CriterionKind = z.infer<typeof CriterionKindSchema>;

export const CriterionSchema = z.object({
  id: z.string().min(1),
  criterion: z.string().min(1),
  kind: CriterionKindSchema,
  weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export type Criterion = z.infer<typeof CriterionSchema>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const QuestionItemSchema = z
  .object({
    id: z.string().regex(SLUG, { error: "id must be a lowercase slug, for example recent-nodejs-latest-release" }),
    question: z.string().min(10),
    type: QuestionTypeSchema,
    depth: DepthSchema,
    rubric: z.array(CriterionSchema).min(3).max(6),
    /** Guidance for the human judge, and extra context for the model judge. */
    notes: z.string().min(1),
  })
  .superRefine((item, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of item.rubric.entries()) {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: "custom", path: ["rubric", i, "id"], message: `duplicate criterion id "${c.id}"` });
      }
      seen.add(c.id);
    }
  });
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

export const QuestionsFileSchema = z
  .array(QuestionItemSchema)
  .min(1)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [i, item] of items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate question id "${item.id}"` });
      }
      seen.add(item.id);
    }
  });

/** Default location of the question set, next to this file. */
export const QUESTIONS_PATH = new URL("./questions.json", import.meta.url);

/** Reads and validates the question set. Throws a readable error when invalid. */
export function loadQuestions(path: string | URL = QUESTIONS_PATH): QuestionItem[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = QuestionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid question set:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
