import { describe, expect, it } from "vitest";
import { conditionText, KNOWN_WMO_CODES, WMO_CODES } from "../../../src/core/weather/codes.js";

/** Every code Open-Meteo documents for `weather_code`. */
const DOCUMENTED = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

describe("WMO weather codes", () => {
  it("covers every documented code with non-empty text", () => {
    expect(KNOWN_WMO_CODES).toEqual(DOCUMENTED);
    for (const code of DOCUMENTED) {
      expect(typeof WMO_CODES[code]).toBe("string");
      expect((WMO_CODES[code] as string).length).toBeGreaterThan(2);
      expect(conditionText(code)).toBe(WMO_CODES[code]);
    }
  });

  it("names an unknown code instead of dropping it", () => {
    expect(conditionText(42)).toBe("unknown (code 42)");
    expect(conditionText(0)).toBe("Clear sky");
    expect(conditionText(95)).toBe("Thunderstorm");
  });
});
