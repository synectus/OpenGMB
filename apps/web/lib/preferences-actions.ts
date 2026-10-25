"use server";
import { cookies } from "next/headers";
import { DENSITY_COOKIE, THEME_COOKIE, parseDensity, parseTheme } from "./preferences";
import { LANG_COOKIE, parseLocale } from "./i18n";
import { SCOPE_COOKIE, formatScope, parseScope } from "./scope";

const YEAR = 60 * 60 * 24 * 365;
const options = {
  path: "/",
  maxAge: YEAR,
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};

/** Cosmetic only: an unknown value becomes "system", so the cookie can never hold anything else. */
export async function setTheme(value: string): Promise<void> {
  (await cookies()).set(THEME_COOKIE, parseTheme(value), options);
}

// An invalid value is ignored, so the default density (by location count) keeps applying, unlike theme, which resets to "system".
export async function setDensity(value: string): Promise<void> {
  const density = parseDensity(value);
  if (density) (await cookies()).set(DENSITY_COOKIE, density, options);
}

/** Cosmetic only: an unknown value becomes English, so the cookie can never hold anything else. */
export async function setLanguage(value: string): Promise<void> {
  (await cookies()).set(LANG_COOKIE, parseLocale(value), options);
}

/** The format is checked here; whether the user may see it is checked on every read (currentScope). */
export async function setScope(value: string): Promise<void> {
  const key = parseScope(value);
  if (key) (await cookies()).set(SCOPE_COOKIE, formatScope(key), options);
}
