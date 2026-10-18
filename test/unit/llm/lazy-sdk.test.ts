import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "../../../src/core/llm/types.js";
import { makeConfig, makeFakeSdk, makeMessage } from "./helpers.js";

// Replace only the default export (the Anthropic class) so the SDK's error
// classes stay real. The replacement records constructor options and never
// touches the network.
const mocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  sdk: undefined as unknown,
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    beta: unknown;
    constructor(options: unknown) {
      mocks.ctor(options);
      this.beta = (mocks.sdk as { beta: unknown }).beta;
    }
  }
  return { ...original, default: FakeAnthropic };
});

const { createLlmClient } = await import("../../../src/core/llm/client.js");

const userMsg = [{ role: "user" as const, content: "hi" }];

beforeEach(() => {
  mocks.ctor.mockClear();
  mocks.sdk = makeFakeSdk(makeMessage({ text: "ok" }));
});

describe("SDK construction", () => {
  it("never constructs the SDK when ANTHROPIC_API_KEY is unset", async () => {
    const config = makeConfig();
    delete config.anthropic_api_key;
    const client = createLlmClient(config);
    await expect(client.complete({ role: "planner", system: "s", messages: userMsg })).rejects.toMatchObject({
      code: "config",
      kind: "not_configured",
    });
    await expect(client.complete({ role: "scorer", system: "s", messages: userMsg })).rejects.toBeInstanceOf(LlmError);
    expect(mocks.ctor).not.toHaveBeenCalled();
  });

  it("does not construct the SDK until the first call, then reuses it", async () => {
    const client = createLlmClient(makeConfig());
    expect(mocks.ctor).not.toHaveBeenCalled();
    await client.complete({ role: "scorer", system: "s", messages: userMsg });
    await client.complete({ role: "scorer", system: "s", messages: userMsg });
    expect(mocks.ctor).toHaveBeenCalledOnce();
  });

  it("configures a 180 s timeout (milliseconds), 2 retries and the key", async () => {
    await createLlmClient(makeConfig({ anthropic_api_key: "k-123" })).complete({
      role: "scorer",
      system: "s",
      messages: userMsg,
    });
    expect(mocks.ctor).toHaveBeenCalledWith({ apiKey: "k-123", timeout: 180_000, maxRetries: 2 });
  });

  it("does not construct the SDK when one is injected", async () => {
    await createLlmClient(makeConfig(), { sdk: makeFakeSdk() }).complete({
      role: "scorer",
      system: "s",
      messages: userMsg,
    });
    expect(mocks.ctor).not.toHaveBeenCalled();
  });
});
