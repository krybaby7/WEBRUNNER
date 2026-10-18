import { describe, expect, it } from "vitest";
import { fuseResults } from "../../../src/core/search/fusion.js";
import type { RawResult } from "../../../src/core/search/types.js";

function r(url: string, rank: number, extra: Partial<RawResult> = {}): RawResult {
  return { url, title: `t${rank}`, snippet: `s${rank}`, rank, ...extra };
}

const rrf = (rank: number): number => 1 / (60 + rank);

describe("fuseResults", () => {
  // Three providers, overlapping. Canonical forms: a, b, c, d, e.
  const brave: RawResult[] = [
    r("https://www.a.com/page/?utm_source=x", 1, { title: "A", snippet: "short" }),
    r("https://b.com/post", 2, { title: "B from brave, the longest title of all", snippet: "b snippet" }),
    r("https://c.com/", 3, { title: "C", snippet: "c snippet from brave", publishedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  const exa: RawResult[] = [
    r("https://b.com/post#frag", 1, { title: "B exa", snippet: "a much longer snippet from exa for b" }),
    r("https://a.com/page", 2, { title: "A with a longer title", snippet: "longer a snippet" }),
    r("https://d.com/x", 3, { title: "D", snippet: "d" }),
  ];
  const tavily: RawResult[] = [
    r("https://a.com/page?ref=news", 1, { title: "A tavily", snippet: "" }),
    r("https://c.com", 2, { title: "", snippet: "", publishedAt: "2026-01-15T00:00:00.000Z" }),
    r("https://e.com/z", 3, { title: "E", snippet: "e" }),
  ];

  const fused = fuseResults(
    [
      { provider: "brave", results: brave },
      { provider: "exa", results: exa },
      { provider: "tavily", results: tavily },
    ],
    10,
  );

  it("dedupes by canonical URL and outputs the canonical form", () => {
    expect(fused.map((f) => f.url)).toEqual([
      "https://a.com/page",
      "https://b.com/post",
      "https://c.com/",
      "https://d.com/x",
      "https://e.com/z",
    ]);
  });

  it("records every contributing provider", () => {
    const byUrl = Object.fromEntries(fused.map((f) => [f.url, f.providers]));
    expect(byUrl["https://a.com/page"]).toEqual(["brave", "exa", "tavily"]);
    expect(byUrl["https://b.com/post"]).toEqual(["brave", "exa"]);
    expect(byUrl["https://c.com/"]).toEqual(["brave", "tavily"]);
    expect(byUrl["https://d.com/x"]).toEqual(["exa"]);
    expect(byUrl["https://e.com/z"]).toEqual(["tavily"]);
  });

  it("sums reciprocal rank scores with k = 60 and sorts descending", () => {
    const scores = Object.fromEntries(fused.map((f) => [f.url, f.score]));
    expect(scores["https://a.com/page"]).toBeCloseTo(rrf(1) + rrf(2) + rrf(1), 8);
    expect(scores["https://b.com/post"]).toBeCloseTo(rrf(2) + rrf(1), 8);
    expect(scores["https://c.com/"]).toBeCloseTo(rrf(3) + rrf(2), 8);
    expect(scores["https://d.com/x"]).toBeCloseTo(rrf(3), 8);
    expect(scores["https://e.com/z"]).toBeCloseTo(rrf(3), 8);
    const sorted = [...fused].sort((x, y) => y.score - x.score);
    expect(fused.map((f) => f.url)).toEqual(sorted.map((f) => f.url));
  });

  it("breaks score ties by URL", () => {
    // d.com/x and e.com/z both score rrf(3); d sorts first.
    const urls = fused.map((f) => f.url);
    expect(urls.indexOf("https://d.com/x")).toBeLessThan(urls.indexOf("https://e.com/z"));
  });

  it("keeps the longest non-empty title and snippet among duplicates", () => {
    const a = fused.find((f) => f.url === "https://a.com/page");
    expect(a?.title).toBe("A with a longer title");
    expect(a?.snippet).toBe("longer a snippet");
    const b = fused.find((f) => f.url === "https://b.com/post");
    expect(b?.title).toBe("B from brave, the longest title of all");
    expect(b?.snippet).toBe("a much longer snippet from exa for b");
    const c = fused.find((f) => f.url === "https://c.com/");
    expect(c?.title).toBe("C");
    expect(c?.snippet).toBe("c snippet from brave");
  });

  it("keeps the earliest publishedAt, and omits the field when none is known", () => {
    const c = fused.find((f) => f.url === "https://c.com/");
    expect(c?.published_at).toBe("2026-01-15T00:00:00.000Z");
    const d = fused.find((f) => f.url === "https://d.com/x");
    expect(d).not.toHaveProperty("published_at");
  });

  it("truncates to maxResults after sorting", () => {
    const top2 = fuseResults(
      [
        { provider: "brave", results: brave },
        { provider: "exa", results: exa },
        { provider: "tavily", results: tavily },
      ],
      2,
    );
    expect(top2.map((f) => f.url)).toEqual(["https://a.com/page", "https://b.com/post"]);
    expect(fuseResults([{ provider: "brave", results: brave }], 0)).toEqual([]);
  });

  it("is independent of provider order in the scores and ordering", () => {
    const reversed = fuseResults(
      [
        { provider: "tavily", results: tavily },
        { provider: "exa", results: exa },
        { provider: "brave", results: brave },
      ],
      10,
    );
    expect(reversed.map((f) => [f.url, f.score])).toEqual(fused.map((f) => [f.url, f.score]));
  });

  it("counts a provider once per canonical URL, at its best rank", () => {
    const out = fuseResults(
      [
        {
          provider: "brave",
          results: [r("https://x.com/a", 1), r("https://x.com/a/", 2), r("https://y.com/", 3)],
        },
      ],
      10,
    );
    expect(out[0]?.url).toBe("https://x.com/a");
    expect(out[0]?.score).toBeCloseTo(rrf(1), 8);
    expect(out[0]?.providers).toEqual(["brave"]);
  });

  it("handles empty input", () => {
    expect(fuseResults([], 10)).toEqual([]);
    expect(fuseResults([{ provider: "brave", results: [] }], 10)).toEqual([]);
  });

  it("skips results with an empty URL", () => {
    expect(fuseResults([{ provider: "brave", results: [r("", 1), r("   ", 2)] }], 10)).toEqual([]);
  });
});
