import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The community edition's end-to-end suite: one owner from the environment, no sign-up, mock Google.
// Run it with: pnpm --filter @opengmb/web test:e2e  (needs DATABASE_URL_TEST: a throwaway database that is wiped first).
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const dbUrl = process.env.DATABASE_URL_TEST;
if (!dbUrl) {
  throw new Error("DATABASE_URL_TEST is not set; refusing to run e2e without a test database");
}

// Fixed, non-default ports so the suite can run next to `pnpm dev` (3000/3100/3200).
export const PORTS = { web: 3011, mcp: 3111, worker: 3211 } as const;
export const WEB_URL = `http://localhost:${PORTS.web}`;


export const serverEnv: Record<string, string> & NodeJS.ProcessEnv = {
  ...(process.env as Record<string, string> & NodeJS.ProcessEnv),
  DATABASE_URL: dbUrl,
  BETTER_AUTH_URL: WEB_URL,
  MCP_PORT: String(PORTS.mcp),
  WORKER_PORT: String(PORTS.worker),
  WORKER_PUBLIC_URL: `http://localhost:${PORTS.worker}`,
  // Test values for this suite only; the database is wiped before every run.
  OWNER_EMAIL: "owner@rivermoor.example",
  OWNER_PASSWORD: "e2e-owner-correct-horse",
  OWNER_ORG_NAME: "Rivermoor Agency",
  GOOGLE_BUSINESS_API_MODE: "mock",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  RESEND_API_KEY: "",
  GOOGLE_MAPS_BROWSER_KEY: "",
  DATAFORSEO_LOGIN: "",
  DATAFORSEO_PASSWORD: "",
  GOOGLE_PLACES_SERVER_KEY: "",
  ANTHROPIC_API_KEY: "",
};

export default defineConfig({
  testDir: "./e2e-community",
  // The specs share one owner and one client and build on each other, in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./e2e-community/global-setup.ts",
  use: { baseURL: WEB_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Wipe and migrate first, so the owner is created from the environment on a fresh database.
      command: `pnpm exec tsx e2e-community/prepare.ts && pnpm exec next dev --port ${PORTS.web}`,
      url: `${WEB_URL}/sign-in`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
