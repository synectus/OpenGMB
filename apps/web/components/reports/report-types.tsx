import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge } from "../ui";
import { primaryLinkButtonClass } from "../page-parts";

const TYPES = [
  {
    key: "performance",
    name: "typePerformance",
    live: true,
    items: ["typePerformanceItem1", "typePerformanceItem2", "typePerformanceItem3"],
  },
  {
    key: "reviews",
    name: "typeReviews",
    live: true,
    items: ["typeReviewsItem1", "typeReviewsItem2", "typeReviewsItem3"],
  },
] as const;

export function ReportTypes({ counts, canManage }: { counts: Record<string, number>; canManage: boolean }) {
  const t = useTranslations("reports");
  return (
    <section aria-label={t("reportTypes")} className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-base font-bold text-foreground">{t("reportTypes")}</h2>
        <p className="text-sm text-muted-foreground">{t("reportTypesNote")}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {TYPES.map((ty) => (
          <article key={ty.key} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
            <div className="flex items-center gap-2">
              <h3 className="font-display font-bold text-foreground">{t(ty.name)}</h3>
              {!ty.live && <Badge>{t("notLive")}</Badge>}
            </div>
            <ul aria-label={t("contentsOf", { name: t(ty.name) })} className="list-disc pl-5 text-sm text-foreground">
              {ty.items.map((i) => <li key={i}>{t(i)}</li>)}
            </ul>
            <div className="mt-auto flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-foreground">{t("active", { n: counts[ty.key] ?? 0 })}</span>
              {!ty.live && <span className="text-sm text-muted-foreground">{t("designedNotBuilt")}</span>}
              {canManage &&
                (ty.live ? (
                  <Link href={`/reports/new?type=${ty.key}`} className={`${primaryLinkButtonClass} ml-auto`}>{t("create")}</Link>
                ) : (
                  <button type="button" disabled className="ml-auto inline-flex min-h-(--control-h) items-center rounded-control border border-input px-4 text-sm font-semibold text-muted-foreground">{t("create")}</button>
                ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
