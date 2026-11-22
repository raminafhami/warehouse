import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";

export default defineConfig([
  globalIgnores(["**/dist/**", "tools/**", "evidence/**", "reference/**"]),
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: Object.fromEntries(
        [
          "AbortController",
          "AbortSignal",
          "Blob",
          "clearTimeout",
          "console",
          "crypto",
          "document",
          "Event",
          "FormData",
          "File",
          "HTMLInputElement",
          "fetch",
          "process",
          "URL",
          "URLSearchParams",
          "setTimeout",
          "window",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.jsx"],
    rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z]" }] },
  },
  {
    files: ["docker/mongo-*.js"],
    languageOptions: {
      globals: { db: "readonly", quit: "readonly", rs: "readonly" },
    },
  },
]);
