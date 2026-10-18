import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed parameters are intentionally unused (e.g. a tool that needs no deps).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // stdout is the MCP protocol channel. A stray console.log breaks the
    // server, so only console.error and console.warn (both stderr) are allowed.
    files: ["src/**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
);
