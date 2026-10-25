// The translator the Reviews tool libs (review-analytics, bulk-reply) take. Callers pass the page's own
// `t` (useTranslations / getTranslations on "reviewsTools"); with none, English comes from the same
// message file, so there is one source of text and the libs stay callable from plain tests.
import { createTranslator } from "next-intl";
import reviewsTools from "../messages/pages/reviewsTools";

export type Tr = (key: string, values?: Record<string, string | number>) => string;

export const enTr: Tr = createTranslator({
  locale: "en",
  messages: { reviewsTools: reviewsTools.en },
  namespace: "reviewsTools",
}) as unknown as Tr;
