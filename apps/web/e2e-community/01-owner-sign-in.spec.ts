import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { hydrated, newTotp, open, OWNER, OWNER_STATE, readTotpSecret, STATE_DIR, TOTP_FILE } from "./support";

// The owner is created from OWNER_EMAIL / OWNER_PASSWORD on the first start. These two specs sign that person in,
// first with two-factor set-up (the first sign-in of every account) and then with a code.
test.describe.configure({ mode: "serial" });

test("the owner from the environment signs in, sets up two-factor and reaches home", async ({ page }) => {
  await open(page, "/sign-in");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Set up two-factor authentication" })).toBeVisible();
  await hydrated(page);
  await page.getByLabel("Confirm your password").fill(OWNER.password);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.locator("code").textContent())!.trim();
  await page.getByLabel("6-digit code").fill(await newTotp(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByText("Two-factor authentication is on.")).toBeVisible();
  await page.getByRole("button", { name: "I saved them, continue" }).click();
  await expect(page.getByText(`Signed in as ${OWNER.email}`)).toBeVisible();

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOTP_FILE, secret);
  await page.context().storageState({ path: OWNER_STATE });
});

test("a second sign-in with the password and a code works, and a wrong password does not", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, "/sign-in");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/mfa/verify");
  await hydrated(page);
  // A community install never had the old product name, so the page does not mention it.
  await expect(page.getByText("Open your authenticator app and enter the code for OpenGMB.")).toBeVisible();
  await expect(page.getByText(/older setups/i)).toHaveCount(0);
  // A code is accepted once: wait for the next 30 second window after the one the set-up used.
  const secret = readTotpSecret();
  const used = await newTotp(secret);
  await expect.poll(async () => (await newTotp(secret)) !== used, { timeout: 40_000, intervals: [1_000] }).toBe(true);
  await page.getByLabel("6-digit code from your authenticator app").fill(await newTotp(secret));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText(`Signed in as ${OWNER.email}`)).toBeVisible();
  await context.close();
});
