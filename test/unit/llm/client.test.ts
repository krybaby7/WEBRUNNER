import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLlmClient, FALLBACK_BETA } from "../../../src/core/llm/client.js";
import { CostMeter } from "../../../src/core/llm/cost.js";
import { LlmError, ROLES, type Role } from "../../../src/core/llm/types.js";
import {
  makeConfig,
  makeFakeSdk,
  makeLogger,
  makeMessage,
  type CreateParams,
} from "./helpers.js";

const userMsg = [{ role: "user" as const, content: "hi" }];

function firstCall(sdk: ReturnType<typeof makeFakeSdk>, kind: "create" | "stream" = "create"): CreateParams {
  const call = sdk[kind].mock.calls[0] as unknown[];
  return call[0] as CreateParams;
}

async function caught(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error("expected the call to throw");
}

describe("request shape", () => {
  const expectedModel: Record<Role, string> = {
    planner: "claude-opus-5-5",
    scorer: "claude-haiku-5-5",
    extractor: "claude-sonnet-5-5",
    writer: "claude-opus-5-5",
  };
  const expectedEffort: Record<Role, string> = {
    planner: "high",
    scorer: "low",
    extractor: "medium",
    writer: "high",
  };

  it.each(ROLES)("%s: routed model, effort, betas, fallbacks, cached system block", async (role) => {
    const sdk = makeFakeSdk();
    const client = createLlmClient(makeConfig(), { sdk });
    // Writer defaults to 32000 tokens and streams; pass a small cap to inspect `create` for every role.
    await client.complete({ role, system: "SYS", messages: userMsg, maxTokens: 1000 });

    const params = firstCall(sdk);
    expect(params.model).toBe(expectedModel[role]);
    expect(params.output_config?.effort).toBe(expectedEffort[role]);
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(params.betas).toContain("server-side-fallback-2026-07-01");
    expect(params.fallbacks).toBe("default");
    expect(params.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    expect(params.messages).toEqual(userMsg);
  });

  it("never sends budget_tokens, thinking disabled, or forced tool_choice", async () => {
    const sdk = makeFakeSdk(makeMessage({ text: '{"a":"x"}' }));
    const client = createLlmClient(makeConfig(), { sdk });
    await client.complete({ role: "planner", system: "s", messages: userMsg, schema: z.object({ a: z.string() }) });

    const params = firstCall(sdk) as unknown as Record<string, unknown>;
    expect(JSON.stringify(params)).not.toContain("budget_tokens");
    const thinking = params["thinking"] as { type?: string } | undefined;
    expect(thinking?.type).not.toBe("disabled");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("tools");
  });

  it("honors model overrides from config.models", async () => {
    const sdk = makeFakeSdk();
    const config = makeConfig({
      models: { planner: "custom-planner", scorer: "s", extractor: "e", writer: "w" },
    });
    await createLlmClient(config, { sdk }).complete({ role: "planner", system: "s", messages: userMsg });
    expect(firstCall(sdk).model).toBe("custom-planner");
  });

  it("explicit effort and maxTokens override the role defaults", async () => {
    const sdk = makeFakeSdk();
    await createLlmClient(makeConfig(), { sdk }).complete({
      role: "scorer",
      system: "s",
      messages: userMsg,
      effort: "xhigh",
      maxTokens: 123,
    });
    const params = firstCall(sdk);
    expect(params.output_config?.effort).toBe("xhigh");
    expect(params.max_tokens).toBe(123);
  });

  it("defaults max_tokens to 8192, and 32000 for the writer", async () => {
    const sdk = makeFakeSdk();
    const client = createLlmClient(makeConfig(), { sdk });
    await client.complete({ role: "extractor", system: "s", messages: userMsg });
    expect(firstCall(sdk).max_tokens).toBe(8192);

    const sdk2 = makeFakeSdk();
    await createLlmClient(makeConfig(), { sdk: sdk2 }).complete({ role: "writer", system: "s", messages: userMsg });
    expect(firstCall(sdk2, "stream").max_tokens).toBe(32000);
  });

  it("omits the system block for an empty system prompt", async () => {
    const sdk = makeFakeSdk();
    await createLlmClient(makeConfig(), { sdk }).complete({ role: "scorer", system: "", messages: userMsg });
    expect(firstCall(sdk)).not.toHaveProperty("system");
  });

  it("can disable fallbacks", async () => {
    const sdk = makeFakeSdk();
    await createLlmClient(makeConfig(), { sdk, fallbacks: false }).complete({
      role: "scorer",
      system: "s",
      messages: userMsg,
    });
    const params = firstCall(sdk);
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("forwards the abort signal", async () => {
    const sdk = makeFakeSdk();
    const controller = new AbortController();
    await createLlmClient(makeConfig(), { sdk }).complete({
      role: "scorer",
      system: "s",
      messages: userMsg,
      signal: controller.signal,
    });
    const options = (sdk.create.mock.calls[0] as unknown[])[1] as { signal?: AbortSignal };
    expect(options.signal).toBe(controller.signal);
  });
});

describe("streaming", () => {
  it("uses create at exactly 16000 tokens", async () => {
    const sdk = makeFakeSdk();
    await createLlmClient(makeConfig(), { sdk }).complete({
      role: "writer",
      system: "s",
      messages: userMsg,
      maxTokens: 16000,
    });
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(sdk.stream).not.toHaveBeenCalled();
  });

  it("uses stream and finalMessage above 16000 tokens", async () => {
    const sdk = makeFakeSdk(makeMessage({ text: "streamed" }));
    const res = await createLlmClient(makeConfig(), { sdk }).complete({
      role: "writer",
      system: "s",
      messages: userMsg,
      maxTokens: 16001,
    });
    expect(sdk.stream).toHaveBeenCalledOnce();
    expect(sdk.finalMessage).toHaveBeenCalledOnce();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(res.text).toBe("streamed");
  });

  it("maps errors raised by finalMessage()", async () => {
    const sdk = makeFakeSdk();
    sdk.finalMessage.mockRejectedValueOnce(new APIConnectionError({ message: "socket hang up" }));
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "writer", system: "s", messages: userMsg }),
    );
    expect(err.kind).toBe("network");
  });
});

