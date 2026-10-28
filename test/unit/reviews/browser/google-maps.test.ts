import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bestResultIndex,
  buildGoogleMapsSearchUrl,
  createGoogleMapsReviewsRecipe,
  googleMapsReviewsRecipe,
  isGoogleMapsUrl,
  mapsSearchText,
} from "../../../../src/core/browser/recipes/google-maps-reviews.js";
import { RecipeError } from "../../../../src/core/browser/recipes/types.js";
import { createBrowserSession } from "../../../../src/core/browser/session.js";
import type { BrowserSession } from "../../../../src/core/browser/types.js";
import { APPROXIMATE_DATE_CAVEAT } from "../../../../src/core/reviews/relative-date.js";
import { GoogleMapsReviewSource } from "../../../../src/core/reviews/sources/google-maps.js";
import { CONSENT_CAVEAT, SubjectNotFoundError } from "../../../../src/core/reviews/sources/shared-browser.js";
import { ReviewSourceError } from "../../../../src/core/reviews/types.js";
import { ReviewSchema, ReviewSubjectSchema } from "../../../../src/schemas/reviews.js";
import { makeConfig, makeTempDir, probeChromium, removeDir } from "../../browser/helpers.js";
import { makeQuery, neverLlm, promptOf, runRecipe, scriptedLlm, startReviewsServer, type ReviewsFixtureServer } from "./helpers.js";

const probe = await probeChromium();
const DAY = 86_400_000;

describe("Google Maps result matching", () => {
  it("keeps Google's first result unless a later one carries every word of the name and the first, in the same script, does not (live lists, 2026-10-28)", () => {
    expect(bestResultIndex("Koshary El Tahrir", ["Al Tahreer Koshary Restaurant", "Koshary El Tahrir"])).toBe(1);
    // The Downtown branch is first under an Arabic name; Google ranked it by location, so it stays.
    expect(bestResultIndex("Koshary Sayed Hanafy", ["كشرى سيد حنفي - دار القضاء العالى - وسط البلد", "Sayed Hanafy Koshary - Hassan Maamon", "كشري سيد حنفي مدينة نصر"])).toBe(0);
    expect(bestResultIndex("Hotel Lutetia", ["Hôtel Lutetia", "Hôtel Bel Ami", "Hotel Montalembert"])).toBe(0);
    expect(bestResultIndex("Hotel Montalembert", ["Hôtel Lutetia", "Hotel Montalembert"])).toBe(1);
    expect(bestResultIndex("Koshary", ["Koshary Abou Tarek", "Koshary El Tahrir"])).toBe(0);
    expect(bestResultIndex("Nothing alike", ["Koshary Abou Tarek", "Koshary El Tahrir"])).toBe(0);
    expect(bestResultIndex("Anything", [])).toBe(0);
  });
});

describe("Google Maps URL helpers", () => {
  it("builds the search URL from subject and location with hl=en", () => {
    expect(buildGoogleMapsSearchUrl({ subject: "Hotel Lutetia", location: "Paris" })).toBe(
      "https://www.google.com/maps/search/Hotel%20Lutetia%20Paris?hl=en",
    );
    expect(buildGoogleMapsSearchUrl({ subject: "Café Flore" })).toBe("https://www.google.com/maps/search/Caf%C3%A9%20Flore?hl=en");
    expect(mapsSearchText({ subject: "A", location: "B" })).toBe("A B");
    expect(googleMapsReviewsRecipe.buildUrl?.(makeQuery({ subject: "Hotel Lutetia", location: "Paris" }))).toBe(
      "https://www.google.com/maps/search/Hotel%20Lutetia%20Paris?hl=en",
    );
  });

  it("recognises Maps URLs and opens them directly, in English", () => {
    expect(isGoogleMapsUrl("https://www.google.com/maps/place/H%C3%B4tel+Lutetia/@48.85,2.32,17z")).toBe(true);
    expect(isGoogleMapsUrl("https://google.fr/maps/search/x")).toBe(true);
    expect(isGoogleMapsUrl("https://maps.app.goo.gl/abc")).toBe(true);
    expect(isGoogleMapsUrl("https://www.google.com/travel/flights")).toBe(false);
    expect(isGoogleMapsUrl("https://www.amazon.com/dp/B0B2FCT81R")).toBe(false);
    expect(isGoogleMapsUrl(undefined)).toBe(false);
    const url = "https://www.google.com/maps/place/H%C3%B4tel+Lutetia/data=!4m2!3m1!1s0x0";
    expect(googleMapsReviewsRecipe.buildUrl?.(makeQuery({ subject: url, subject_url: url }))).toBe(`${url}?hl=en`);
    expect(googleMapsReviewsRecipe.buildUrl?.(makeQuery({ subject: "https://www.amazon.com/dp/B0B2FCT81R", subject_url: "https://www.amazon.com/dp/B0B2FCT81R" }))).toBeNull();
  });
});

