import { z } from "zod";
import { postLanguages } from "@opengmb/db";

export type PostLanguage = (typeof postLanguages)[number];

/** A Record, so a code added to `postLanguages` without a name fails typecheck. */
const NAMES: Record<PostLanguage, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  vi: "Vietnamese",
  zh: "Chinese",
  ko: "Korean",
  ja: "Japanese",
  ar: "Arabic",
  hi: "Hindi",
  gu: "Gujarati",
};

/** Every post language for pickers, in `postLanguages` order; label "English (en)". */
export const POST_LANGUAGES: readonly { code: PostLanguage; label: string }[] = postLanguages.map(
  (code) => ({ code, label: `${NAMES[code]} (${code})` }),
);

/** Input schema for a post (or template) language. */
export const postLanguageInput = z.enum(postLanguages);
