import { AIRPORTS, COUNTRY_NAMES, type AirportRecord } from "./airports.js";

/**
 * City and airport name to IATA code, from the static table in ./airports.ts.
 * No network, no LLM: WP11 adds an LLM fallback for what this cannot resolve.
 *
 * Resolution rules, in order:
 *   1. Whole-string aliases ("kennedy", "frankfurt am main", "bombay", ...).
 *   2. A 3-letter code in the table or METRO_AREAS, any case ("lhr" -> "LHR").
 *   3. "Name (CODE)", for example "London (LHR)", returns CODE.
 *   4. A city, airport name or alias, accent- and case-insensitive, with
 *      generic words ("airport", "international") ignored. An optional country
 *      qualifier after a comma ("Birmingham, UK") disambiguates; an
 *      unrecognised qualifier ("Paris, TX") makes the result undefined.
 *   5. An unknown 3-letter code typed in UPPERCASE ("XYZ") passes through, since
 *      the table covers about 620 airports, not the ~9,000 that sell tickets.
 *      The provider rejects it if it is not real. Lowercase unknown 3-letter
 *      words ("foo") are not treated as codes.
 *   Anything else returns undefined. The function never guesses: a name that
 *   matches several airports with no metropolitan code ("Portland",
 *   "Birmingham", "Santiago") is ambiguous and returns undefined.
 *
 * Multi-airport cities (metropolitan areas): when a city has several airports
 * in the table and IATA defines a metropolitan area code for it, the CITY code
 * is returned, so providers search all of the city's airports: London -> LON
 * (not LHR), New York -> NYC, Paris -> PAR, Tokyo -> TYO, and so on, see
 * METRO_AREAS. A specific airport name ("Heathrow", "JFK", "Orly") still
 * returns that airport. Metro codes that equal one of their own airport codes
 * (HOU, DFW, IST, BKK, TPE, SHA) are IATA city codes first; providers treat
 * them as the city.
 */

export interface MetroArea {
  /** IATA metropolitan area (city) code. */
  code: string;
  city: string;
  country: string;
  /** Member airports. Those missing from the table are ignored. */
  airports: readonly string[];
  /** Other names for the city, matched like the city name. */
  aliases?: readonly string[];
}

/** IATA metropolitan area codes for cities with several airports in the table. */
export const METRO_AREAS: readonly MetroArea[] = [
  { code: "LON", city: "London", country: "GB", airports: ["LHR", "LGW", "STN", "LTN", "LCY", "SEN"] },
  { code: "NYC", city: "New York", country: "US", airports: ["JFK", "LGA", "EWR"], aliases: ["New York City"] },
  { code: "PAR", city: "Paris", country: "FR", airports: ["CDG", "ORY", "BVA"] },
  { code: "TYO", city: "Tokyo", country: "JP", airports: ["HND", "NRT"] },
  { code: "WAS", city: "Washington", country: "US", airports: ["IAD", "DCA", "BWI"], aliases: ["Washington DC"] },
  { code: "CHI", city: "Chicago", country: "US", airports: ["ORD", "MDW"] },
  { code: "MIL", city: "Milan", country: "IT", airports: ["MXP", "LIN", "BGY"], aliases: ["Milano"] },
  { code: "ROM", city: "Rome", country: "IT", airports: ["FCO", "CIA"], aliases: ["Roma"] },
  { code: "MOW", city: "Moscow", country: "RU", airports: ["SVO", "DME", "VKO"], aliases: ["Moskva"] },
  { code: "SAO", city: "Sao Paulo", country: "BR", airports: ["GRU", "CGH", "VCP"] },
  { code: "RIO", city: "Rio de Janeiro", country: "BR", airports: ["GIG", "SDU"], aliases: ["Rio"] },
  { code: "BUE", city: "Buenos Aires", country: "AR", airports: ["EZE", "AEP"] },
  { code: "OSA", city: "Osaka", country: "JP", airports: ["KIX", "ITM"] },
  { code: "SPK", city: "Sapporo", country: "JP", airports: ["CTS", "OKD"] },
  { code: "SEL", city: "Seoul", country: "KR", airports: ["ICN", "GMP"] },
  { code: "BJS", city: "Beijing", country: "CN", airports: ["PEK", "PKX"], aliases: ["Peking"] },
  { code: "SHA", city: "Shanghai", country: "CN", airports: ["PVG", "SHA"] },
  { code: "STO", city: "Stockholm", country: "SE", airports: ["ARN", "BMA"] },
  { code: "JKT", city: "Jakarta", country: "ID", airports: ["CGK", "HLP"] },
  { code: "YTO", city: "Toronto", country: "CA", airports: ["YYZ", "YTZ"] },
  { code: "YMQ", city: "Montreal", country: "CA", airports: ["YUL", "YMX"] },
  { code: "HOU", city: "Houston", country: "US", airports: ["IAH", "HOU"] },
  {
    code: "DFW",
    city: "Dallas",
    country: "US",
    airports: ["DFW", "DAL"],
    aliases: ["Dallas Fort Worth", "Fort Worth"],
  },
  { code: "BKK", city: "Bangkok", country: "TH", airports: ["BKK", "DMK"] },
  { code: "TPE", city: "Taipei", country: "TW", airports: ["TPE", "TSA"] },
  { code: "IST", city: "Istanbul", country: "TR", airports: ["IST", "SAW"] },
  { code: "DXB", city: "Dubai", country: "AE", airports: ["DXB", "DWC"] },
  { code: "THR", city: "Tehran", country: "IR", airports: ["THR", "IKA"] },
];

