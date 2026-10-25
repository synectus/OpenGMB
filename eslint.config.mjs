import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import nextVitals from "eslint-config-next/core-web-vitals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/next-env.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
      "integrations/**",
      // Community stand-ins: they only make sense at their target path in the exported tree (pnpm oss:check).
      "oss/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextVitals.map((c) => ({ ...c, files: ["apps/web/**/*.{ts,tsx,js,mjs}"] })),
  // The community stand-ins (oss/) keep the full module's signatures and ignore the arguments; "_" marks that on purpose.
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
  { settings: { next: { rootDir: "apps/web" } } },
);
