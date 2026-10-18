import { z } from "zod";
import { FlightsInputError } from "../../schemas/flights.js";
import { LlmError, type LlmClient } from "../llm/types.js";
import { resolveIata } from "./iata.js";

const PlaceAnswerSchema = z.object({
  iata: z.string().nullable().describe("3-letter IATA airport or metropolitan area code, or null when unsure"),
  confidence: z.enum(["high", "medium", "low"]),
  note: z.string().optional(),
});

const SYSTEM_PROMPT = [
  "You map a place name a traveller typed to the IATA code to search flights with.",
  "Answer with a 3-letter IATA airport code, or the IATA metropolitan area code for a city served by several airports (London is LON, New York is NYC).",
  "Set confidence to high only when exactly one code is right for the text. Use medium or low, with iata null or your best guess, when the text is ambiguous (for example a city name shared by several countries), misspelt beyond recognition, or not a place that has an airport.",
  "Never guess. A wrong code searches the wrong flights.",
].join("\n");

/**
 * Map free text ("London", "Heathrow", "Kraków") to an IATA code.
 *
 * 1. `resolveIata` (static table, no network).
 * 2. When that returns undefined, one `extractor` LLM call at low effort; only
 *    a `high` confidence 3-letter answer is accepted.
 * Anything else throws `FlightsInputError` (error code `invalid_input`) saying
 * what was tried. An LlmError other than "not configured" (budget, network)
 * propagates so the tool reports it by its own code.
 */
export async function resolvePlace(input: string, llm: LlmClient | undefined): Promise<string> {
  const text = input.trim();
  const fromTable = resolveIata(text);
  if (fromTable !== undefined) return fromTable;

  const tried = [`the built-in airport table had no unambiguous match for "${text}"`];
  if (llm === undefined) {
    tried.push("the LLM fallback is not available");
  } else {
    try {
      const response = await llm.complete({
        role: "extractor",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Place: ${text}` }],
        schema: PlaceAnswerSchema,
        effort: "low",
        maxTokens: 1000,
      });
      const answer = PlaceAnswerSchema.safeParse(response.parsed);
      if (answer.success) {
        const code = answer.data.iata?.trim().toUpperCase() ?? null;
        if (answer.data.confidence === "high" && code !== null && /^[A-Z]{3}$/.test(code)) return code;
        tried.push(
          `the LLM answered ${code ?? "no code"} with ${answer.data.confidence} confidence${answer.data.note ? ` (${answer.data.note})` : ""}, which is not certain enough`,
        );
      } else {
        tried.push("the LLM did not return a usable answer");
      }
    } catch (err) {
      if (err instanceof LlmError && err.kind === "not_configured") {
        tried.push("the LLM fallback needs ANTHROPIC_API_KEY, which is not set");
      } else {
        throw err;
      }
    }
  }
  throw new FlightsInputError(
    `Could not resolve "${text}" to an airport or city code: ${tried.join("; ")}. ` +
      `Pass a 3-letter IATA code (for example LHR or NYC) or a more specific name with the country ("Birmingham, UK").`,
  );
}
