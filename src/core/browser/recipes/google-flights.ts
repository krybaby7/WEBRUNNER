import { createHash } from "node:crypto";
import { errors as playwrightErrors, type Page } from "playwright";
import { z } from "zod";
import { resolveIata } from "../../flights/iata.js";
import {
  FlightOfferSchema,
  MAX_OFFERS,
  NormalizedFlightsQuerySchema,
  type FlightOffer,
  type FlightSegment,
  type NormalizedFlightsQuery,
} from "../../../schemas/flights.js";
import { detectBotWall } from "../../fetch/browser.js";
import { LlmError } from "../../llm/types.js";
import { takeSnapshot } from "../snapshot.js";
import { RecipeError, type Recipe, type RecipeContext } from "./types.js";

/**
 * Google Flights recipe (PLAN.md 3.5, 4.5, WP11).
 *
 * Personal use only: scraping Google Flights is against Google's terms of
 * service (PLAN.md section 1). No stealth, no CAPTCHA solving: a bot wall is
 * reported as `blocked`.
 *
 * URL forms verified live on 2026-10-18 from a headless Chromium (no consent
 * dialog and no CAPTCHA were served from this environment):
 *
 *   Round trip
 *     https://www.google.com/travel/flights?q=Flights%20from%20LHR%20to%20JFK%20on%202026-12-01%20returning%202026-12-08&curr=USD&hl=en
 *   One way (the literal words "one way" are REQUIRED; omitting the return
 *   clause alone gives a round trip with a Google-chosen return date)
 *     https://www.google.com/travel/flights?q=Flights%20from%20LHR%20to%20JFK%20on%202026-12-01%20one%20way&curr=USD&hl=en
 *   Passengers are accepted in the same text: "... one way for 2 adults and 1 child"
 *   produced the "3 passengers" control. Cabin and passenger counts are set in
 *   the text only when they differ from the defaults (1 adult, economy) and the
 *   page's own controls are read back afterwards; a mismatch becomes a caveat.
 *   `curr` sets the display currency, `hl=en` forces English labels, which the
 *   extractor prompt and the page probes rely on.
 *
 * Page structure (verified): results are `<ul role="list"><li>` rows. Each row
 * holds an empty `div[role=link]` whose aria-label is the whole itinerary:
 *   "From 661 US dollars round trip total. Nonstop flight with Virgin Atlantic.
 *    Leaves Heathrow Airport at 3:50 PM on Tuesday, December 1 and arrives at
 *    John F. Kennedy International Airport at 7:10 PM on Tuesday, December 1.
 *    Total duration 8 hr 20 min.   Select flight"
 *   "From 639 US dollars round trip total. 1 stop flight with Finnair. Leaves ...
 *    Total duration 13 hr 45 min.  Layover (1 of 1) is a 1 hr 35 min layover at
 *    Helsinki Airport in Helsinki. Select flight"
 * That element has no box, so it must be awaited with `state: "attached"`, not
 * "visible". Labels carry airport and airline NAMES (not codes), no flight
 * numbers, and for round trips only the outbound leg with the round-trip total
 * price. A route with no flights renders the search form and no results list
 * and no message.
 */

export const GOOGLE_FLIGHTS_SITE = "google_flights";
export const GOOGLE_FLIGHTS_BASE_URL = "https://www.google.com/travel/flights";

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** True when the query asks for anything other than 1 adult. */
function nonDefaultPassengers(q: NormalizedFlightsQuery): boolean {
  return q.passengers.adults !== 1 || q.passengers.children !== 0 || q.passengers.infants !== 0;
}