/**
 * Whole-string aliases for names the table cannot derive: former or local city
 * names and common airport nicknames. Values are airport or metro codes.
 */
const ALIASES: Readonly<Record<string, string>> = {
  kennedy: "JFK",
  "john f kennedy": "JFK",
  reagan: "DCA",
  fiumicino: "FCO",
  ciampino: "CIA",
  linate: "LIN",
  roissy: "CDG",
  "frankfurt am main": "FRA",
  "ho chi minh": "SGN",
  saigon: "SGN",
  bombay: "BOM",
  calcutta: "CCU",
  madras: "MAA",
  bangalore: "BLR",
  delhi: "DEL",
  gothenburg: "GOT",
  koln: "CGN",
  munchen: "MUC",
  wien: "VIE",
  praha: "PRG",
  napoli: "NAP",
  venezia: "VCE",
  torino: "TRN",
  firenze: "FLR",
  lisboa: "LIS",
  "portland oregon": "PDX",
  "portland maine": "PWM",
};

/** Country names people write besides the English short names in COUNTRY_NAMES. */
const COUNTRY_EXTRAS: Readonly<Record<string, string>> = {
  usa: "US",
  "united states of america": "US",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  uae: "AE",
};

const US_STATES: ReadonlySet<string> = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);
const CA_PROVINCES: ReadonlySet<string> = new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "));

const GENERIC_WORDS = new Set([
  "airport",
  "airfield",
  "airstrip",
  "international",
  "intl",
  "regional",
  "municipal",
  "national",
  "field",
  "air",
  "base",
  "terminal",
  "aeroport",
  "aeropuerto",
  "aeroporto",
  "flughafen",
]);

const TOKEN_EXPANSIONS: Readonly<Record<string, string>> = { st: "saint", ft: "fort", mt: "mount" };

const LETTER_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ø/g, "o"],
  [/æ/g, "ae"],
  [/œ/g, "oe"],
  [/ß/g, "ss"],
  [/ł/g, "l"],
  [/đ/g, "d"],
  [/ı/g, "i"],
];

/** Lowercase, accent-free, punctuation-free, single-spaced, "st" -> "saint". */
function normalize(text: string): string {
  let s = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const [re, to] of LETTER_FOLDS) s = s.replace(re, to);
  s = s.replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  if (s === "") return "";
  return s
    .split(" ")
    .map((t) => TOKEN_EXPANSIONS[t] ?? t)
    .join(" ");
}

/** `normalize` with generic airport words removed. */
function normalizeStripped(text: string): string {
  return normalize(text)
    .split(" ")
    .filter((t) => t !== "" && !GENERIC_WORDS.has(t))
    .join(" ");
}

interface Index {
  /** Normalized city (and metro name/alias) -> airport codes. */
  city: Map<string, Set<string>>;
  /** Normalized airport name variants -> airport codes. */
  name: Map<string, Set<string>>;
  airports: Map<string, AirportRecord>;
  metros: Map<string, MetroArea>;
  countries: Map<string, string>;
}

function addTo(map: Map<string, Set<string>>, key: string, code: string): void {
  if (key === "") return;
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([code]));
  else set.add(code);
}

let cachedIndex: Index | undefined;

function buildIndex(): Index {
  const city = new Map<string, Set<string>>();
  const name = new Map<string, Set<string>>();
  const airports = new Map<string, AirportRecord>();
  const metros = new Map<string, MetroArea>();

  for (const a of AIRPORTS) {
    airports.set(a.iata, a);
    const cityKey = normalizeStripped(a.city);
    addTo(city, cityKey, a.iata);

    // A name that is just the city ("Dubai International Airport") is a city
    // match, not an airport-specific one, so it must not block metro collapse.
    const nameKey = normalizeStripped(a.name);
    if (nameKey !== cityKey) addTo(name, nameKey, a.iata);
    if (cityKey !== "" && nameKey.startsWith(cityKey + " ")) {
      // "london heathrow" -> also "heathrow"
      addTo(name, nameKey.slice(cityKey.length + 1), a.iata);
    } else if (cityKey !== "" && nameKey !== cityKey) {
      // "charles de gaulle" -> also "paris charles de gaulle"
      addTo(name, `${cityKey} ${nameKey}`, a.iata);
    }
  }

  for (const m of METRO_AREAS) {
    metros.set(m.code, m);
    const members = m.airports.filter((c) => airports.has(c));
    for (const label of [m.city, ...(m.aliases ?? [])]) {
      for (const code of members) addTo(city, normalizeStripped(label), code);
    }
  }

  const countries = new Map<string, string>();
  for (const [iso, countryName] of Object.entries(COUNTRY_NAMES)) {
    countries.set(iso.toLowerCase(), iso);
    countries.set(normalize(countryName), iso);
  }
  for (const [label, iso] of Object.entries(COUNTRY_EXTRAS)) countries.set(label, iso);

  return { city, name, airports, metros, countries };
}

