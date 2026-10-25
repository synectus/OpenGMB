import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Vitest does not load .env; CI supplies env directly, so the file is optional.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  // apps/web components import through its `@/` alias.
  resolve: { alias: { "@": new URL("./apps/web", import.meta.url).pathname } },
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    projects: [
      ...["packages/*", "apps/*"].map((g) => ({
        extends: true as const,
        test: { name: g, include: [`${g}/src/**/*.test.ts`] },
      })),
      // Repo tooling: scripts/gate.mjs helpers.
      { extends: true as const, test: { name: "scripts", include: ["scripts/**/*.test.ts"] } },
      // apps/web keeps its code in app/, components/ and lib/ (Next.js layout), not src/.
      {
        extends: true as const,
        test: {
          name: "apps/web",
          include: ["apps/web/lib/**/*.test.ts", "apps/web/scripts/**/*.test.ts"],
        },
      },
    ],
  },
});
