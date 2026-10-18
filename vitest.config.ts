import { defineConfig } from "vitest/config";

// Integration tests hit real services and are excluded from the default run.
// RUN_INTEGRATION=1 adds them (each test also gates itself on the keys it needs).
const includeIntegration = process.env["RUN_INTEGRATION"] === "1";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      ...(includeIntegration ? ["test/integration/**/*.test.ts"] : []),
    ],
    testTimeout: 30_000,
  },
});
