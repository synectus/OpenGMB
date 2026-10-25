import { useTranslations } from "next-intl";
import Link from "next/link";
import { Fragment } from "react";
import { Pill, StatusBadge, TableWrap, tdClass, thClass } from "../page-parts";
import { linkClass } from "../ui";
import { locationHref, ratingText, type ListRow } from "../../lib/locations";
import { LocationStatusToggle } from "./location-status-toggle";

export type TableRow = ListRow & {
  stats: {
    reviews: { total: number; avgRating: number | null };
    openChanges: number;
    suspensionOpen: boolean;
  } | null;
};

export function LocationsTable({
  rows,
  canManage,
  importHref,
}: {
  rows: TableRow[];
  canManage: boolean;
  importHref: string;
}) {
  const t = useTranslations("locations");
  return (
    <TableWrap>
      <table className="w-full min-w-[860px] border-collapse text-sm">
        <caption className="sr-only">{t("caption")}</caption>
        <thead className="bg-muted text-left">
          <tr>
            <th scope="col" className={thClass}>{t("colLocation")}</th>
            <th scope="col" className={thClass}>{t("colStatus")}</th>
            <th scope="col" className={thClass}>{t("colGroups")}</th>
            <th scope="col" className={thClass}>{t("colRating")}</th>
            <th scope="col" className={thClass}>{t("colOpenAlerts")}</th>
            <th scope="col" className={`${thClass} text-right`}>{t("colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const inactive = r.status === "inactive";
            return (
              <Fragment key={r.id}>
                <tr className="border-t border-border">
                  <td className={tdClass}>
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={locationHref(r.id)}
                        className={`font-semibold hover:underline ${inactive ? "text-muted-foreground" : "text-foreground"}`}
                      >
                        {r.name}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {[r.addressSummary, r.phone].filter(Boolean).join(" · ")}
                      </span>
                      {r.stats?.suspensionOpen && (
                        <span className="mt-1">
                          <Pill tone="bad">{t("suspensionOpen")}</Pill>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={tdClass}>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className={tdClass}>
                    {r.groups.length === 0 ? (
                      <span className="text-muted-foreground">{t("noGroup")}</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {r.groups.map((g) => (
                          <span key={g.id} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                            {g.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className={`${tdClass} tabular-nums`}>
                    <div className="font-semibold text-foreground">{ratingText(r.stats?.reviews.avgRating ?? null)}</div>
                    <div className="text-xs text-muted-foreground">{(r.stats?.reviews.total ?? 0) === 0 ? t("noReviews") : t("reviewCount", { count: r.stats!.reviews.total })}</div>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>
                    {r.stats && r.stats.openChanges > 0 ? (
                      <Link
                        href={`/locations/${r.id}/changes`}
                        className={linkClass}
                        aria-label={t("openAlertsAria", { count: r.stats.openChanges, name: r.name })}
                      >
                        {r.stats.openChanges}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex items-start justify-end gap-3">
                      {canManage && <LocationStatusToggle id={r.id} name={r.name} status={r.status} />}
                      <Link
                        href={locationHref(r.id)}
                        aria-label={t("openAria", { name: r.name })}
                        className={`${linkClass} py-2`}
                      >
                        {t("open")}
                      </Link>
                    </div>
                  </td>
                </tr>
                {r.needsRelink && (
                  <tr>
                    <td colSpan={6} className="bg-bad-bg px-3 py-2 text-sm text-bad">
                      {t.rich("relinkNote", {
                        link: (chunks) => (
                          <Link href={importHref} className="font-semibold underline underline-offset-2">
                            {chunks}
                          </Link>
                        ),
                      })}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
