import { expect, test } from "@playwright/test";
import { CLIENT, hydrated, open, OWNER_STATE } from "./support";

test.use({ storageState: OWNER_STATE });

test("a report is generated, shared by link, and the link opens for someone who is not signed in", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const name = `Monthly numbers ${Math.random().toString(36).slice(2, 8)}`;
  await open(page, "/reports/new");
  await page.getByLabel("Report name").fill(name);
  await page.getByRole("button", { name: "Create report" }).click();
  await page.waitForURL("**/reports");
  await hydrated(page);
  await expect(page.getByRole("region", { name: "Report definitions" })).toContainText(name);

  await page.getByRole("region", { name: "Report definitions" }).getByRole("row").filter({ hasText: name }).getByRole("button", { name: "Generate" }).click();

  // The worker makes the PDF; the delivery history shows the run once it is done.
  const share = page.getByRole("region", { name: "Delivery history" }).getByRole("button", { name: "Share link", exact: true });
  await expect
    .poll(
      async () => {
        await page.reload();
        return share.count();
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBeGreaterThan(0);

  await share.first().click();
  await page.getByLabel("The business has agreed to this public link").check();
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Share link created" })).toBeVisible();
  const url = await page.getByLabel("Share link", { exact: true }).inputValue();
  expect(url).toMatch(/\/r\/[A-Za-z0-9_-]{43}$/);

  // Someone with no account and no cookies opens it.
  const visitor = await browser.newContext();
  const shared = await visitor.newPage();
  const res = await shared.goto(url);
  expect(res?.status()).toBe(200);
  await expect(shared.getByText("This report never includes review text or reviewer names.")).toBeVisible();
  await expect(shared.getByText(CLIENT).first()).toBeVisible();
  await visitor.close();
});