describe("response handling", () => {
  it("returns text, usage, cost, model and stop reason", async () => {
    const sdk = makeFakeSdk(
      makeMessage({
        text: "answer",
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 4000,
        },
      }),
    );
    const res = await createLlmClient(makeConfig(), { sdk }).complete({
      role: "extractor",
      system: "s",
      messages: userMsg,
    });
    expect(res.text).toBe("answer");
    expect(res.parsed).toBeUndefined();
    expect(res.model).toBe("claude-sonnet-5-5");
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 4000,
    });
    // 1000*2 + 500*10 + 2000*0.2 + 4000*2.5 = 17400 per MTok
    expect(res.costUsd).toBeCloseTo(0.0174, 10);
  });

  it("treats null cache usage as zero and skips thinking blocks when reading text", async () => {
    const sdk = makeFakeSdk(
      makeMessage({
        usage: { cache_read_input_tokens: null, cache_creation_input_tokens: null },
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "a", citations: null },
          { type: "text", text: "b", citations: null },
        ] as never,
      }),
    );
    const res = await createLlmClient(makeConfig(), { sdk }).complete({ role: "scorer", system: "s", messages: userMsg });
    expect(res.text).toBe("ab");
    expect(res.usage.cacheReadTokens).toBe(0);
    expect(res.usage.cacheWriteTokens).toBe(0);
  });

  it("prices by the model that served the response (fallback)", async () => {
    const sdk = makeFakeSdk(makeMessage({ model: "claude-fable-5-1", usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
    const res = await createLlmClient(makeConfig(), { sdk }).complete({ role: "planner", system: "s", messages: userMsg });
    expect(res.model).toBe("claude-fable-5-1");
    expect(res.costUsd).toBeCloseTo(10, 10);
  });

  it("logs each call at debug level without prompt contents", async () => {
    const sdk = makeFakeSdk();
    const logger = makeLogger();
    await createLlmClient(makeConfig(), { sdk, logger }).complete({
      role: "planner",
      system: "SECRET-SYSTEM-PROMPT",
      messages: [{ role: "user", content: "SECRET-USER-PROMPT" }],
    });
    expect(logger.debug).toHaveBeenCalledOnce();
    const [, fields] = logger.debug.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ role: "planner", model: "claude-opus-5-5", effort: "high" });
    expect(fields).toHaveProperty("usage");
    expect(fields).toHaveProperty("cost_usd");
    expect(fields).toHaveProperty("elapsed_ms");
    const logged = JSON.stringify(logger.debug.mock.calls);
    expect(logged).not.toContain("SECRET");
    expect(logged).not.toContain("test-key");
  });
});