function passengerClause(q: NormalizedFlightsQuery): string {
  const parts = [plural(q.passengers.adults, "adult", "adults")];
  if (q.passengers.children > 0) parts.push(plural(q.passengers.children, "child", "children"));
  if (q.passengers.infants > 0) parts.push(plural(q.passengers.infants, "infant", "infants"));
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] as string}`;
}

const CABIN_PHRASE: Record<NormalizedFlightsQuery["cabin"], string | undefined> = {
  economy: undefined,
  premium_economy: "premium economy class",
  business: "business class",
  first: "first class",
};

/** The natural-language query Google Flights parses. */
export function buildQueryText(q: NormalizedFlightsQuery): string {
  let text = `Flights from ${q.origin} to ${q.destination} on ${q.depart_date}`;
  text += q.return_date !== undefined ? ` returning ${q.return_date}` : " one way";
  const cabin = CABIN_PHRASE[q.cabin];
  if (cabin !== undefined) text += ` in ${cabin}`;
  if (nonDefaultPassengers(q)) text += ` for ${passengerClause(q)}`;
  return text;
}

export function buildGoogleFlightsUrl(q: NormalizedFlightsQuery, baseUrl: string = GOOGLE_FLIGHTS_BASE_URL): string {
  const params = new URLSearchParams();
  params.set("q", buildQueryText(q));
  params.set("curr", q.currency);
  params.set("hl", "en");
  // URLSearchParams encodes spaces as "+"; Google accepts both, but %20 is what the site itself emits.
  return `${baseUrl}?${params.toString().replaceAll("+", "%20")}`;
}

// ---------------------------------------------------------------------------
// Airline names to IATA carrier codes
// ---------------------------------------------------------------------------

/**
 * Common carriers as Google Flights names them, with their IATA codes. The
 * schema needs a 2-character code, so a name found here never depends on the
 * model. Keys are normalised by `normalizeName`. Anything missing falls back
 * to the code the extractor is certain of; with neither, the offer is dropped.
 */
const AIRLINE_CODES: ReadonlyArray<readonly [string, string]> = [
  ["American", "AA"], ["American Airlines", "AA"], ["Delta", "DL"], ["Delta Air Lines", "DL"],
  ["United", "UA"], ["United Airlines", "UA"], ["Southwest", "WN"], ["Southwest Airlines", "WN"],
  ["Ryanair", "FR"], ["Lufthansa", "LH"], ["China Southern", "CZ"], ["China Southern Airlines", "CZ"],
  ["China Eastern", "MU"], ["China Eastern Airlines", "MU"], ["Air China", "CA"],
  ["Air France", "AF"], ["KLM", "KL"], ["British Airways", "BA"], ["IndiGo", "6E"],
  ["Turkish Airlines", "TK"], ["Emirates", "EK"], ["Qatar Airways", "QR"], ["easyJet", "U2"],
  ["Air Canada", "AC"], ["Qantas", "QF"], ["Singapore Airlines", "SQ"], ["Cathay Pacific", "CX"],
  ["ANA", "NH"], ["All Nippon Airways", "NH"], ["Japan Airlines", "JL"], ["JAL", "JL"],
  ["Korean Air", "KE"], ["Asiana", "OZ"], ["Asiana Airlines", "OZ"], ["LATAM", "LA"],
  ["LATAM Airlines", "LA"], ["Aeromexico", "AM"], ["Aeroméxico", "AM"], ["Avianca", "AV"], ["Copa", "CM"],
  ["Copa Airlines", "CM"], ["Azul", "AD"], ["GOL", "G3"], ["Etihad", "EY"], ["Etihad Airways", "EY"],
  ["Saudia", "SV"], ["Air India", "AI"], ["Alaska", "AS"], ["Alaska Airlines", "AS"],
  ["JetBlue", "B6"], ["Spirit", "NK"], ["Spirit Airlines", "NK"], ["Frontier", "F9"],
  ["Frontier Airlines", "F9"], ["Hawaiian", "HA"], ["Hawaiian Airlines", "HA"],
  ["Allegiant", "G4"], ["Sun Country", "SY"], ["SWISS", "LX"], ["Swiss", "LX"], ["Austrian", "OS"],
  ["Austrian Airlines", "OS"], ["Brussels Airlines", "SN"], ["Iberia", "IB"], ["Vueling", "VY"],
  ["LEVEL", "LV"], ["Level", "LV"], ["TAP Air Portugal", "TP"], ["TAP Portugal", "TP"],
  ["ITA Airways", "AZ"], ["Aer Lingus", "EI"], ["Finnair", "AY"], ["SAS", "SK"],
  ["Scandinavian Airlines", "SK"], ["Norwegian", "DY"], ["LOT", "LO"], ["LOT Polish Airlines", "LO"],
  ["Wizz Air", "W6"], ["Eurowings", "EW"], ["Condor", "DE"], ["Edelweiss", "WK"],
  ["Edelweiss Air", "WK"], ["Icelandair", "FI"], ["PLAY", "OG"], ["Norse Atlantic", "N0"],
  ["Norse Atlantic Airways", "N0"], ["Virgin Atlantic", "VS"], ["Virgin Australia", "VA"],
  ["Pegasus", "PC"], ["Jet2", "LS"], ["Transavia", "HV"], ["Volotea", "V7"], ["airBaltic", "BT"],
  ["Aegean", "A3"], ["Aegean Airlines", "A3"], ["Croatia Airlines", "OU"], ["TAROM", "RO"],
  ["Royal Air Maroc", "AT"], ["EgyptAir", "MS"], ["Ethiopian", "ET"], ["Ethiopian Airlines", "ET"],
  ["Kenya Airways", "KQ"], ["South African Airways", "SA"], ["Air Europa", "UX"],
  ["Thai Airways", "TG"], ["Thai", "TG"], ["Malaysia Airlines", "MH"], ["AirAsia", "AK"],
  ["Philippine Airlines", "PR"], ["Vietnam Airlines", "VN"], ["Garuda Indonesia", "GA"],
  ["EVA Air", "BR"], ["China Airlines", "CI"], ["Hainan Airlines", "HU"], ["Xiamen Airlines", "MF"],
  ["Sichuan Airlines", "3U"], ["Shenzhen Airlines", "ZH"], ["Air New Zealand", "NZ"],
  ["Jetstar", "JQ"], ["Flair", "F8"], ["WestJet", "WS"], ["Porter", "PD"], ["Volaris", "Y4"],
  ["Viva Aerobus", "VB"], ["JetSMART", "JA"], ["Sky Airline", "H2"], ["Breeze", "MX"],
  ["Gulf Air", "GF"], ["Oman Air", "WY"], ["Kuwait Airways", "KU"], ["Royal Jordanian", "RJ"],
  ["El Al", "LY"], ["flydubai", "FZ"], ["Air Arabia", "G9"], ["Azerbaijan Airlines", "J2"],
  ["Uzbekistan Airways", "HY"], ["Biman Bangladesh", "BG"], ["SriLankan Airlines", "UL"],
  ["Pakistan International", "PK"], ["Akasa Air", "QP"], ["SpiceJet", "SG"], ["Vistara", "UK"],
  ["Cebu Pacific", "5J"], ["Scoot", "TR"], ["Peach", "MM"], ["Zipair", "ZG"], ["Air Premia", "YP"],
  ["T'way Air", "TW"], ["Jeju Air", "7C"], ["Mongolian Airlines", "OM"], ["Fiji Airways", "FJ"],
  ["Air Tahiti Nui", "TN"], ["Bamboo Airways", "QH"], ["Luxair", "LG"], ["Air Serbia", "JU"],
  ["Bulgaria Air", "FB"], ["Ukraine International", "PS"], ["Air Malta", "KM"], ["TUI", "BY"],
  ["TUI fly", "X3"], ["Binter", "NT"], ["Air Dolomiti", "EN"], ["Discover Airlines", "4Y"],
  ["Sun Express", "XQ"], ["SunExpress", "XQ"], ["Air Transat", "TS"], ["Mesa Airlines", "YV"],
  ["SkyWest", "OO"], ["Republic Airways", "YX"], ["Cape Air", "9K"], ["Silver Airways", "3M"],
];

/** Lower-case, accents and punctuation removed, "airlines"/"airways"/"air lines" kept (they are part of table keys). */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const AIRLINE_BY_NAME = new Map<string, string>(AIRLINE_CODES.map(([n, c]) => [normalizeName(n), c]));

/** IATA carrier code for an airline name as Google Flights prints it, or undefined. */
export function airlineCodeForName(name: string): string | undefined {
  const key = normalizeName(name);
  const direct = AIRLINE_BY_NAME.get(key);
  if (direct !== undefined) return direct;
  // "Delta Air Lines" vs "Delta": try dropping generic suffix words.
  const trimmed = key.replace(/ (air lines|airlines|airways|air|airline)$/, "");
  return trimmed !== key ? AIRLINE_BY_NAME.get(trimmed) : undefined;
}

// ---------------------------------------------------------------------------
// Extraction schema (what the LLM returns) and assembly into FlightOffer
// ---------------------------------------------------------------------------

const PlaceRefSchema = z.object({
  name: z.string().describe("Airport name exactly as the label prints it, e.g. Heathrow Airport"),
  iata: z.string().nullable().describe("3-letter IATA airport code only if you are certain, else null"),
});

/**
 * One itinerary read from one result label. This is the flat record the model
 * fills in; `assembleOffer` turns it into a `FlightOffer` (resolving airport and
 * airline names to codes in code, building segments, validating with
 * `FlightOfferSchema`). The model is never asked to do date arithmetic across
 * layovers or to produce a flight number.
 */
export const ExtractedItinerarySchema = z.object({
  item: z.number().describe("Index [n] of the label this itinerary was read from"),
  price_amount: z.number().describe("Number from the label's price, e.g. 661"),
  currency: z.string().describe("ISO 4217 code of the price currency: 'US dollars' is USD, 'euros' is EUR, 'pounds' is GBP"),
  airlines: z
    .array(
      z.object({
        name: z.string().describe("Airline name as printed, e.g. Virgin Atlantic"),
        code: z.string().nullable().describe("2-character IATA carrier code only if you are certain, else null"),
      }),
    )
    .describe("Airlines in travel order. 'Vueling and LEVEL' is two entries"),
  stops: z.number().describe("0 for nonstop"),
  depart_airport: PlaceRefSchema,
  depart_at: z.string().describe("Local departure date-time, YYYY-MM-DDTHH:MM, 24-hour clock"),
  arrive_airport: PlaceRefSchema,
  arrive_at: z.string().describe("Local arrival date-time, YYYY-MM-DDTHH:MM, 24-hour clock; honour a later arrival date"),
  total_duration_min: z.number().describe("Total duration in minutes, layovers included"),
  layovers: z
    .array(z.object({ airport: PlaceRefSchema, duration_min: z.number() }))
    .describe("One entry per layover, in order. Empty for nonstop or when the label gives no layover detail"),
});
export type ExtractedItinerary = z.infer<typeof ExtractedItinerarySchema>;

export const ExtractionSchema = z.object({ offers: z.array(ExtractedItinerarySchema) });

const NO_FLIGHT_NUMBER_NOTE = "flight numbers not shown by source";
const ROUND_TRIP_NOTE = "Round-trip total; return flight is chosen in a second step on Google Flights";
const APPROX_SEGMENTS_NOTE = "segment times approximated from layover data";
const NO_LAYOVER_DETAIL_NOTE = "layover details not shown by source; segments not itemized";
const CARRIER_GUESS_NOTE = "carrier per segment inferred from the airline list";

/** Max labels sent to the model. Leaves slack over MAX_OFFERS for offers dropped in validation. */
export const MAX_LABELS = 40;

const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

function parseLocal(value: string): number | undefined {
  const m = LOCAL_DT.exec(value);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(ms) ? undefined : ms;
}

function formatLocal(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}:00`;
}

