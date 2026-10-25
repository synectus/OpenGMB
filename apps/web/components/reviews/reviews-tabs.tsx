import { useTranslations } from "next-intl";
import { TabLinks } from "../page-parts";
import { reviewsTabs, type ReviewsView } from "../../lib/reviews-views";

export function ReviewsTabs(p: { current: ReviewsView; hasQueue: boolean; canDraft: boolean; ws?: string; queueTab?: { href: string; label: string } }) {
  const t = useTranslations("reviews");
  return (
    <TabLinks
      label={t("tabs.views")}
      items={reviewsTabs(p.current, { hasQueue: p.hasQueue, canDraft: p.canDraft, ws: p.ws, queueTab: p.queueTab }).map((v) => ({
        href: v.href,
        // The queue tab's label is the approvals count from lib/approval-surfaces (shared); the others are translated here.
        label: v.key === "queue" && p.queueTab ? v.label : t(`tabs.${v.key}`),
        current: v.current,
      }))}
    />
  );
}