describe("structured output", () => {
  const schema = z.object({ answer: z.string(), score: z.number() });

  it("sends output_config.format derived from the zod schema", async () => {
    const sdk = makeFakeSdk(makeMessage({ text: JSON.stringify({ answer: "x", score: 1 }) }));
    await createLlmClient(makeConfig(), { sdk }).complete({ role: "extractor", system: "s", messages: userMsg, schema });
    const params = firstCall(sdk);
    const format = params.output_config?.format;
    expect(format?.type).toBe("json_schema");
    expect(format?.schema).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" }, score: { type: "number" } },
      additionalProperties: false,
    });
    // Effort stays present alongside the format.
    expect(params.output_config?.effort).toBe("medium");
    // The SDK helper's parse function must not leak into the request body.
    expect(Object.keys(format ?? {}).sort()).toEqual(["schema", "type"]);
  });

  it("parses and validates the JSON, returning parsed data", async () => {
    const sdk = makeFakeSdk(makeMessage({ text: JSON.stringify({ answer: "x", score: 1 }) }));
    const res = await createLlmClient(makeConfig(), { sdk }).complete({
      role: "extractor",
      system: "s",
      messages: userMsg,
      schema,
    });
    expect(res.parsed).toEqual({ answer: "x", score: 1 });
    expect(res.text).toBe('{"answer":"x","score":1}');
  });

  it("applies zod transforms and defaults to the parsed value", async () => {
    const withDefault = z.object({ n: z.coerce.number(), tag: z.string().default("none") });
    const sdk = makeFakeSdk(makeMessage({ text: '{"n":"7"}' }));
    const res = await createLlmClient(makeConfig(), { sdk }).complete({
      role: "extractor",
      system: "s",
      messages: userMsg,
      schema: withDefault,
    });
    expect(res.parsed).toEqual({ n: 7, tag: "none" });
  });

  it("throws kind schema on a mismatch", async () => {
    const sdk = makeFakeSdk(makeMessage({ text: JSON.stringify({ answer: 5 }) }));
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "extractor", system: "s", messages: userMsg, schema }),
    );
    expect(err.kind).toBe("schema");
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(false);
  });

  it("throws kind schema on non-JSON text and on empty output", async () => {
    const bad = makeFakeSdk(makeMessage({ text: "not json" }));
    const e1 = await caught(
      createLlmClient(makeConfig(), { sdk: bad }).complete({ role: "extractor", system: "s", messages: userMsg, schema }),
    );
    expect(e1.kind).toBe("schema");

    const empty = makeFakeSdk(makeMessage({ content: [] }));
    const e2 = await caught(
      createLlmClient(makeConfig(), { sdk: empty }).complete({ role: "extractor", system: "s", messages: userMsg, schema }),
    );
    expect(e2.kind).toBe("schema");
  });

  it("mentions truncation when the JSON was cut off at max_tokens", async () => {
    const sdk = makeFakeSdk(makeMessage({ text: '{"answer":"x', stop_reason: "max_tokens" }));
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "extractor", system: "s", messages: userMsg, schema }),
    );
    expect(err.kind).toBe("schema");
    expect(err.message).toContain("max_tokens");
  });

  it("still records cost when validation fails", async () => {
    const meter = new CostMeter();
    const sdk = makeFakeSdk(makeMessage({ text: "nope" }));
    await caught(
      createLlmClient(makeConfig(), { sdk, meter }).complete({ role: "extractor", system: "s", messages: userMsg, schema }),
    );
    expect(meter.calls).toBe(1);
    expect(meter.totalCostUsd).toBeGreaterThan(0);
  });
});