/** Airport name (with an optional trailing " in City") to an IATA code, in code first, then the model's code. */
export function resolveAirport(name: string, modelIata: string | null): string | undefined {
  const trimmed = name.trim();
  // Google prints some airports in the local language: "Aéroport de Paris-Charles de Gaulle in Paris".
  const noCity = trimmed.replace(/\s+in\s+[^,]+$/i, "");
  const noPrefix = noCity.replace(/^(a[eé]roport|aeropuerto|aeroporto|flughafen|lotnisko|luchthaven)\s+(internacional\s+)?(de\s+|du\s+|d['’]\s*|dos\s+)?/i, "");
  const candidates = [trimmed, noCity, noPrefix];
  for (const c of candidates) {
    if (c === "") continue;
    const code = resolveIata(c);
    if (code !== undefined && /^[A-Z]{3}$/.test(code)) return code;
  }
  const fromModel = modelIata?.trim().toUpperCase();
  return fromModel !== undefined && /^[A-Z]{3}$/.test(fromModel) ? fromModel : undefined;
}

export type DropReason = string;

function carrierFor(a: { name: string; code: string | null }): string | undefined {
  const fromTable = airlineCodeForName(a.name);
  if (fromTable !== undefined) return fromTable;
  const code = a.code?.trim();
  if (code !== undefined && /^[A-Z0-9]{2}$/.test(code)) return code;
  return undefined;
}

/** First number after "From " in a label, used only to cross-check the model's price. */
export function labelPrice(label: string): number | undefined {
  const m = /^\s*From\s+([\d][\d,.\s]*\d|\d)/i.exec(label);
  if (m === null) return undefined;
  const n = Number((m[1] as string).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Number of stops a label states, or undefined when it does not say. */
export function labelStops(label: string): number | undefined {
  if (/\bNonstop flight\b/i.test(label)) return 0;
  const m = /\b(\d+) stops? flight\b/i.exec(label);
  return m === null ? undefined : Number(m[1]);
}

export interface AssembleContext {
  query: NormalizedFlightsQuery;
  pageUrl: string;
  labels: readonly string[];
}

/**
 * Turn one extracted itinerary into a validated `FlightOffer`, or say why not.
 * Pure: no page, no model.
 */
export function assembleOffer(raw: ExtractedItinerary, c: AssembleContext): { offer: FlightOffer } | { drop: DropReason } {
  const label = c.labels[raw.item];
  if (label === undefined) return { drop: `item ${raw.item} does not match any label` };

  const expectedPrice = labelPrice(label);
  if (expectedPrice !== undefined && Math.abs(expectedPrice - raw.price_amount) > 0.5) {
    return { drop: `price ${raw.price_amount} differs from the label's ${expectedPrice}` };
  }
  const currency = raw.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { drop: `unusable currency "${raw.currency}"` };

  const departMs = parseLocal(raw.depart_at);
  const arriveMs = parseLocal(raw.arrive_at);
  if (departMs === undefined || arriveMs === undefined) return { drop: "unparseable departure or arrival time" };
  if (raw.depart_at.slice(0, 10) !== c.query.depart_date) {
    return { drop: `departs ${raw.depart_at.slice(0, 10)}, query asked for ${c.query.depart_date}` };
  }
  const total = Math.round(raw.total_duration_min);
  if (!Number.isFinite(total) || total <= 0) return { drop: "missing total duration" };
  const tzShift = (arriveMs - departMs) / 60_000 - total;
  if (Math.abs(tzShift) > 20 * 60) return { drop: "arrival time inconsistent with the total duration" };

  const departCode = resolveAirport(raw.depart_airport.name, raw.depart_airport.iata);
  if (departCode === undefined) return { drop: `no IATA code for departure airport "${raw.depart_airport.name}"` };
  const arriveCode = resolveAirport(raw.arrive_airport.name, raw.arrive_airport.iata);
  if (arriveCode === undefined) return { drop: `no IATA code for arrival airport "${raw.arrive_airport.name}"` };

  if (raw.airlines.length === 0) return { drop: "no airline" };
  const carriers: Array<{ name: string; code: string }> = [];
  for (const a of raw.airlines) {
    const code = carrierFor(a);
    if (code === undefined) return { drop: `no carrier code for airline "${a.name}"` };
    carriers.push({ name: a.name.trim(), code });
  }

  const notes: string[] = [];
  const layoverCount = raw.layovers.length;
  const itemised = layoverCount > 0 && layoverCount === Math.round(raw.stops);
  const stops = Math.max(0, Math.round(raw.stops));

  // Airports along the way and layover minutes.
  const airports: string[] = [departCode];
  const layoverMinutes: number[] = [];
  if (itemised) {
    for (const l of raw.layovers) {
      const code = resolveAirport(l.airport.name, l.airport.iata);
      if (code === undefined) return { drop: `no IATA code for layover airport "${l.airport.name}"` };
      airports.push(code);
      layoverMinutes.push(Math.max(0, Math.round(l.duration_min)));
    }
  }
  airports.push(arriveCode);
  if (!itemised && stops > 0) notes.push(NO_LAYOVER_DETAIL_NOTE);

  const segCount = airports.length - 1;
  const layoverSum = layoverMinutes.reduce((a, b) => a + b, 0);
  const flying = Math.max(0, total - layoverSum);

  // Intermediate arrival times: origin clock plus elapsed minutes plus the
  // origin-to-destination clock difference spread evenly over the trip. The
  // next departure is the arrival plus the layover on the same airport clock.
  const arrivalAt = (elapsedMin: number): number =>
    departMs + Math.round((elapsedMin + tzShift * (elapsedMin / total)) * 60_000);

  const segments: FlightSegment[] = [];
  const base = Math.floor(flying / segCount);
  let elapsed = 0;
  let departAtMs = departMs;
  for (let i = 0; i < segCount; i++) {
    const last = i === segCount - 1;
    const dur = last ? flying - base * (segCount - 1) : base;
    const arriveElapsed = elapsed + dur;
    const arriveAtMs = last ? arriveMs : arrivalAt(arriveElapsed);
    const carrier = carriers[Math.min(i, carriers.length - 1)] as { name: string; code: string };
    segments.push({
      airline: carrier.code,
      airline_name: carrier.name,
      depart_airport: airports[i] as string,
      depart_at: formatLocal(departAtMs),
      arrive_airport: airports[i + 1] as string,
      arrive_at: formatLocal(arriveAtMs),
      duration_min: dur,
    });
    const layover = layoverMinutes[i] ?? 0;
    elapsed = arriveElapsed + layover;
    departAtMs = arriveAtMs + layover * 60_000;
  }
  if (segCount > 1) notes.push(APPROX_SEGMENTS_NOTE);
  if (carriers.length > 1 && carriers.length !== segCount) notes.push(CARRIER_GUESS_NOTE);
  notes.push(NO_FLIGHT_NUMBER_NOTE);

  const outboundOnly = c.query.return_date !== undefined;
  if (outboundOnly) notes.push(ROUND_TRIP_NOTE);

  const candidate: FlightOffer = {
    id: `google_flights:${createHash("sha1").update(label).digest("hex").slice(0, 12)}`,
    source: "google_flights",
    price: { amount: raw.price_amount, currency },
    total_duration_min: total,
    stops: itemised ? layoverCount : stops,
    slices: [
      {
        segments,
        layovers: layoverMinutes.map((d, i) => ({ airport: airports[i + 1] as string, duration_min: d })),
      },
    ],
    itinerary: outboundOnly ? "outbound_only" : "complete",
    ...(isHttpUrl(c.pageUrl) && { booking_url: c.pageUrl }),
    fare_notes: notes,
  };
  const checked = FlightOfferSchema.safeParse(candidate);
  if (!checked.success) {
    return { drop: `schema: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return { offer: checked.data };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Page probes (strings: the project compiles without the DOM lib)
// ---------------------------------------------------------------------------

/** Result labels, deduplicated, in document order. Same predicate as `labelsOf` in tests. */
const COLLECT_LABELS_JS = `(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("[aria-label]")) {
    const l = (el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    if (!l || seen.has(l)) continue;
    const itinerary = /\\bSelect flight\\s*$/i.test(l) ||
      (/^From\\s/.test(l) && /\\bLeaves\\b/.test(l) && /\\bTotal duration\\b/.test(l));
    if (!itinerary) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
})()`;

const PROBE_JS = `(() => {
  const text = document.body ? (document.body.innerText || "") : "";
  const labels = ${COLLECT_LABELS_JS};
  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 4000),
    textLength: text.length,
    itemCount: labels.length,
    recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha'),
    hasHeading: !!Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).find(
      (h) => /^(best|top)( departing| returning)? flights$/i.test((h.textContent || "").trim())
    ),
  };
})()`;

interface Probe {
  url: string;
  title: string;
  text: string;
  textLength: number;
  itemCount: number;
  recaptcha: boolean;
  hasHeading: boolean;
}

const REJECT_NAMES = [
  "reject all", "alle ablehnen", "tout refuser", "rechazar todo", "rifiuta tutto", "alles afwijzen",
  "odrzuć wszystko", "recusar tudo", "rejeitar tudo", "avvisa alla", "afvis alle", "avslå alle",
  "hylkää kaikki", "απόρριψη όλων", "отклонить все", "tümünü reddet", "odmítnout vše",
  "mindent elutasítok", "respinge tot", "respingeți tot", "refuser tout", "全部拒绝", "すべて拒否", "모두 거부",
];
const ACCEPT_NAMES = [
  "accept all", "alle akzeptieren", "tout accepter", "aceptar todo", "accetta tutto", "alles accepteren",
  "zaakceptuj wszystko", "aceitar tudo", "godkänn alla", "accepter alle", "godta alle", "hyväksy kaikki",
  "αποδοχή όλων", "принять все", "tümünü kabul et", "přijmout vše", "mindent elfogadok", "acceptați tot",
  "全部接受", "すべて同意", "모두 수락", "i agree", "ich stimme zu", "j'accepte",
];

function namesRegex(names: readonly string[]): RegExp {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^\\s*(${escaped.join("|")})\\s*$`, "i");
}
const REJECT_RE = namesRegex(REJECT_NAMES);
const ACCEPT_RE = namesRegex(ACCEPT_NAMES);

const NO_RESULTS_RE =
  /\b(no (flights|results|options)( found| available| returned| match)?|couldn.t find any flights|no flights are available|we couldn.t find)/i;

const MORE_FLIGHTS_RE = /\b(view|show|see)?\s*more flights\b/i;

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

export interface GoogleFlightsRecipeOptions {
  /** Search page. Tests point it at a local fixture server. Default: Google Flights. */
  baseUrl?: string;
  /** Longest wait for the results list, in ms. Also capped at 60% of the time left. Default 30000. */
  maxResultsWaitMs?: number;
  /** How long an empty results page must stand before it counts as "no flights". Default 10000. */
  noResultsGraceMs?: number;
  /** Poll interval while waiting. Default 300. */
  pollMs?: number;
}

const SYSTEM_PROMPT = [
  "You read Google Flights search results and return structured itineraries.",
  "Each numbered label describes one result; its text is the only source of truth. Never use outside knowledge for prices, times or durations.",
  "Rules:",
  "- Return one entry per label that describes a flight itinerary, with item set to the label's [n]. Skip labels that are not itineraries or that state no price (for example 'Price unavailable').",
  "- price_amount is the number in the label (round-trip totals stay as printed). currency is the ISO 4217 code ('US dollars' USD, 'euros' EUR, 'pounds' GBP).",
  "- depart_at and arrive_at are local date-times, YYYY-MM-DDTHH:MM on a 24-hour clock, built from the label's times and dates. Labels give a weekday and day without a year: use the year of the query dates. An arrival on a later date than departure must carry that later date (a '+1' marker means the next day).",
  "- Airports: copy the name as printed. Fill iata only when you are certain of the code; otherwise null. Never guess a code.",
  "- airlines: the carriers in travel order ('Vueling and LEVEL' is two entries). Fill code only when you are certain of the 2-character IATA code; otherwise null.",
  "- stops: 0 for 'Nonstop'. layovers: one entry per 'Layover (k of n)' sentence with the airport and minutes; empty when the label has none.",
  "- total_duration_min: convert 'Total duration 13 hr 45 min' to minutes.",
  "- Do not invent anything the label does not state. Do not output flight numbers.",
].join("\n");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createGoogleFlightsRecipe(
  options: GoogleFlightsRecipeOptions = {},
): Recipe<NormalizedFlightsQuery, FlightOffer[]> {
  const baseUrl = options.baseUrl ?? GOOGLE_FLIGHTS_BASE_URL;
  const maxResultsWaitMs = options.maxResultsWaitMs ?? 30_000;
  const noResultsGraceMs = options.noResultsGraceMs ?? 10_000;
  const pollMs = options.pollMs ?? 300;

  const buildUrl = (params: NormalizedFlightsQuery): string => buildGoogleFlightsUrl(params, baseUrl);

  async function run(page: Page, params: NormalizedFlightsQuery, ctx: RecipeContext): Promise<FlightOffer[]> {
    const query = NormalizedFlightsQuerySchema.safeParse(params);
    if (!query.success) {
      throw new RecipeError("invalid_input", `invalid flight query: ${query.error.issues.map((i) => i.message).join("; ")}`);
    }
    const q = query.data;
    const caveat = (msg: string): void => {
      if (ctx.caveats !== undefined && !ctx.caveats.includes(msg)) ctx.caveats.push(msg);
    };
    const remaining = (): number => ctx.deadline - Date.now();
    const checkTime = (what: string): void => {
      if (ctx.signal?.aborted === true) throw new RecipeError("timeout", `Google Flights search aborted ${what}`);
      if (remaining() <= 0) throw new RecipeError("timeout", `Google Flights search ran out of time ${what}`);
    };

    try {
      checkTime("before navigating");
      page.on("dialog", (d) => {
        d.dismiss().catch(() => undefined);
      });
      await navigate(page, buildUrl(q), ctx, checkTime);
      const wait = await waitForResults(page, ctx, { maxResultsWaitMs, noResultsGraceMs, pollMs, caveat, checkTime });
      if (wait === "empty") {
        caveat("Google Flights showed no results for this route and date.");
        return [];
      }

      await verifyControls(page, q, caveat);
      await expandMore(page, ctx, { pollMs, caveat, checkTime });

      checkTime("before extraction");
      return await extract(page, q, ctx);
    } catch (err) {
      throw toRecipeError(err, ctx);
    }
  }

  async function navigate(page: Page, url: string, ctx: RecipeContext, checkTime: (w: string) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      checkTime("while loading the page");
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1000, Math.min(ctx.deadline - Date.now(), 30_000)),
        });
        const status = response?.status();
        if (status === 429 || status === 403) {
          throw new RecipeError("blocked", `Google Flights answered HTTP ${status}; it is blocking this browser or network`);
        }
        if (status !== undefined && status >= 500) {
          throw new RecipeError("provider", `Google Flights answered HTTP ${status}`, { retryable: true });
        }
        return;
      } catch (err) {
        if (err instanceof RecipeError && err.code === "blocked") throw err;
        // One retry, only when there is time for it; a timeout is not retried (it would eat the whole budget).
        const retryable = !(err instanceof playwrightErrors.TimeoutError) && ctx.signal?.aborted !== true;
        if (attempt >= 1 || !retryable || ctx.deadline - Date.now() < 8000) throw err;
        ctx.log.warn("google flights navigation failed, retrying once", { error: errMsg(err) });
        await sleep(1000);
      }
    }
  }

  async function waitForResults(
    page: Page,
    ctx: RecipeContext,
    o: {
      maxResultsWaitMs: number;
      noResultsGraceMs: number;
      pollMs: number;
      caveat: (m: string) => void;
      checkTime: (w: string) => void;
    },
  ): Promise<"results" | "empty"> {
    const start = Date.now();
    const budget = Math.max(0, Math.min(o.maxResultsWaitMs, (ctx.deadline - start) * 0.6));
    const until = start + budget;
    let consentHandled = false;
    for (;;) {
      o.checkTime("while waiting for results");
      let probe: Probe | undefined;
      try {
        probe = await page.evaluate<Probe>(PROBE_JS);
      } catch {
        // Navigation (consent redirect, challenge) destroyed the execution context; probe again.
      }
      if (probe !== undefined) {
        if (probe.itemCount > 0) return "results";
        const wall = blockedReason(probe);
        if (wall !== undefined) {
          throw new RecipeError("blocked", `Google Flights served a bot check (${wall}) at ${probe.url}; no results were returned`, {
            retryable: false,
          });
        }
        if (NO_RESULTS_RE.test(probe.text) && !probe.hasHeading) return "empty";
      }
      if (!consentHandled && (await dismissConsent(page))) {
        consentHandled = true;
        o.caveat("A cookie consent dialog was shown and dismissed (reject preferred) before reading results.");
        continue;
      }
      const elapsed = Date.now() - start;
      if (
        probe !== undefined &&
        elapsed >= Math.min(o.noResultsGraceMs, Math.max(0, budget - 1000)) &&
        /\bSearch results\b/.test(probe.text) &&
        /\bFilters\b/.test(probe.text) &&
        !/\bCheapest\b/.test(probe.text)
      ) {
        return "empty";
      }
      if (Date.now() >= until) {
        throw new RecipeError(
          "timeout",
          `no Google Flights results appeared within ${Math.round(budget / 1000)}s (page: ${probe?.title ?? "unknown"})`,
        );
      }
      await sleep(o.pollMs);
    }
  }

  return {
    site: GOOGLE_FLIGHTS_SITE,
    paramsSchema: NormalizedFlightsQuerySchema,
    resultSchema: z.array(FlightOfferSchema),
    buildUrl,
    run,
  };
}

