import { expect, test } from "@playwright/test";
import { CLIENT, hydrated, LOCATION, open, OWNER_STATE } from "./support";

// One owner manages many clients and locations. Google is the mock: the real connect button needs OAuth credentials,
// so a stranger uses "Use the sample Google account" (06-sample-google-seed.spec.ts covers the script seed).
test.use({ storageState: OWNER_STATE });

test("the owner creates a client, connects the mock Google account and imports a location", async ({ page }) => {
  await open(page, "/");
  await page.getByLabel("New client name").fill(CLIENT);
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByRole("button", { name: "Connect Google account" })).toBeVisible();
  // The first-run checklist has no team step: the community edition has no team page.
  await expect(page.getByText(/\d of 5 done/)).toBeVisible();
  await expect(page.getByText(/invite an approver/i)).toHaveCount(0);

  await hydrated(page);
  await page.getByRole("button", { name: "Use the sample Google account" }).click();
  await page.getByRole("link", { name: "Import locations" }).click();
  await page.waitForURL("**/locations/import");
  await hydrated(page);
  await page.getByRole("button", { name: "Load locations" }).click();
  await page.getByLabel(new RegExp(LOCATION)).check();
  await page.getByRole("button", { name: "Import 1 selected" }).click();
  await expect(page.getByRole("list", { name: "Import results" })).toBeVisible({ timeout: 90_000 });

  await open(page, "/locations");
  await expect(page.getByText(LOCATION).first()).toBeVisible();
  await open(page, "/workspaces");
  await expect(page.getByText(CLIENT).first()).toBeVisible();
});