describe("refusals", () => {
  const details = { type: "refusal", category: "cyber", explanation: "declined", fallback_credit_token: null };

  it("throws kind refusal, not retryable, carrying stop_details", async () => {
    const sdk = makeFakeSdk(
      makeMessage({
        stop_reason: "refusal",
        stop_details: details as never,
        content: [{ type: "text", text: "partial text that must not be returned", citations: null }],
      }),
    );
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "planner", system: "s", messages: userMsg }),
    );
    expect(err.kind).toBe("refusal");
    expect(err.code).toBe("provider");
    expect(err.retryable).toBe(false);
    expect(err.details).toMatchObject({ stop_details: details });
  });

  it("refuses before schema validation, even when the content is empty", async () => {
    const sdk = makeFakeSdk(makeMessage({ stop_reason: "refusal", stop_details: null, content: [] }));
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({
        role: "planner",
        system: "s",
        messages: userMsg,
        schema: z.object({ a: z.string() }),
      }),
    );
    expect(err.kind).toBe("refusal");
  });

  it("still meters the tokens of a refused call", async () => {
    const meter = new CostMeter();
    const sdk = makeFakeSdk(makeMessage({ stop_reason: "refusal" }));
    await caught(createLlmClient(makeConfig(), { sdk, meter }).complete({ role: "planner", system: "s", messages: userMsg }));
    expect(meter.calls).toBe(1);
  });
});

describe("SDK error mapping", () => {
  const cases: Array<{
    name: string;
    error: () => unknown;
    code: LlmError["code"];
    kind: LlmError["kind"];
    retryable: boolean;
  }> = [
    {
      name: "RateLimitError (429)",
      error: () => APIError.generate(429, { error: { type: "rate_limit_error", message: "slow" } }, "slow", new Headers()),
      code: "provider",
      kind: "rate_limit",
      retryable: true,
    },
    {
      name: "APIConnectionError",
      error: () => new APIConnectionError({ message: "ECONNRESET" }),
      code: "provider",
      kind: "network",
      retryable: true,
    },
    {
      name: "APIConnectionTimeoutError",
      error: () => new APIConnectionTimeoutError(),
      code: "timeout",
      kind: "network",
      retryable: true,
    },
    {
      name: "APIUserAbortError",
      error: () => new APIUserAbortError(),
      code: "timeout",
      kind: "network",
      retryable: false,
    },
    {
      name: "500 InternalServerError",
      error: () => APIError.generate(500, { error: { type: "api_error", message: "boom" } }, "boom", new Headers()),
      code: "provider",
      kind: "api",
      retryable: true,
    },
    {
      name: "529 overloaded",
      error: () => APIError.generate(529, { error: { type: "overloaded_error", message: "busy" } }, "busy", new Headers()),
      code: "provider",
      kind: "api",
      retryable: true,
    },
    {
      name: "400 BadRequestError",
      error: () => APIError.generate(400, { error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers()),
      code: "provider",
      kind: "api",
      retryable: false,
    },
    {
      name: "404 NotFoundError",
      error: () => APIError.generate(404, { error: { type: "not_found_error", message: "no model" } }, "no model", new Headers()),
      code: "provider",
      kind: "api",
      retryable: false,
    },
    {
      name: "401 AuthenticationError",
      error: () => APIError.generate(401, { error: { type: "authentication_error", message: "bad key" } }, "bad key", new Headers()),
      code: "config",
      kind: "api",
      retryable: false,
    },
  ];

  it.each(cases)("$name", async ({ error, code, kind, retryable }) => {
    const sdk = makeFakeSdk();
    sdk.create.mockRejectedValueOnce(error());
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "scorer", system: "s", messages: userMsg }),
    );
    expect(err.code).toBe(code);
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.cause).toBeDefined();
  });

  it("does not wrap unrelated errors", async () => {
    const sdk = makeFakeSdk();
    sdk.create.mockRejectedValueOnce(new TypeError("bug in the caller"));
    await expect(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "scorer", system: "s", messages: userMsg }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("never leaks the API key in error messages", async () => {
    const sdk = makeFakeSdk();
    sdk.create.mockRejectedValueOnce(
      APIError.generate(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()),
    );
    const err = await caught(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "scorer", system: "s", messages: userMsg }),
    );
    expect(err.message).not.toContain("test-key");
  });
});