function blockedReason(probe: Probe): string | undefined {
  if (/\/sorry\//.test(probe.url)) return "sorry/index";
  if (probe.recaptcha) return "recaptcha";
  if (/unusual traffic/i.test(probe.text)) return "unusual traffic";
  return detectBotWall({ title: probe.title, text: probe.text, textLength: probe.textLength });
}

/** Click the first matching consent button in any frame: reject preferred, then accept. True when one was clicked. */
async function dismissConsent(page: Page): Promise<boolean> {
  for (const re of [REJECT_RE, ACCEPT_RE]) {
    for (const frame of page.frames()) {
      try {
        const button = frame.getByRole("button", { name: re }).first();
        if ((await button.count()) === 0) continue;
        await button.click({ timeout: 3000 });
        return true;
      } catch {
        // Not clickable (detached, covered): try the next candidate.
      }
    }
  }
  return false;
}

/** Read the page's own passenger and cabin controls back and caveat anything that did not take. */
async function verifyControls(page: Page, q: NormalizedFlightsQuery, caveat: (m: string) => void): Promise<void> {
  const wantsPassengers = nonDefaultPassengers(q);
  const wantsCabin = q.cabin !== "economy";
  if (!wantsPassengers && !wantsCabin) return;
  let shown: { passengers: number | undefined; cabin: string | undefined };
  try {
    shown = await page.evaluate<{ passengers: number | undefined; cabin: string | undefined }>(`(() => {
      const btn = Array.from(document.querySelectorAll('button,[role="button"]')).map((b) => b.getAttribute("aria-label") || "")
        .find((l) => /^\\d+ passengers?\\b/i.test(l));
      const m = btn ? /^(\\d+) passengers?/i.exec(btn) : null;
      const head = (document.body ? document.body.innerText : "").slice(0, 1500);
      const c = /\\b(Premium economy|Economy|Business|First)\\b/.exec(head);
      return { passengers: m ? Number(m[1]) : undefined, cabin: c ? c[1] : undefined };
    })()`);
  } catch {
    shown = { passengers: undefined, cabin: undefined };
  }
  if (wantsPassengers) {
    const total = q.passengers.adults + q.passengers.children + q.passengers.infants;
    if (shown.passengers !== total) {
      caveat(
        `Passenger counts were not applied on Google Flights (wanted ${total}, page shows ${shown.passengers ?? "unknown"}); prices may be for a different party size.`,
      );
    }
  }
  if (wantsCabin) {
    const want = { premium_economy: "Premium economy", business: "Business", first: "First", economy: "Economy" }[q.cabin];
    if (shown.cabin !== want) {
      caveat(
        `Cabin class was not applied on Google Flights (wanted ${want}, page shows ${shown.cabin ?? "unknown"}); prices may be for another cabin.`,
      );
    }
  }
}

/**
 * Click "more flights" up to twice, waiting for the list to grow. Caveat when the
 * button is still there. Live (2026-10-18) the button was present but clicking it
 * added no rows (the list already held all ~28 itineraries), so this caveat shows
 * on most real searches; it is honest about what was and was not loaded.
 */
async function expandMore(
  page: Page,
  ctx: RecipeContext,
  o: { pollMs: number; caveat: (m: string) => void; checkTime: (w: string) => void },
): Promise<void> {
  const button = page.getByRole("button", { name: MORE_FLIGHTS_RE }).first();
  for (let i = 0; i < 2; i++) {
    o.checkTime("while expanding more flights");
    try {
      if ((await button.count()) === 0) return;
      const before = (await page.evaluate<string[]>(COLLECT_LABELS_JS)).length;
      await button.click({ timeout: 3000 });
      const until = Math.min(Date.now() + 4000, ctx.deadline - 1000);
      for (;;) {
        await sleep(o.pollMs);
        const now = (await page.evaluate<string[]>(COLLECT_LABELS_JS)).length;
        if (now > before || Date.now() >= until) break;
      }
    } catch (err) {
      ctx.log.debug("could not expand more flights", { error: errMsg(err) });
      break;
    }
  }
  try {
    if ((await button.count()) > 0) {
      o.caveat('Google Flights still offers a "more flights" button after it was clicked twice, so the list may be incomplete and further options may exist.');
    }
  } catch {
    // ignore
  }
}

async function extract(page: Page, q: NormalizedFlightsQuery, ctx: RecipeContext): Promise<FlightOffer[]> {
  const all = await page.evaluate<string[]>(COLLECT_LABELS_JS);
  const labels = selectLabels(all, q);
  if (labels.length === 0) {
    ctx.log.info("google flights: no labels left after filtering", { found: all.length, max_stops: q.max_stops });
    return [];
  }

  let outline = "";
  try {
    outline = (await takeSnapshot(page)).axTree.slice(0, 6000);
  } catch (err) {
    ctx.log.debug("snapshot failed, extracting from labels only", { error: errMsg(err) });
  }

  const tripKind = q.return_date !== undefined ? `round trip, returning ${q.return_date}` : "one way";
  const content = [
    `Search: ${q.origin} to ${q.destination}, departing ${q.depart_date}, ${tripKind}; ${q.passengers.adults} adult(s), ${q.passengers.children} child(ren), ${q.passengers.infants} infant(s); cabin ${q.cabin}; display currency ${q.currency}.`,
    `Page: ${page.url()}`,
    "",
    "Result labels (aria-label of each result row):",
    ...labels.map((l, i) => `[${i}] ${l}`),
    ...(outline !== "" ? ["", "Page outline (accessibility tree, truncated):", outline] : []),
  ].join("\n");

  const remainingMs = Math.max(1000, ctx.deadline - Date.now());
  const timeoutSignal = AbortSignal.timeout(remainingMs);
  const signal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
  const response = await ctx.llm.complete({
    role: "extractor",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    schema: ExtractionSchema,
    effort: "medium",
    maxTokens: 16_000,
    ...(ctx.meter !== undefined && { meter: ctx.meter }),
    signal,
  });

  const parsed = ExtractionSchema.safeParse(response.parsed);
  if (!parsed.success) {
    throw new RecipeError("provider", "the extractor did not return the expected structure", { retryable: true });
  }

  const pageUrl = page.url();
  const seen = new Set<string>();
  const offers: FlightOffer[] = [];
  for (const raw of parsed.data.offers) {
    const result = assembleOffer(raw, { query: q, pageUrl, labels });
    if ("drop" in result) {
      ctx.log.warn("google flights: dropped an extracted offer", { item: raw.item, reason: result.drop });
      continue;
    }
    if (seen.has(result.offer.id)) continue;
    seen.add(result.offer.id);
    if (q.max_stops !== undefined && result.offer.stops > q.max_stops) continue;
    offers.push(result.offer);
  }

  if (offers.length === 0) {
    throw new RecipeError(
      "provider",
      `Google Flights showed ${all.length} results but none could be turned into a valid offer`,
      { retryable: true },
    );
  }
  offers.sort((a, b) => a.price.amount - b.price.amount || a.id.localeCompare(b.id));
  return offers.slice(0, MAX_OFFERS);
}

/** Drop labels the query excludes, order by the price they state, keep at most MAX_LABELS. */
export function selectLabels(labels: readonly string[], q: NormalizedFlightsQuery): string[] {
  const kept = labels.filter((l) => {
    if (q.max_stops === undefined) return true;
    const s = labelStops(l);
    return s === undefined || s <= q.max_stops;
  });
  const priced = kept.map((l, i) => ({ l, i, p: labelPrice(l) ?? Number.POSITIVE_INFINITY }));
  priced.sort((a, b) => a.p - b.p || a.i - b.i);
  return priced.slice(0, MAX_LABELS).map((x) => x.l);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

function toRecipeError(err: unknown, ctx: RecipeContext): unknown {
  if (err instanceof RecipeError) return err;
  // LlmError carries its own code (config, budget_exceeded, ...): the caller maps it.
  if (err instanceof LlmError) return err;
  const aborted = ctx.signal?.aborted === true;
  if (err instanceof playwrightErrors.TimeoutError || aborted) {
    return new RecipeError("timeout", `Google Flights search timed out: ${errMsg(err)}`, { cause: err });
  }
  if (ctx.deadline - Date.now() <= 0 && /closed|Target/.test(errMsg(err))) {
    return new RecipeError("timeout", "Google Flights search ran out of time", { cause: err });
  }
  const net = /net::(ERR_[A-Z_]+)/.exec(errMsg(err))?.[1];
  if (net !== undefined) {
    return new RecipeError("provider", `navigation to Google Flights failed: ${net}`, { cause: err, retryable: true });
  }
  return new RecipeError("provider", `Google Flights recipe failed: ${errMsg(err)}`, { cause: err, retryable: false });
}

/** The recipe against live Google Flights. */
export const googleFlightsRecipe: Recipe<NormalizedFlightsQuery, FlightOffer[]> = createGoogleFlightsRecipe();
