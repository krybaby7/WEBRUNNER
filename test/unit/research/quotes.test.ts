import { describe, expect, it } from "vitest";
import {
  FUZZY_MIN_MATCH_PERCENT,
  MIN_FRAGMENT_CHARS,
  checkClaimQuotes,
  emptyQuoteTally,
  makeQuoteChecker,
  normalizeForMatch,
  quoteNeedle,
} from "../../../src/core/research/quotes.js";
import type { NoteClaim } from "../../../src/core/research/types.js";

// Spelled as code points so the test says which character it means.
const ch = (cp: number): string => String.fromCodePoint(cp);
const NBSP = ch(0x00a0);
const ZWSP = ch(0x200b);
const LSQUO = ch(0x2018);
const RSQUO = ch(0x2019);
const LDQUO = ch(0x201c);
const RDQUO = ch(0x201d);
const EN_DASH = ch(0x2013);
const EM_DASH = ch(0x2014);
const MINUS = ch(0x2212);
const ELLIPSIS = ch(0x2026);

const PAGE = [
  "# Canberra: the capital of Australia",
  "",
  "Published: 2024-05-01",
  "",
  "Canberra is the **capital city** of [Australia](https://en.wikipedia.org/wiki/Australia_(country)). It is the largest",
  "inland city in the country.",
  "",
  "- Canberra was selected as the site of the national capital in 1908.",
  "- Canberra's population was about 456,000 at the 2021 census.",
  "",
  "The site was chosen as a compromise between Sydney and Melbourne, the two largest cities, which were rivals.",
  'Locals called it "the bush capital" for decades.',
  "",
  "| Year | Event |",
  "| --- | --- |",
  "| 1913 | The city was named and construction began. |",
  "",
  "Canberra is not the largest city in Australia by population; Sydney is.",
  `The \`Parliament House\` building opened in 1988 ${EM_DASH} replacing the _provisional_ one.`,
  "Winter nights often fall to -5 degrees.",
  "Lake Burley Griffin (filled in 1964) lies at the centre of the city.",
].join("\n");

const check = makeQuoteChecker(PAGE);

describe("normalizeForMatch", () => {
  it("reduces Markdown, quote marks, dashes, spaces and case", () => {
    expect(normalizeForMatch("**Bold** and _em_ and `code` and ~~gone~~")).toBe("bold and em and code and gone");
    expect(normalizeForMatch("[Link text](https://a.org/x_(y)) and ![alt text](img.png)")).toBe("link text and alt text");
    expect(normalizeForMatch(`${LDQUO}Quoted${RDQUO} and ${LSQUO}single${RSQUO} and it${RSQUO}s`)).toBe("quoted and single and its");
    expect(normalizeForMatch(`1990${EN_DASH}2000, a ${EM_DASH} b, ${MINUS}5, c -- d`)).toBe("1990-2000, a-b,-5, c-d");
    expect(normalizeForMatch(`a${NBSP}b${ZWSP}c \n\t d`)).toBe("a bc d");
    expect(normalizeForMatch(`wait${ELLIPSIS}`)).toBe("wait...");
    expect(normalizeForMatch("## Heading\n- bullet\n> quoted\n| a | b |\n|---|---|")).toBe("heading bullet quoted a b");
    expect(normalizeForMatch("1,000 and 2 500 000 and 3.5 and 1,5")).toBe("1000 and 2500000 and 3.5 and 1,5");
    expect(normalizeForMatch("snake\\_case 1\\. AT&amp;T a[12] b")).toBe("snakecase 1. at&t a b");
  });

  it("never removes a digit, so a number cannot vanish from a quote", () => {
    expect(normalizeForMatch("1. First item\n2) Second")).toBe("1. first item 2) second");
    expect(quoteNeedle("(1908.)")).toBe("1908");
  });
});

