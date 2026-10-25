import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LANG_COOKIE, parseLocale } from "../lib/i18n";
import { MESSAGES } from "../messages";

// No locale in the URL: the app is behind sign-in, so the language is the user's cookie (Your
// account). No cookie means English, always: the browser's Accept-Language is deliberately
// ignored, because Hindi and Spanish are unsigned drafts and most pages are still English.
export default getRequestConfig(async () => {
  const locale = parseLocale((await cookies()).get(LANG_COOKIE)?.value);
  return { locale, messages: MESSAGES[locale] };
});
