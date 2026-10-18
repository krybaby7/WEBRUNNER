import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { buildAllFlightProviders, buildFlightProviders } from "../../../src/core/flights/providers/index.js";
import { DuffelProvider } from "../../../src/core/flights/providers/duffel.js";
import { log } from "../../../src/log.js";

function config(env: Record<string, string>) {
  vi.spyOn(log, "warn").mockImplementation(() => {});
  return loadConfig({ env, configPath: "/nonexistent/webrunner-config.json", home: "/nonexistent" });
}

describe("buildFlightProviders", () => {
  it("returns Duffel when DUFFEL_API_KEY is set", () => {
    const providers = buildFlightProviders(config({ DUFFEL_API_KEY: "duffel_test_REDACTED" }));
    expect(providers.map((p) => p.name)).toEqual(["duffel"]);
    expect(providers[0]).toBeInstanceOf(DuffelProvider);
    expect(providers[0]?.isConfigured()).toBe(true);
  });

  it("returns no providers without a key", () => {
    expect(buildFlightProviders(config({}))).toEqual([]);
  });

  it("treats an empty key as unset", () => {
    expect(buildFlightProviders(config({ DUFFEL_API_KEY: "" }))).toEqual([]);
  });
});

describe("buildAllFlightProviders", () => {
  it("lists Duffel as unconfigured when the key is missing so callers can report it", () => {
    const all = buildAllFlightProviders(config({}));
    expect(all.map((p) => [p.name, p.isConfigured()])).toEqual([["duffel", false]]);
  });
});
