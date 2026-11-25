import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**"],
    ignores: ["src/lib/zod.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [{ name: "zod", message: "Import z from @/lib/zod: it keeps Zod from using eval, which the security policy refuses." }] }] },
  },
  // No god components or functions (owner, 24 Nov 2026): each does one thing, small enough to read
  // whole. Raise these only with a reason written beside the change.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/database.types.ts"], // generated from the database
    rules: {
      "max-lines-per-function": ["error", { max: 120, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 20],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
