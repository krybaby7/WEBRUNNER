import { describe, expect, it } from "vitest";
import { AIRPORTS, COUNTRY_NAMES } from "../../../src/core/flights/airports.js";
import { METRO_AREAS, resolveIata } from "../../../src/core/flights/iata.js";

describe("airport table", () => {
  it("has at least 300 airports with well-formed unique records", () => {
    expect(AIRPORTS.length).toBeGreaterThanOrEqual(300);
    const seen = new Set<string>();
    for (const a of AIRPORTS) {
      expect(a.iata).toMatch(/^[A-Z]{3}$/);
      expect(seen.has(a.iata), `duplicate ${a.iata}`).toBe(false);
      seen.add(a.iata);
      expect(a.city.length, a.iata).toBeGreaterThan(0);
      expect(a.name.length, a.iata).toBeGreaterThan(0);
      expect(a.country, a.iata).toMatch(/^[A-Z]{2}$/);
      expect(COUNTRY_NAMES[a.country], `country name for ${a.country}`).toBeTruthy();
    }
  });

  it("contains the world's busiest airports", () => {
    const codes = new Set(AIRPORTS.map((a) => a.iata));
    for (const c of ["ATL", "DXB", "DFW", "HND", "LHR", "DEN", "IST", "ORD", "DEL", "PVG", "CAN", "ICN", "CDG", "AMS", "FRA", "SIN", "JFK", "LAX", "HKG", "BKK", "MAD", "SYD", "GRU", "JNB"]) {
      expect(codes.has(c), c).toBe(true);
    }
  });

  it("defines metro areas with at least two member airports in the table", () => {
    const codes = new Set(AIRPORTS.map((a) => a.iata));
    const metroCodes = new Set<string>();
    for (const m of METRO_AREAS) {
      expect(m.code).toMatch(/^[A-Z]{3}$/);
      expect(metroCodes.has(m.code), `duplicate metro ${m.code}`).toBe(false);
      metroCodes.add(m.code);
      expect(m.airports.filter((c) => codes.has(c)).length, m.code).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("resolveIata", () => {
  describe("codes pass through", () => {
    it.each([
      ["LHR", "LHR"],
      ["lhr", "LHR"],
      ["  Jfk ", "JFK"],
      ["LON", "LON"],
      ["nyc", "NYC"],
      ["HOU", "HOU"],
    ])("%j -> %s", (input, expected) => {
      expect(resolveIata(input)).toBe(expected);
    });

    it("passes an unknown 3-letter code through only when typed in uppercase", () => {
      expect(resolveIata("XYZ")).toBe("XYZ");
      expect(resolveIata("xyz")).toBeUndefined();
      expect(resolveIata("foo")).toBeUndefined();
    });

    it("takes the code from 'City (CODE)'", () => {
      expect(resolveIata("London (LHR)")).toBe("LHR");
      expect(resolveIata("Paris (CDG)")).toBe("CDG");
      expect(resolveIata("New York (JFK)")).toBe("JFK");
    });

    it("resolves '<code> Airport'", () => {
      expect(resolveIata("JFK Airport")).toBe("JFK");
      expect(resolveIata("LAX International Airport")).toBe("LAX");
    });
  });

  describe("multi-airport cities resolve to the metropolitan code", () => {
    it.each([
      ["London", "LON"],
      ["New York", "NYC"],
      ["New York City", "NYC"],
      ["Paris", "PAR"],
      ["Tokyo", "TYO"],
      ["Chicago", "CHI"],
      ["Washington", "WAS"],
      ["Washington, DC", "WAS"],
      ["Milan", "MIL"],
      ["Milano", "MIL"],
      ["Rome", "ROM"],
      ["Moscow", "MOW"],
      ["Sao Paulo", "SAO"],
      ["Rio de Janeiro", "RIO"],
      ["Buenos Aires", "BUE"],
      ["Osaka", "OSA"],
      ["Sapporo", "SPK"],
      ["Seoul", "SEL"],
      ["Beijing", "BJS"],
      ["Shanghai", "SHA"],
      ["Stockholm", "STO"],
      ["Jakarta", "JKT"],
      ["Toronto", "YTO"],
      ["Montreal", "YMQ"],
      ["Houston", "HOU"],
      ["Dallas", "DFW"],
      ["Dallas-Fort Worth", "DFW"],
      ["Bangkok", "BKK"],
      ["Istanbul", "IST"],
      ["Dubai", "DXB"],
      ["Tehran", "THR"],
    ])("%s -> %s", (input, expected) => {
      expect(resolveIata(input)).toBe(expected);
    });
  });

  describe("single-airport cities", () => {
    it.each([
      ["Amsterdam", "AMS"],
      ["Madrid", "MAD"],
      ["Berlin", "BER"],
      ["Munich", "MUC"],
      ["Singapore", "SIN"],
      ["Sydney", "SYD"],
      ["Los Angeles", "LAX"],
      ["San Francisco", "SFO"],
      ["Mumbai", "BOM"],
      ["Bombay", "BOM"],
      ["Delhi", "DEL"],
      ["New Delhi", "DEL"],
      ["Bangalore", "BLR"],
      ["Mexico City", "MEX"],
      ["Hong Kong", "HKG"],
      ["Dublin", "DUB"],
      ["Barcelona", "BCN"],
      ["Frankfurt", "FRA"],
      ["Frankfurt am Main", "FRA"],
      ["Bucharest", "OTP"],
      ["St Louis", "STL"],
      ["St. Louis", "STL"],
      ["Saint Louis", "STL"],
      ["Tel Aviv", "TLV"],
      ["Reykjavik", "KEF"],
    ])("%s -> %s", (input, expected) => {
      expect(resolveIata(input)).toBe(expected);
    });
  });

  describe("airport names", () => {
    it.each([
      ["Heathrow", "LHR"],
      ["Heathrow Airport", "LHR"],
      ["London Heathrow", "LHR"],
      ["London Heathrow Airport", "LHR"],
      ["Gatwick", "LGW"],
      ["Stansted", "STN"],
      ["Luton", "LTN"],
      ["London City Airport", "LCY"],
      ["John F. Kennedy", "JFK"],
      ["Kennedy", "JFK"],
      ["LaGuardia", "LGA"],
      ["Newark", "EWR"],
      ["Charles de Gaulle", "CDG"],
      ["Paris Charles de Gaulle", "CDG"],
      ["Orly", "ORY"],
      ["Schiphol", "AMS"],
      ["Haneda", "HND"],
      ["Narita", "NRT"],
      ["O'Hare", "ORD"],
      ["Midway", "MDW"],
      ["Dulles", "IAD"],
      ["Reagan National", "DCA"],
      ["Linate", "LIN"],
      ["Malpensa", "MXP"],
      ["Fiumicino", "FCO"],
      ["Changi", "SIN"],
      ["Ben Gurion", "TLV"],
      ["Suvarnabhumi", "BKK"],
      ["Don Mueang", "DMK"],
      ["Kansai International Airport", "KIX"],
      ["Sheremetyevo", "SVO"],
    ])("%s -> %s", (input, expected) => {
      expect(resolveIata(input)).toBe(expected);
    });
  });

  describe("case, accents and spacing", () => {
    it.each([
      ["LONDON", "LON"],
      ["london", "LON"],
      ["  London  ", "LON"],
      ["HEATHROW", "LHR"],
      ["são paulo", "SAO"],
      ["São Paulo", "SAO"],
      ["ZÜRICH", "ZRH"],
      ["Zurich", "ZRH"],
      ["Montréal", "YMQ"],
      ["new   york", "NYC"],
      ["Reykjavík", "KEF"],
    ])("%j -> %s", (input, expected) => {
      expect(resolveIata(input)).toBe(expected);
    });
  });

  describe("country and state qualifiers", () => {
    it.each([
      ["London, UK", "LON"],
      ["London, United Kingdom", "LON"],
      ["Paris, France", "PAR"],
      ["Birmingham, UK", "BHX"],
      ["Birmingham, USA", "BHM"],
      ["Manchester, England", "MAN"],
      ["Santiago, Chile", "SCL"],
      ["Santiago, Dominican Republic", "STI"],
      ["San Francisco, CA", "SFO"],
      ["Los Angeles, CA", "LAX"],
      ["New York, NY", "NYC"],
      ["Portland, Oregon", "PDX"],
      ["Portland Maine", "PWM"],
    ])("%s -> %s", (input, expected) => {
      expect(resolveIata(input)).toBe(expected);
    });
  });

  describe("returns undefined rather than guessing", () => {
    it.each([
      "",
      "   ",
      "Atlantis",
      "Xyzzyville",
      "12",
      "lh",
      "LHRX",
      "airport",
      "International Airport",
      "Springfield",
      "Paris, TX",
      "London, Narnia",
      // Ambiguous names (several airports, no metropolitan code):
      "Portland",
      "Birmingham",
      "Santiago",
      "San Jose",
      "Victoria",
      "Manchester",
    ])("%j", (input) => {
      expect(resolveIata(input)).toBeUndefined();
    });

    it("rejects absurdly long input", () => {
      expect(resolveIata("London".repeat(40))).toBeUndefined();
    });
  });

  it("every metro city name resolves to its metro code", () => {
    for (const m of METRO_AREAS) {
      expect(resolveIata(m.city), m.city).toBe(m.code);
      expect(resolveIata(m.code), m.code).toBe(m.code);
    }
  });

  it("every airport resolves from its own code", () => {
    for (const a of AIRPORTS) expect(resolveIata(a.iata), a.iata).toBe(a.iata);
  });
});
