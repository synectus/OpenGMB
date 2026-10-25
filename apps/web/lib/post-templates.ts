// Pure logic for post templates. Client-safe.
import type { T } from "./posts-lists";
import { ctaName } from "./posts-lists";
export type TemplateView = {
  id: string;
  workspaceId: string;
  name: string;
  topicType: "STANDARD" | "EVENT" | "OFFER";
  language: string;
  summary: string;
  cta: { actionType: string; url?: string | null } | null;
  eventTitle: string | null;
  offer: { couponCode?: string | null; redeemOnlineUrl?: string | null; termsConditions?: string | null } | null;
  image: { id: string; name: string; url: string } | null;
  updatedAt: string;
  updatedByName: string;
};
export type Language = { code: string; label: string };

export const languageLabel = (langs: readonly Language[], code: string) =>
  `${langs.find((l) => l.code === code)?.label ?? code} (${code})`;

export function templateMeta(t: T, tpl: TemplateView, langs: readonly Language[]): string {
  const middle = tpl.topicType === "OFFER" ? t("tpl.meta.couponTerms") : tpl.cta ? ctaName(t, tpl.cta.actionType) : t("tpl.meta.noButton");
  return [languageLabel(langs, tpl.language), middle, tpl.image ? t("tpl.meta.image") : t("tpl.meta.noImage")].join(" · ");
}

/**
 * Input for posts.check on a template. EVENT and OFFER posts need event dates, which a template
 * does not hold, so a placeholder event keeps P.event quiet and only content rules are reported.
 */
export function templateCheckPayload(t: TemplateView) {
  return {
    workspaceId: t.workspaceId,
    topicType: t.topicType,
    summary: t.summary,
    cta: t.cta ?? null,
    event:
      t.topicType === "STANDARD"
        ? null
        : { title: t.eventTitle?.trim() || t.name, startDate: "2099-01-01", endDate: "2099-01-01" },
    offer: t.topicType === "OFFER" ? (t.offer ?? null) : null,
    media: t.image ? [{ sourceUrl: t.image.url }] : [],
  };
}

/** The composer's form values for "Use template" (keys match the composer's Form type). */
export function prefillFromTemplate(t: TemplateView) {
  return {
    topicType: t.topicType,
    language: t.language,
    summary: t.summary,
    ctaType: t.cta?.actionType ?? "none",
    ctaUrl: t.cta?.url ?? "",
    title: t.eventTitle ?? "",
    couponCode: t.offer?.couponCode ?? "",
    redeemOnlineUrl: t.offer?.redeemOnlineUrl ?? "",
    termsConditions: t.offer?.termsConditions ?? "",
    image: t.image?.url ?? "",
  };
}
export type ComposerPrefill = ReturnType<typeof prefillFromTemplate>;
