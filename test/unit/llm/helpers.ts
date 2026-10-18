import { vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../../../src/config.js";
import type { Logger } from "../../../src/log.js";
import type { AnthropicLike } from "../../../src/core/llm/client.js";

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type CreateParams = Parameters<AnthropicLike["beta"]["messages"]["create"]>[0];

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropic_api_key: "test-key",
    browser: { profile_dir: "/tmp/webrunner-test/profile" },
    research_max_cost_usd: 3,
    cache_dir: "/tmp/webrunner-test/cache",
    log_level: "error",
    save_screenshots: false,
    currency: "USD",
    models: {
      planner: "claude-opus-5-5",
      scorer: "claude-haiku-5-5",
      extractor: "claude-sonnet-5-5",
      writer: "claude-opus-5-5",
    },
    ...overrides,
  };
}

export interface MessageOverrides {
  text?: string;
  model?: string;
  stop_reason?: BetaMessage["stop_reason"];
  stop_details?: BetaMessage["stop_details"];
  usage?: Partial<BetaMessage["usage"]>;
  content?: BetaMessage["content"];
}

/** A minimal BetaMessage. Only fields the client reads are meaningful. */
export function makeMessage(o: MessageOverrides = {}): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: o.model ?? "claude-opus-5-5",
    content: o.content ?? [{ type: "text", text: o.text ?? "hello", citations: null }],
    stop_reason: o.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: o.stop_details ?? null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...o.usage,
    },
  } as unknown as BetaMessage;
}

export interface FakeSdk extends AnthropicLike {
  create: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  finalMessage: ReturnType<typeof vi.fn>;
}

/** Fake SDK. `create` and `finalMessage` resolve to `message` unless told otherwise. */
export function makeFakeSdk(message: BetaMessage = makeMessage()): FakeSdk {
  const create = vi.fn(async () => message);
  const finalMessage = vi.fn(async () => message);
  const stream = vi.fn(() => ({ finalMessage }));
  return { beta: { messages: { create, stream } }, create, stream, finalMessage } as FakeSdk;
}

type LogFn = Logger["debug"];

export function makeLogger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}
