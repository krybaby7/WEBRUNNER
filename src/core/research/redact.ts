import type { Config } from "../../config.js";

/**
 * A function that removes credentials from a string before it is logged or
 * put into an error. Exact values of every API key in `config` are replaced,
 * and anything that looks like a bearer token or a `key=value` secret too.
 */
export function makeRedactor(config: Config): (s: string) => string {
  const secrets = [
    config.anthropic_api_key,
    config.brave_api_key,
    config.exa_api_key,
    config.tavily_api_key,
    config.perplexity_api_key,
    config.firecrawl_api_key,
    config.jina_api_key,
    config.duffel_api_key,
  ].filter((k): k is string => k !== undefined && k.length >= 6);
  return (s) => {
    let out = s;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|token|key|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi,
        "$1[redacted]",
      );
  };
}