describe("not configured", () => {
  it("throws config / not_configured when ANTHROPIC_API_KEY is unset", async () => {
    const sdk = makeFakeSdk();
    const config = makeConfig();
    delete config.anthropic_api_key;
    const err = await caught(
      createLlmClient(config, { sdk }).complete({ role: "planner", system: "s", messages: userMsg }),
    );
    expect(err.code).toBe("config");
    expect(err.kind).toBe("not_configured");
    expect(err.retryable).toBe(false);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.stream).not.toHaveBeenCalled();
  });
});

describe("budget", () => {
  it("blocks the next call once the client meter has reached its cap", async () => {
    const meter = new CostMeter({ maxCostUsd: 0.0001 });
    // 100k output tokens on Opus 5.5 is $2: one call blows well past the cap.
    const sdk = makeFakeSdk(makeMessage({ usage: { input_tokens: 0, output_tokens: 100_000 } }));
    const client = createLlmClient(makeConfig(), { sdk, meter });

    const first = await client.complete({ role: "planner", system: "s", messages: userMsg });
    expect(first.costUsd).toBeCloseTo(2, 10);

    const err = await caught(client.complete({ role: "planner", system: "s", messages: userMsg }));
    expect(err.code).toBe("budget_exceeded");
    expect(err.retryable).toBe(false);
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("also honors a per-request meter", async () => {
    const perRun = new CostMeter({ maxCostUsd: 1 });
    const sdk = makeFakeSdk(makeMessage({ usage: { input_tokens: 0, output_tokens: 100_000 } }));
    const client = createLlmClient(makeConfig(), { sdk });
    await client.complete({ role: "planner", system: "s", messages: userMsg, meter: perRun });
    expect(perRun.totalCostUsd).toBeCloseTo(2, 10);
    const err = await caught(client.complete({ role: "planner", system: "s", messages: userMsg, meter: perRun }));
    expect(err.code).toBe("budget_exceeded");
    // A call without that meter is unaffected.
    await expect(client.complete({ role: "planner", system: "s", messages: userMsg })).resolves.toBeDefined();
  });
});

describe("misc", () => {
  it("passes through an LlmError thrown by the transport unchanged", async () => {
    const sdk = makeFakeSdk();
    const original = new LlmError("provider", "api", "x", { retryable: false });
    sdk.create.mockRejectedValueOnce(original);
    await expect(
      createLlmClient(makeConfig(), { sdk }).complete({ role: "scorer", system: "s", messages: userMsg }),
    ).rejects.toBe(original);
  });

  it("is pure with respect to the request object", async () => {
    const sdk = makeFakeSdk();
    const req = { role: "scorer" as const, system: "s", messages: [...userMsg] };
    const frozen = JSON.stringify(req);
    await createLlmClient(makeConfig(), { sdk }).complete(req);
    expect(JSON.stringify(req)).toBe(frozen);
    expect(vi.isMockFunction(sdk.create)).toBe(true);
  });
});
