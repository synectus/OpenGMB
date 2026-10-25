import { expect, test } from "@playwright/test";
import { hydrated } from "./support";

// The community edition has one owner and no way to create another account.
test("the sign-up address leads to sign-in, which offers no way to create an account", async ({ page }) => {
  await page.goto("/sign-up");
  await expect(page).toHaveURL(/\/sign-in/);
  await hydrated(page);
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /create an account|sign up/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("the sign-up API refuses, and no account is created", async ({ request }) => {
  const email = `nobody-${Date.now()}@example.test`;
  const res = await request.post("/api/auth/sign-up/email", {
    headers: { origin: "http://localhost:3011" },
    data: { name: "Nobody", email, password: "a-long-enough-password" },
  });
  expect(res.ok()).toBe(false);
  // The same person cannot sign in either: there is no such account.
  const signIn = await request.post("/api/auth/sign-in/email", {
    headers: { origin: "http://localhost:3011" },
    data: { email, password: "a-long-enough-password" },
  });
  expect(signIn.ok()).toBe(false);
});
