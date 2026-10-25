import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { generate } from "otplib";
import { serverEnv } from "../playwright.config";

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = path.join(here, ".state");
export const OWNER_STATE = path.join(STATE_DIR, "owner.json");
export const TOTP_FILE = path.join(STATE_DIR, "totp-secret.txt");
export const readTotpSecret = (): string => readFileSync(TOTP_FILE, "utf8").trim();
export const newTotp = (secret: string) => generate({ secret, strategy: "totp" });

/** Wait until React has hydrated the page's interactive elements (a click before it is lost under `next dev`). */
export async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll("main form, main button, main a")];
    return els.length > 0 && els.every((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")));
  });
}

/** Navigate and wait for hydration. */
export async function open(page: Page, url: string) {
  await page.goto(url);
  await hydrated(page);
}

export const CLIENT = "Rivermoor Dental";
/** A location of the mock Google account. */
export const LOCATION = "Example Trades Collective - Workshop";

/** The owner the server creates on its first start (OWNER_EMAIL / OWNER_PASSWORD in the config). */
export const OWNER = { email: serverEnv.OWNER_EMAIL ?? "", password: serverEnv.OWNER_PASSWORD ?? "" };