describe("makeQuoteChecker", () => {
  it("passes a quote copied exactly", () => {
    expect(check("Canberra was selected as the site of the national capital in 1908.")).toBe("exact");
  });

  it("passes curly quotes and apostrophes against straight ones", () => {
    expect(check(`Canberra${RSQUO}s population was about 456,000 at the 2021 census.`)).toBe("normalized");
    expect(check(`Locals called it ${LDQUO}the bush capital${RDQUO} for decades.`)).toBe("normalized");
    // A model that swaps the inner double quotes for single ones inside its JSON string.
    expect(check("Locals called it 'the bush capital' for decades.")).toBe("normalized");
  });

  it("passes a quote whose page span holds a Markdown link and emphasis", () => {
    expect(check("Canberra is the capital city of Australia.")).toBe("normalized");
    expect(check("The Parliament House building opened in 1988 - replacing the provisional one.")).toBe("normalized");
  });

  it("passes collapsed whitespace and line breaks", () => {
    expect(check("It is the largest inland city in the country.")).toBe("normalized");
    expect(check(`It is the  largest${NBSP}inland\ncity in the country.`)).toBe("normalized");
  });

  it("passes a table row read without its pipes", () => {
    expect(check("1913 The city was named and construction began.")).toBe("normalized");
  });

  it("passes a quote that skips a parenthetical, but not one that adds to it", () => {
    expect(check("Lake Burley Griffin (filled in 1964) lies at the centre of the city.")).toBe("exact");
    expect(check("Lake Burley Griffin lies at the centre of the city.")).toBe("normalized");
    expect(check("Lake Burley Griffin (filled in 1963) lies at the centre of the city.")).toBe("unverified");
  });

  it("passes an ellipsis-stitched quote whose fragments appear in order", () => {
    expect(
      check(`The site was chosen as a compromise ${ELLIPSIS} the two largest cities, which were rivals.`),
    ).toBe("stitched");
    expect(check("The site was chosen as a compromise [...] the two largest cities, which were rivals.")).toBe("stitched");
    // A short connective fragment is not evidence and need not be found.
    expect(check("In short... the site was chosen as a compromise between Sydney and Melbourne")).toBe("stitched");
  });

  it("fails an ellipsis-stitched quote whose fragments are out of order or carry a wrong number", () => {
    expect(check("the two largest cities, which were rivals ... The site was chosen as a compromise")).toBe("unverified");
    // "in 1907" is short but carries a number, so it must be found.
    expect(check("Canberra was selected as the site of the national capital ... in 1907")).toBe("unverified");
    // No fragment is long enough to be evidence.
    expect(check("It is ... the largest ... inland city")).toBe("unverified");
  });

  it("passes a one-word slip in a longer quote", () => {
    // "the" dropped before "national".
    expect(check("Canberra was selected as the site of national capital in 1908.")).toBe("fuzzy");
    // "a" for "the".
    expect(check("Canberra was selected as a site of the national capital in 1908.")).toBe("fuzzy");
    // A list marker the model kept when it flattened two bullets onto one line.
    expect(
      check("Canberra was selected as the site of the national capital in 1908. - Canberra's population was about 456,000"),
    ).toBe("fuzzy");
  });

  it("passes a number-format slip", () => {
    expect(check("Canberra's population was about 456000 at the 2021 census.")).toBe("normalized");
    expect(check(`Canberra's population was about 456${NBSP}000 at the 2021 census.`)).toBe("normalized");
    expect(check(`Winter nights often fall to ${MINUS}5 degrees.`)).toBe("normalized");
  });

  it("fails an invented quote", () => {
    expect(check("Canberra was designed by Walter Burley Griffin after an international competition.")).toBe("unverified");
  });

  it("never lets the fuzzy tier change a number or drop a negation", () => {
    expect(check("Canberra was selected as the site of the national capital in 1909.")).toBe("unverified");
    expect(check("Canberra's population was about 465,000 at the 2021 census.")).toBe("unverified");
    expect(check("Canberra is the largest city in Australia by population; Sydney is.")).toBe("unverified");
  });

  it("never lets the fuzzy tier add or change a word of substance", () => {
    // A changed verb.
    expect(check("Canberra was chosen as the site of the national capital in 1908.")).toBe("unverified");
    // A swapped subject, one word in seven.
    expect(check("Sydney is the capital city of Australia.")).toBe("unverified");
    // An added name.
    expect(check("Canberra was selected as the site of the national capital in 1908 by parliament.")).toBe("unverified");
  });

  it("gives a short quote no fuzzy edits", () => {
    expect(Math.floor((6 * (100 - FUZZY_MIN_MATCH_PERCENT)) / 100)).toBe(0);
    expect(check("Canberra was the capital city")).toBe("unverified");
  });

  it("reports an empty quote as empty", () => {
    expect(check("")).toBe("empty");
    expect(check("   ")).toBe("empty");
  });

  it("uses a fragment threshold of about twenty characters", () => {
    expect(MIN_FRAGMENT_CHARS).toBe(20);
  });
});

describe("checkClaimQuotes", () => {
  const claim = (quote: string, confidence: NoteClaim["confidence"] = "high"): NoteClaim => ({
    text: `Claim for ${quote || "nothing"}`,
    quote,
    confidence,
  });

  it("keeps every claim: an invented quote becomes empty and its claim low confidence", () => {
    const tally = emptyQuoteTally();
    const out = checkClaimQuotes(
      [
        claim("Canberra was selected as the site of the national capital in 1908."),
        claim(`Canberra${RSQUO}s population was about 456,000 at the 2021 census.`, "medium"),
        claim("Canberra was selected as the site of national capital in 1908."),
        claim("Canberra was designed by Walter Burley Griffin after an international competition."),
        claim(""),
      ],
      PAGE,
      tally,
    );
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(claim("Canberra was selected as the site of the national capital in 1908."));
    expect(out[1]?.quote).toBe(`Canberra${RSQUO}s population was about 456,000 at the 2021 census.`);
    expect(out[1]?.confidence).toBe("medium");
    expect(out[2]?.confidence).toBe("high");
    expect(out[3]).toEqual({
      text: "Claim for Canberra was designed by Walter Burley Griffin after an international competition.",
      quote: "",
      confidence: "low",
    });
    expect(out[4]).toEqual({ text: "Claim for nothing", quote: "", confidence: "low" });
    expect(tally).toEqual({ checked: 4, exact: 1, lenient: 2, fuzzy: 1, unverified: 1, empty: 1 });
  });

  it("checks only the text it is given, so a quote from beyond a cut is unverified", () => {
    const cut = PAGE.slice(0, PAGE.indexOf("The site was chosen"));
    const out = checkClaimQuotes(
      [claim("The site was chosen as a compromise between Sydney and Melbourne, the two largest cities, which were rivals.")],
      cut,
      emptyQuoteTally(),
    );
    expect(out[0]).toMatchObject({ quote: "", confidence: "low" });
  });

  it("checks a long page quickly", () => {
    const filler = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} talks about something else entirely.`).join("\n");
    const big = `${filler}\n${PAGE}`;
    const quotes = Array.from({ length: 12 }, (_, i) => claim(`An invented sentence number ${i} that the page never contained at all, padded out.`));
    const t0 = performance.now();
    const out = checkClaimQuotes(quotes, big, emptyQuoteTally());
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out.every((c) => c.quote === "")).toBe(true);
  });
});