describe.skipIf(!probe.available)(`google-maps-reviews recipe in Chromium${probe.available ? "" : ` (${probe.reason})`}`, () => {
  let server: ReviewsFixtureServer;
  let session: BrowserSession;
  let profileDir: string;

  beforeAll(async () => {
    server = await startReviewsServer();
    profileDir = await makeTempDir();
    session = createBrowserSession(makeConfig(profileDir));
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (profileDir) await removeDir(profileDir);
  }, 30_000);

  const recipe = (over: Parameters<typeof createGoogleMapsReviewsRecipe>[0] = {}) =>
    createGoogleMapsReviewsRecipe({ searchBaseUrl: `${server.url}/maps/search/`, pollMs: 50, maxWaitMs: 8000, reviewsWaitMs: 1500, ...over });

  it("opens the first result, dismisses consent (reject preferred), reads the reviews tab, scrolls and expands", async () => {
    const t0 = Date.now();
    const llm = neverLlm();
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Hotel Lutetia", location: "Paris", sources: ["google_maps"] }), llm, {}, (page) =>
      page.evaluate<string | null>(`document.documentElement.getAttribute("data-consent")`),
    );
    expect(r.error).toBeUndefined();
    expect(r.after).toBe("rejected");
    expect(r.caveats).toContain(CONSENT_CAVEAT);
    expect(r.caveats).toContain(APPROXIMATE_DATE_CAVEAT);
    expect(llm.calls).toHaveLength(0);
    expect(r.spy.forbidden).toEqual([]);
    expect(server.requests.some((x) => x.startsWith("GET /maps/search/Hotel%20Lutetia%20Paris?hl=en"))).toBe(true);
    expect(server.requests.some((x) => x.startsWith("GET /maps/place/"))).toBe(true);

    const { subject, reviews } = r.result!;
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
    expect(subject).toMatchObject({
      source: "google_maps",
      name: "Hôtel Lutetia",
      rating_avg: 4.6,
      review_count: 1234,
      address: "45 Boulevard Raspail, 75006 Paris, France",
      categories: ["5-star hotel"],
      price_level: "$$$$",
    });
    expect(subject.url?.startsWith(server.url)).toBe(true);

    // 5 cards at first, 9 after one scroll, 12 after two, no more after the third: per_source 15 is not reached.
    expect(reviews).toHaveLength(12);
    for (const review of reviews) {
      expect(ReviewSchema.safeParse(review).success).toBe(true);
      expect(review.source).toBe("google_maps");
      expect(review.rating).toBeGreaterThanOrEqual(1);
      expect(review.rating).toBeLessThanOrEqual(5);
      expect(review.text.length).toBeGreaterThan(0);
      expect(review.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(review.id).toMatch(/^google_maps:Ch[A-Za-z0-9]+$/);
    }
    expect(new Set(reviews.map((x) => x.id)).size).toBe(12);

    const marie = reviews[0]!;
    expect(marie).toMatchObject({
      id: "google_maps:ChdDSUhNMG9nS0VJQ0FnSUM1a09xY3B3RRAB",
      author: "Marie D.",
      rating: 5,
      helpful_votes: 3,
      url: "https://www.google.com/maps/contrib/100000/reviews",
      truncated: false,
    });
    // "More" was clicked: the hidden tail of the text is present.
    expect(marie.text).toContain("jazz bar is a lovely place");
    expect(marie.text).not.toContain("…");
    expect(Math.abs(Date.parse(marie.created_at!) - (t0 - 60 * DAY))).toBeLessThan(60_000);
    expect(marie.response?.text).toBe("Thank you Marie, we look forward to welcoming you again.");
    expect(Math.abs(Date.parse(marie.response!.created_at!) - (t0 - 30 * DAY))).toBeLessThan(60_000);

    const luc = reviews.find((x) => x.author === "Luc Moreau")!;
    expect(luc.rating).toBe(2);
    expect(luc.helpful_votes).toBe(0);
    expect(luc.text).toContain("concierge did help");
    expect(Math.abs(Date.parse(luc.created_at!) - (t0 - DAY))).toBeLessThan(60_000);
    expect(reviews.find((x) => x.author === "Tom Becker")?.response).toBeUndefined();
    const olga = reviews.find((x) => x.author === "Olga S.")!;
    expect(Math.abs(Date.parse(olga.created_at!) - (t0 - 2 * DAY))).toBeLessThan(60_000);
    expect(reviews.find((x) => x.author === "Jean-Pierre L.")?.rating).toBe(5);
  });

  it("stops scrolling once per_source is reached", async () => {
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Direct Place", per_source: 4 }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.result!.reviews).toHaveLength(4);
    expect(r.result!.reviews[0]?.author).toBe("Marie D.");
    expect(r.caveats).toContain(CONSENT_CAVEAT);
  });

  it("opens the closest match from a list, not the first, and reads the place's own panel with its hours (live layout, 2026-10-28)", async () => {
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Koshary El Midan", location: "Downtown", sources: ["google_maps"] }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.spy.forbidden).toEqual([]);
    expect(server.requests.some((x) => x.startsWith("GET /maps/place/Koshary+El+Midan/"))).toBe(true);
    expect(server.requests.some((x) => x.startsWith("GET /maps/place/Al+Meedan"))).toBe(false);
    expect(r.caveats).toContain('Google Maps listed 2 places for this search; the reviews are for "Koshary El Midan", the one whose name matches.');

    const { subject, reviews } = r.result!;
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
    // The list's "Results" heading and its first card (3.9 from 5,052) are still on the page above the place.
    expect(subject).toMatchObject({
      source: "google_maps",
      name: "Koshary El Midan",
      rating_avg: 4.1,
      review_count: 6074,
      address: "19 Abd El-Khalik Tharwat, Bab Al Louq, Abdeen, Cairo Governorate",
      categories: ["Egyptian restaurant"],
    });
    expect(subject.hours).toEqual([
      "Monday: 9 AM to 12 AM",
      "Tuesday: 9 AM to 12 AM",
      "Wednesday: 9 AM to 12 AM",
      "Thursday: 9 AM to 12 AM",
      "Friday: Closed",
      "Saturday: 9 AM to 2 AM",
      "Sunday: 9 AM to 12 AM",
    ]);
    expect(reviews.map((x) => x.author)).toEqual(["Hana Z.", "Mostafa R.", "Clara W.", "Youssef N."]);
    expect(reviews[0]).toMatchObject({ rating: 5, url: "https://www.google.com/maps/contrib/300000" });
  });

  it("reads the hours from the hidden table when the per-day buttons are missing", async () => {
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Koshary El Midan", location: "Table", sources: ["google_maps"] }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.result!.subject.name).toBe("Koshary El Midan");
    expect(r.result!.subject.hours).toEqual([
      "Monday: 9 AM–12 AM",
      "Tuesday: 9 AM–12 AM",
      "Wednesday: 9 AM–12 AM",
      "Thursday: 9 AM–12 AM",
      "Friday: Closed",
      "Saturday: 9 AM–2 AM",
      "Sunday: 9 AM–12 AM",
    ]);
  });

  it("reads the Reviews tab's cards, not the overview's preview cards it replaces (live layout, 2026-10-27)", async () => {
    // per_source 3: the three preview cards alone would have satisfied the old wait.
    const few = await runRecipe(session, recipe(), makeQuery({ subject: "Overview Tower", per_source: 3 }), neverLlm());
    expect(few.error).toBeUndefined();
    expect(few.result!.reviews.map((x) => x.author)).toEqual(["Nadia K.", "Omar F.", "Lena B."]);

    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Overview Tower" }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.spy.forbidden).toEqual([]);
    const { subject, reviews } = r.result!;
    expect(subject).toMatchObject({ name: "Nile View Tower", rating_avg: 4.3, review_count: 30_700 });
    // After the reviews: back to Overview, "See more hours", and only the hours that are shown (2026-10-28 layout).
    expect(subject.hours).toEqual([
      "Monday: 9 AM to 11 PM",
      "Tuesday: 9 AM to 11 PM",
      "Wednesday: 9 AM to 11 PM",
      "Thursday: 9 AM to 11 PM",
      "Friday: 1 PM to 11 PM",
      "Saturday: 9 AM to 11 PM",
      "Sunday: 9 AM to 11 PM",
    ]);
    // 10 cards, then 14 after one scroll; the previews never appear.
    expect(reviews).toHaveLength(14);
    expect(reviews.some((x) => x.author?.startsWith("Preview"))).toBe(false);
    for (const review of reviews) expect(ReviewSchema.safeParse(review).success).toBe(true);
    expect(reviews[0]).toMatchObject({ author: "Nadia K.", rating: 5, url: "https://www.google.com/maps/contrib/200000" });
    expect(reviews[0]!.text).toContain("telescopes on the deck");
    expect(reviews.find((x) => x.author === "Tarek E.")?.rating).toBe(1);
  });

  it("opens a place URL given as subject_url without searching", async () => {
    const before = server.requests.length;
    const url = `${server.url}/maps/place/Direct/data=1`;
    const r = await runRecipe(session, recipe(), makeQuery({ subject: url, subject_url: url, per_source: 5 }), neverLlm());
    expect(r.error).toBeUndefined();
    expect(r.result!.subject.name).toBe("Hôtel Lutetia");
    expect(server.requests.slice(before).some((x) => x.startsWith("GET /maps/search/"))).toBe(false);
  });

  it("falls back to the LLM when the cards carry no data-review-id, and validates what comes back", async () => {
    const llm = scriptedLlm((req) => {
      expect(req.role).toBe("extractor");
      expect(req.schema).toBeDefined();
      expect(req.maxTokens).toBe(16_000);
      const text = promptOf(req);
      expect(text).toContain("Marie D.");
      expect(text).toContain("Site: Google Maps");
      return {
        subject: { name: "Hôtel Lutetia", rating_avg: 4.6, review_count: 1234, address: null, categories: [], price_level: null },
        reviews: [
          { author: "Marie D.", rating: 5, title: null, text: "A dream stay on the Left Bank.", date_text: "2 months ago", helpful_votes: 3, verified: null, response_text: "Thank you Marie, we look forward to welcoming you again.", response_date_text: "a month ago" },
          { author: "Tom Becker", rating: 4, title: null, text: "Beautiful art deco building.", date_text: "3 weeks ago", helpful_votes: null, verified: null, response_text: null, response_date_text: null },
          { author: "Aiko Tanaka", rating: 5, title: null, text: "Impeccable service.", date_text: "a month ago", helpful_votes: 7, verified: null, response_text: null, response_date_text: null },
          { author: null, rating: 7, title: null, text: "", date_text: null, helpful_votes: null, verified: null, response_text: null, response_date_text: null },
        ],
      };
    });
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Unstructured Diner" }), llm);
    expect(r.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    expect(r.result!.reviews).toHaveLength(3);
    for (const review of r.result!.reviews) expect(ReviewSchema.safeParse(review).success).toBe(true);
    expect(r.result!.reviews.every((x) => /^google_maps:[0-9a-f]{12}$/.test(x.id))).toBe(true);
    expect(r.result!.reviews[0]?.response?.text).toMatch(/Thank you Marie/);
    expect(r.result!.subject).toMatchObject({ name: "Hôtel Lutetia", rating_avg: 4.6, review_count: 1234, address: "45 Boulevard Raspail, 75006 Paris, France" });
    expect(r.caveats).toContain(APPROXIMATE_DATE_CAVEAT);
    expect(r.caveats.some((c) => /extractor model/.test(c))).toBe(true);
    expect(r.spy.forbidden).toEqual([]);
  });

  it("throws blocked for the unusual-traffic page and never calls the model", async () => {
    const llm = neverLlm();
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Blocked Cafe" }), llm);
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("blocked");
    expect((r.error as RecipeError).needsLogin).toBe(false);
    expect((r.error as RecipeError).message).toMatch(/bot check/);
    expect(llm.calls).toHaveLength(0);
  });

  it("reports blocked at once when the Maps application bundle answers HTTP 403", async () => {
    const t0 = Date.now();
    const llm = neverLlm();
    const r = await runRecipe(session, recipe({ maxWaitMs: 30_000 }), makeQuery({ subject: "Refused Cafe" }), llm);
    expect(r.error).toBeInstanceOf(RecipeError);
    expect((r.error as RecipeError).code).toBe("blocked");
    expect((r.error as RecipeError).retryable).toBe(false);
    expect((r.error as RecipeError).message).toMatch(/refused its own page script \(the Maps application bundle answered HTTP 403\)/);
    expect(server.requests.some((x) => x.startsWith("GET /maps/_/js/"))).toBe(true);
    expect(llm.calls).toHaveLength(0);
    expect(r.spy.forbidden).toEqual([]);
    // Not the 30 s wait the page used to cost.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("reports blocked when a loaded page never starts the app (no app container)", async () => {
    const t0 = Date.now();
    const r = await runRecipe(session, recipe({ maxWaitMs: 30_000, appStartMs: 500 }), makeQuery({ subject: "Stalled Cafe" }), neverLlm());
    expect((r.error as RecipeError).code).toBe("blocked");
    expect((r.error as RecipeError).message).toMatch(/application never started \(no app container 0\.5s after the load event\); the page's script was refused/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("throws timeout when the app starts but no place arrives", async () => {
    const t0 = Date.now();
    const r = await runRecipe(session, recipe({ appStartMs: 500 }), makeQuery({ subject: "Loading Cafe" }), neverLlm(), { deadline: Date.now() + 2500 });
    expect((r.error as RecipeError).code).toBe("timeout");
    expect((r.error as RecipeError).retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("reports an unmatched subject as not found (and a URL on another site too)", async () => {
    const r = await runRecipe(session, recipe(), makeQuery({ subject: "Nowhere Bakery", location: "Atlantis" }), neverLlm());
    expect(r.error).toBeInstanceOf(SubjectNotFoundError);
    const other = await runRecipe(session, recipe(), makeQuery({ subject: "https://www.amazon.com/dp/B0B2FCT81R", subject_url: "https://www.amazon.com/dp/B0B2FCT81R" }), neverLlm());
    expect(other.error).toBeInstanceOf(SubjectNotFoundError);
    expect((other.error as Error).message).toMatch(/amazon\.com/);
  });

  it("works end to end through GoogleMapsReviewSource, mapping not found and keeping caveats", async () => {
    const source = new GoogleMapsReviewSource({ browser: session, recipe: recipe(), timeoutMs: 20_000 });
    const hooks = { caveats: [] as string[] };
    const result = await source.search(makeQuery({ subject: "Direct Place", per_source: 6 }), new AbortController().signal, hooks);
    expect(result.reviews).toHaveLength(6);
    expect(result.subject.source).toBe("google_maps");
    expect(hooks.caveats).toContain(CONSENT_CAVEAT);
    const err = (await source.search(makeQuery({ subject: "Nowhere Bakery" }), new AbortController().signal).catch((e: unknown) => e)) as ReviewSourceError;
    expect(err).toBeInstanceOf(ReviewSourceError);
    expect(err.code).toBe("not_found");
  });

  it("fails fast through GoogleMapsReviewSource when the script is refused, with the default budgets", async () => {
    const t0 = Date.now();
    const source = new GoogleMapsReviewSource({
      browser: session,
      recipe: createGoogleMapsReviewsRecipe({ searchBaseUrl: `${server.url}/maps/search/` }),
    });
    const err = (await source.search(makeQuery({ subject: "Refused Cafe" }), new AbortController().signal).catch((e: unknown) => e)) as ReviewSourceError;
    expect(err).toBeInstanceOf(ReviewSourceError);
    expect(err).toMatchObject({ code: "blocked", needsLogin: false, retryable: false });
    expect(err.message).toMatch(/page script/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(session.stats().activePages).toBe(0);
  });
});