function getIndex(): Index {
  cachedIndex ??= buildIndex();
  return cachedIndex;
}

/** Metro whose member airports (present in the table) include every code in `codes`. */
function coveringMetro(codes: Set<string>, index: Index, countries?: ReadonlySet<string>): MetroArea | undefined {
  for (const m of index.metros.values()) {
    if (countries !== undefined && !countries.has(m.country)) continue;
    const members = new Set(m.airports.filter((c) => index.airports.has(c)));
    if (members.size < 2) continue;
    if ([...codes].every((c) => members.has(c))) return m;
  }
  return undefined;
}

function lookupPlace(key: string, index: Index, countries?: ReadonlySet<string>): string | undefined {
  const aliasHit = ALIASES[key];
  if (aliasHit !== undefined && countries === undefined) return aliasHit;

  const cityHits = index.city.get(key) ?? new Set<string>();
  const nameHits = index.name.get(key) ?? new Set<string>();
  const inCountry = (code: string): boolean =>
    countries === undefined || countries.has(index.airports.get(code)?.country ?? "");

  const cityCodes = new Set([...cityHits].filter(inCountry));
  const nameCodes = new Set([...nameHits].filter(inCountry));
  const all = new Set([...cityCodes, ...nameCodes]);

  if (all.size === 0) return undefined;
  if (all.size === 1) {
    return [...all][0];
  }
  // Several airports. Only a pure city-level match may collapse to a metro code.
  if (nameCodes.size === 0) {
    const metro = coveringMetro(cityCodes, index, countries);
    if (metro !== undefined) return metro.code;
  }
  return undefined;
}

/**
 * Countries a ", qualifier" can mean: a country name or ISO code, plus the
 * United States for a US state code and Canada for a province code. Readings
 * that collide ("CA" is Canada and California) are all kept; a wrong reading
 * only adds candidates that fail to match, and if two countries both have a
 * matching city the result stays ambiguous (undefined).
 */
function qualifierCountries(qualifier: string, index: Index): Set<string> {
  const out = new Set<string>();
  const country = index.countries.get(normalize(qualifier));
  if (country !== undefined) out.add(country);
  const code = qualifier.trim().toUpperCase();
  if (US_STATES.has(code)) out.add("US");
  if (CA_PROVINCES.has(code)) out.add("CA");
  return out;
}

/**
 * Resolve an IATA code, city name or airport name to an IATA code, or
 * undefined. See the module comment for the rules.
 */
export function resolveIata(input: string): string | undefined {
  const raw = input.trim();
  if (raw === "" || raw.length > 100) return undefined;
  const index = getIndex();

  const wholeKey = normalize(raw);
  if (wholeKey === "") return undefined;
  const wholeAlias = ALIASES[wholeKey];
  if (wholeAlias !== undefined) return wholeAlias;

  if (/^[A-Za-z]{3}$/.test(raw)) {
    const code = raw.toUpperCase();
    if (index.airports.has(code) || index.metros.has(code)) return code;
  }

  const paren = /\(\s*([A-Za-z]{3})\s*\)\s*$/.exec(raw);
  if (paren?.[1] !== undefined && paren[1] === paren[1].toUpperCase()) {
    return paren[1];
  }

  const commaParts = raw.split(",");
  let place = raw;
  let countries: Set<string> | undefined;
  if (commaParts.length > 1) {
    // "Washington, DC" style: the whole string may be an alias or a metro name.
    const whole = lookupPlace(normalizeStripped(raw.replace(/,/g, " ")), index);
    if (whole !== undefined) return whole;
    place = (commaParts[0] ?? "").trim();
    countries = qualifierCountries(commaParts.slice(1).join(" "), index);
    if (countries.size === 0) return undefined;
  }

  const placeKey = normalizeStripped(place.replace(/\(.*?\)/g, " "));
  if (placeKey !== "") {
    const hit = lookupPlace(placeKey, index, countries);
    if (hit !== undefined) return hit;
    // "JFK Airport", "LAX International": a known code once generic words are dropped.
    if (countries === undefined && /^[a-z]{3}$/.test(placeKey)) {
      const code = placeKey.toUpperCase();
      if (index.airports.has(code) || index.metros.has(code)) return code;
    }
  }

  if (/^[A-Z]{3}$/.test(raw)) return raw;
  return undefined;
}
