import type { Locale } from "../lib/i18n";
import en, { type Messages } from "./en";
import es from "./es";
import hi from "./hi";
import { PAGES } from "./pages";

type Pages = typeof PAGES;
type PageMessages<L extends Locale> = { [K in keyof Pages]: Pages[K][L] };

/** The shell files (en.ts, hi.ts, es.ts) plus one namespace per page group (pages/*.ts). */
function merged<L extends Locale>(locale: L, shell: Messages): Messages & PageMessages<L> {
  const pages = Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [k, (v as Record<Locale, unknown>)[locale]]));
  return { ...shell, ...pages } as Messages & PageMessages<L>;
}

export const MESSAGES = { en: merged("en", en), hi: merged("hi", hi), es: merged("es", es) };
