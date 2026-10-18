import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { ExtractedItinerary } from "../../../src/core/browser/recipes/google-flights.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../../src/core/llm/types.js";
import type { Logger } from "../../../src/log.js";
import type { NormalizedFlightsQuery } from "../../../src/schemas/flights.js";

export const FLIGHT_FIXTURES = fileURLToPath(new URL("../../fixtures/flights/", import.meta.url));

export function readFixture(name: string): string {
  return readFileSync(join(FLIGHT_FIXTURES, name), "utf8");
}

export interface FlightsServer {
  url: string;
  close(): Promise<void>;
}

/** HTML for a bare results list built from labels (no consent dialog). */
function listPage(labels: string[]): string {
  const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><title>London to New York | Google Flights</title><main><h2>Flight search</h2><h2>Search results</h2>
<h3>Top departing flights</h3><ul role="list">${labels
    .map((l) => `<li><div role="link" tabindex="0" aria-label="${esc(l)}"></div><span>row</span></li>`)
    .join("")}</ul></main>`;
}

/**
 * Local stand-in for Google Flights.
 *   /results  results fixture with consent dialog (round trip labels)
 *   /sticky  the results page whose "View more flights" button never goes away
 *   /oneway   the same page with " round trip total" removed from the labels
 *   /live     real labels captured from Google Flights, rendered as a bare list
 *   /blocked  the unusual-traffic interstitial
 *   /empty    a route with no flights
 *   /stalled  a page where results never arrive
 *   /status/N a bare HTTP status
 */
export async function startFlightsServer(): Promise<FlightsServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    if (path === "/results") html(readFixture("google-flights-results.html"));
    else if (path === "/sticky") {
      html(readFixture("google-flights-results.html").replace('document.getElementById("more").hidden = true;', ""));
    } else if (path === "/oneway") html(readFixture("google-flights-results.html").replaceAll(" round trip total", ""));
    else if (path === "/live") {
      html(listPage(readFixture("google-flights-aria-labels.txt").split("\n").filter((l) => l.trim() !== "")));
    } else if (path === "/blocked") html(readFixture("google-flights-blocked.html"));
    else if (path === "/empty") html(readFixture("google-flights-empty.html"));
    else if (path === "/stalled") html(readFixture("google-flights-stalled.html"));
    else if (/^\/status\/\d+$/.test(path)) html("<title>status</title>", Number(path.split("/")[2]));
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function makeLogger(): { [K in keyof Logger]: ReturnType<typeof vi.fn> } & Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

export const ROUND_TRIP: NormalizedFlightsQuery = {
  origin: "LHR",
  destination: "JFK",
  depart_date: "2026-12-01",
  return_date: "2026-12-08",
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: "economy",
  sources: ["google_flights"],
  currency: "USD",
};

export const ONE_WAY: NormalizedFlightsQuery = (() => {
  const { return_date: _omit, ...rest } = ROUND_TRIP;
  return rest;
})();

export interface ScriptedLlm extends LlmClient {
  calls: LlmRequest[];
}

/** An LlmClient whose answer is computed from the request. Records every request. */
export function scriptedLlm(respond: (req: LlmRequest) => unknown): ScriptedLlm {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      return {
        parsed: respond(req),
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.01,
        model: "claude-sonnet-5-5",
        stopReason: "end_turn",
      };
    },
  };
}

/** The user message text of a request. */
export function promptOf(req: LlmRequest): string {
  const m = req.messages[0];
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
}

/** `[n] label` lines of the prompt, as the model sees them. */
export function promptLabels(req: LlmRequest): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of promptOf(req).split("\n")) {
    const m = /^\[(\d+)\] (.*)$/.exec(line);
    if (m !== null) out.set(Number(m[1]), m[2] as string);
  }
  return out;
}

const MONTHS: Record<string, string> = {
  January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
  July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
};
const CURRENCIES: Record<string, string> = { "US dollars": "USD", euros: "EUR", pounds: "GBP" };

function to24h(time: string, month: string, day: string, year: number): string {
  const m = /^(\d+):(\d+) ([AP])M$/.exec(time) as RegExpExecArray;
  let h = Number(m[1]) % 12;
  if (m[3] === "P") h += 12;
  return `${year}-${MONTHS[month]}-${day.padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[2]}`;
}

function minutes(hr: string | undefined, min: string | undefined): number {
  return Number(hr ?? 0) * 60 + Number(min ?? 0);
}

/**
 * What a competent model would return for one real label. Deterministic, so
 * the realistic-input tests do not need an API key.
 */
export function readLabel(item: number, label: string, year = 2026): ExtractedItinerary {
  const price = /^From ([\d,]+(?:\.\d+)?) (US dollars|euros|pounds)/.exec(label) as RegExpExecArray;
  const airlines = (/(?:Nonstop flight|\d+ stops? flight) with (.+?)\. Leaves/.exec(label)?.[1] ?? "")
    .split(/ and |, /)
    .map((name) => ({ name, code: null }));
  const when =
    /Leaves (.+?) at (\d+:\d+ [AP]M) on \w+, (\w+) (\d+) and arrives at (.+?) at (\d+:\d+ [AP]M) on \w+, (\w+) (\d+)\./.exec(
      label,
    ) as RegExpExecArray;
  const dur = /Total duration (?:(\d+) hr)? ?(?:(\d+) min)?/.exec(label) as RegExpExecArray;
  const stops = /\b(\d+) stops? flight/.exec(label);
  const layovers = [...label.matchAll(/Layover \(\d+ of \d+\) is an? (?:(\d+) hr )?(?:(\d+) min )?layover at (.+?)\.(?: |$)/g)].map(
    (m) => ({ airport: { name: m[3] as string, iata: null }, duration_min: minutes(m[1], m[2]) }),
  );
  return {
    item,
    price_amount: Number((price[1] as string).replaceAll(",", "")),
    currency: CURRENCIES[price[2] as string] as string,
    airlines,
    stops: stops === null ? 0 : Number(stops[1]),
    depart_airport: { name: when[1] as string, iata: null },
    depart_at: to24h(when[2] as string, when[3] as string, when[4] as string, year),
    arrive_airport: { name: when[5] as string, iata: null },
    arrive_at: to24h(when[6] as string, when[7] as string, when[8] as string, year),
    total_duration_min: minutes(dur[1], dur[2]),
    layovers,
  };
}

/** A scripted LLM that reads every `[n] label` in the prompt like a careful model would. */
export function labelReadingLlm(): ScriptedLlm {
  return scriptedLlm((req) => ({
    // Like a careful model: a label that states no price (live pages show "Price unavailable") is skipped.
    offers: [...promptLabels(req)].filter(([, label]) => /^From [\d,]+/.test(label)).map(([n, label]) => readLabel(n, label)),
  }));
}
