import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { AccountsInputSchema } from "../../src/schemas/accounts.js";
import { BrowseTaskInputSchema } from "../../src/schemas/browse_task.js";
import { DeepResearchInputSchema } from "../../src/schemas/deep_research.js";
import { FetchPageInputSchema } from "../../src/schemas/fetch_page.js";
import { SearchFlightsInputSchema } from "../../src/schemas/flights.js";
import { ExchangeRateInputSchema } from "../../src/schemas/fx.js";
import { SearchHotelsInputSchema } from "../../src/schemas/hotels.js";
import { MarketQuoteInputSchema } from "../../src/schemas/markets.js";
import { SearchReviewsInputSchema } from "../../src/schemas/reviews.js";
import { SocialSearchInputSchema } from "../../src/schemas/social.js";
import { WeatherInputSchema } from "../../src/schemas/weather.js";
import { WebSearchInputSchema } from "../../src/schemas/web_search.js";
import { TOOL_NAMES } from "../../src/tools/index.js";

/**
 * Every example call in the README is marked `<!-- example: <tool> -->` right
 * before its ```json fence. This test parses each one against that tool's
 * input schema, so the documentation cannot drift from the contracts.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

/** Tools that take input, with the schema the README example must satisfy. `ping` and `health` take none. */
const INPUT_SCHEMAS: Record<string, ZodType> = {
  web_search: WebSearchInputSchema,
  fetch_page: FetchPageInputSchema,
  deep_research: DeepResearchInputSchema,
  browse_task: BrowseTaskInputSchema,
  search_flights: SearchFlightsInputSchema,
  search_hotels: SearchHotelsInputSchema,
  market_quote: MarketQuoteInputSchema,
  weather: WeatherInputSchema,
  exchange_rate: ExchangeRateInputSchema,
  social_search: SocialSearchInputSchema,
  search_reviews: SearchReviewsInputSchema,
  accounts: AccountsInputSchema,
};
const NO_INPUT = new Set(["ping", "health"]);

interface Example {
  tool: string;
  line: number;
  json: string;
}

/** `<!-- example: name -->`, optional blank lines, then a ```json fence up to the closing fence. */
function extractExamples(markdown: string): Example[] {
  const out: Example[] = [];
  const re = /<!--\s*example:\s*([a-z_]+)\s*-->\s*\n```json\n([\s\S]*?)\n```/g;
  for (const match of markdown.matchAll(re)) {
    const before = markdown.slice(0, match.index);
    out.push({ tool: match[1] as string, line: before.split("\n").length, json: match[2] as string });
  }
  return out;
}

const examples = extractExamples(readme);

describe("README examples", () => {
  it("has at least one marked example for every tool that takes input, and none for a tool that does not exist", () => {
    const tools = new Set(examples.map((e) => e.tool));
    for (const name of TOOL_NAMES) {
      if (NO_INPUT.has(name)) continue;
      expect(tools, `README has no <!-- example: ${name} --> block`).toContain(name);
    }
    for (const tool of tools) {
      expect(TOOL_NAMES, `README example marker names an unknown tool: ${tool}`).toContain(tool);
      expect(INPUT_SCHEMAS, `no input schema registered in this test for ${tool}`).toHaveProperty(tool);
    }
  });

  it("marks only ```json fences (a marker that is not followed by one is a mistake)", () => {
    const markers = [...readme.matchAll(/<!--\s*example:\s*([a-z_]+)\s*-->/g)];
    expect(markers.length).toBe(examples.length);
  });

  for (const example of examples) {
    it(`${example.tool} example at line ${example.line} parses against ${example.tool}'s input schema`, () => {
      let value: unknown;
      try {
        value = JSON.parse(example.json);
      } catch (err) {
        throw new Error(`README line ${example.line}: not valid JSON: ${String(err)}`, { cause: err });
      }
      const schema = INPUT_SCHEMAS[example.tool] as ZodType;
      const parsed = schema.safeParse(value);
      const issues = parsed.success ? "" : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      expect(parsed.success, `README line ${example.line}: ${issues}`).toBe(true);
    });
  }
});
