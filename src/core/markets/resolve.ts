import { TICKER_RE, type MarketSource, type SymbolMatch } from "../../schemas/markets.js";

/**
 * Input classification and routing for `market_quote`, PLAN.md 14.2.
 *
 * - A plausible ticker matches `TICKER_RE` (letters, digits, `.`, `-`, `^`, `=`,
 *   at most 12 characters, no spaces); anything else is a name to look up first.
 * - Crypto detection: a well-known coin symbol or name, a `BASE-CUR` pair
 *   (`BTC-USD`, `ETH-EUR`), or a CoinGecko lookup hit for a name (decided by the
 *   service, which has the provider). Crypto routes `coingecko` then `yahoo`;
 *   everything else routes `yahoo`, `finnhub`, `google_finance`.
 */

export type AssetKind = "crypto" | "other";

/** Symbols and names that are crypto without asking anyone. Lower-case keys. */
const KNOWN_CRYPTO = new Set<string>([
  "btc", "bitcoin", "eth", "ethereum", "ether", "usdt", "tether", "bnb", "sol", "solana", "xrp", "ripple", "usdc",
  "ada", "cardano", "doge", "dogecoin", "trx", "tron", "ton", "toncoin", "avax", "avalanche", "dot", "polkadot",
  "link", "chainlink", "matic", "polygon", "pol", "ltc", "litecoin", "bch", "bitcoin cash", "shib", "shiba inu",
  "xlm", "stellar", "uni", "uniswap", "atom", "cosmos", "xmr", "monero", "etc", "ethereum classic", "near",
  "apt", "aptos", "arb", "arbitrum", "op", "optimism", "fil", "filecoin", "aave", "sui", "pepe", "wif", "bonk",
]);

/**
 * Coin names in KNOWN_CRYPTO to their tickers, so a name is routed as the coin's
 * symbol ("bitcoin" -> BTC-USD). Live on 2026-10-21, routing the upper-cased
 * name ("BITCOIN-USD") made CoinGecko quote an unrelated token whose ticker is
 * literally "BITCOIN" ($0.015), and Yahoo knows no "BITCOIN-USD".
 */
const CRYPTO_NAME_SYMBOLS: Readonly<Record<string, string>> = {
  bitcoin: "BTC", ethereum: "ETH", ether: "ETH", tether: "USDT", solana: "SOL", ripple: "XRP", cardano: "ADA",
  dogecoin: "DOGE", tron: "TRX", toncoin: "TON", avalanche: "AVAX", polkadot: "DOT", chainlink: "LINK",
  polygon: "POL", litecoin: "LTC", "bitcoin cash": "BCH", "shiba inu": "SHIB", stellar: "XLM", uniswap: "UNI",
  cosmos: "ATOM", monero: "XMR", "ethereum classic": "ETC", aptos: "APT", arbitrum: "ARB", optimism: "OP",
  filecoin: "FIL",
};

const PAIR_RE = /^([A-Za-z0-9.]{2,10})-([A-Za-z]{3})$/;

export const ROUTES: Readonly<Record<AssetKind, readonly MarketSource[]>> = {
  crypto: ["coingecko", "yahoo"],
  other: ["yahoo", "finnhub", "google_finance"],
};

/**
 * `TICKER_RE` plus one heuristic: tickers are written in capitals, so an input
 * with a lower-case letter ("Apple", "vodafone") is treated as a name and looked
 * up first; when no lookup matches it, the service still tries it as a ticker
 * (`fallbackTicker`).
 */
export function isPlausibleTicker(input: string): boolean {
  const s = input.trim();
  return TICKER_RE.test(s) && s === s.toUpperCase();
}

/** The upper-cased ticker to try when a name lookup found nothing, or undefined when the input cannot be a ticker. */
export function fallbackTicker(input: string): string | undefined {
  const s = input.trim();
  return TICKER_RE.test(s) ? s.toUpperCase() : undefined;
}

/** "BTC-USD" -> { base: "BTC", quote: "USD" }; undefined for anything else. */
export function splitCryptoPair(input: string): { base: string; quote: string } | undefined {
  const m = PAIR_RE.exec(input.trim());
  if (m === null) return undefined;
  const base = (m[1] as string).toUpperCase();
  const quote = (m[2] as string).toUpperCase();
  // A pair only counts as crypto when the base is a known coin; "BRK-B" is a share class, not a pair.
  return KNOWN_CRYPTO.has(base.toLowerCase()) ? { base, quote } : undefined;
}

/** True when the input is crypto on its face (known symbol or name, or a known-coin pair). */
export function looksLikeCrypto(input: string): boolean {
  const s = input.trim().toLowerCase();
  if (KNOWN_CRYPTO.has(s)) return true;
  return splitCryptoPair(input) !== undefined;
}

/**
 * The sources to try for one input, in order: the route for its kind,
 * restricted to the configured ones and, when the caller named sources, to
 * those. Requested-but-unconfigured sources are left out here and reported by
 * the service.
 */
export function providerOrder(kind: AssetKind, configured: readonly MarketSource[], requested?: readonly MarketSource[]): MarketSource[] {
  return ROUTES[kind].filter((s) => configured.includes(s) && (requested === undefined || requested.includes(s)));
}

/** A known coin name's ticker ("bitcoin" -> "BTC"); anything else upper-cased. */
export function canonicalCryptoSymbol(input: string): string {
  const s = input.trim();
  return CRYPTO_NAME_SYMBOLS[s.toLowerCase()] ?? s.toUpperCase();
}

/** Crypto goes to every source as `BASE-CUR` (Yahoo's form; CoinGecko splits it itself), names as their ticker; anything else is passed through. */
export function symbolForSource(_source: MarketSource, symbol: string, kind: AssetKind, currency: string): string {
  if (kind !== "crypto") return symbol;
  const pair = splitCryptoPair(symbol);
  const base = canonicalCryptoSymbol(pair?.base ?? symbol);
  const quote = pair?.quote ?? currency.toUpperCase();
  return `${base}-${quote}`;
}

/**
 * The caveat for a lookup with more than one plausible match: the first is
 * quoted, up to three others are named. Undefined for a single match.
 */
export function lookupCaveat(requested: string, matches: readonly SymbolMatch[]): string | undefined {
  if (matches.length < 2) return undefined;
  const first = matches[0] as SymbolMatch;
  const describe = (m: SymbolMatch): string => `${m.symbol}${m.name !== undefined ? ` (${m.name}${m.exchange !== undefined ? `, ${m.exchange}` : ""})` : m.exchange !== undefined ? ` (${m.exchange})` : ""}`;
  const others = matches.slice(1, 4).map(describe);
  return `"${requested}" matched several symbols; quoting ${describe(first)}. Other matches: ${others.join("; ")}. Pass the ticker to pick one.`;
}
