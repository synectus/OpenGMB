// UI language: English, Hindi and Spanish. Same pattern as theme and density: a cosmetic cookie
// that only ever holds a known value, so the choice can never inject anything.
export const LANG_COOKIE = "syngmb_lang";

export const LOCALES = ["en", "hi", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Each language in its own script, never translated, so a person lost in another language can find theirs. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", hi: "हिन्दी", es: "Español" };

export function parseLocale(v: string | undefined | null): Locale {
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : DEFAULT_LOCALE;
}
