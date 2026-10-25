import { expect, test } from "@playwright/test";
import { LOCATION, open, OWNER_STATE } from "./support";

test.use({ storageState: OWNER_STATE });

test("a post written for the location waits in Approvals", async ({ page }) => {
  // Letters only: digits in the text can look like a phone number to the guardrail.
  const token = `Spring checkup ${Math.random().toString(36).slice(2, 10).replace(/\d/g, "q")}`;
  await open(page, "/posts?view=compose");
  await page.getByLabel("Summary").fill(`${token}: book online this week.`);
  await page.getByLabel(LOCATION).check();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText(/^Submitted for approval\./)).toBeVisible();

  await open(page, "/approvals");
  await expect(page.getByRole("link", { name: new RegExp(token) })).toBeVisible();
});
