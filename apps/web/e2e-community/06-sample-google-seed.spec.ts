import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { serverEnv } from "../playwright.config";
import { hydrated, open, OWNER, OWNER_STATE } from "./support";

// The sample Google account from the owner's side (Settings, Google), and the script seed the suite used before the button
// existed. Both write the same row, so the second does nothing.
test.use({ storageState: OWNER_STATE });

test("Settings, Google lists the sample account and no longer offers to connect it", async ({ page }) => {
  await open(page, "/settings/google");
  await expect(page.getByRole("cell", { name: "mock-google@example.test" })).toBeVisible();
  await hydrated(page);
  await expect(page.getByRole("button", { name: "Use the sample Google account" })).toHaveCount(0);
});

test("the script seed finds the sample account already there", () => {
  const out = execFileSync("pnpm", ["exec", "tsx", "e2e-community/mock-google.ts", OWNER.email], { env: serverEnv, encoding: "utf8" });
  expect(out).toContain("created: false");
});
