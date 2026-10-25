import { useTranslations } from "next-intl";
import { Pill, TableWrap, tdClass, thClass } from "../page-parts";

export type CompetitorRow = {
  business: string;
  placeId: string | null;
  appearances: number;
  averageRank: number;
  bestRank: number;
  address: string | null;
  rating: number | null;
  reviewCount: number | null;
  isTarget: boolean;
};

export function CompetitorTable({ rows }: { rows: CompetitorRow[] }) {
  const t = useTranslations("geogrid");
  return (
    <section aria-label={t("competitors.label")}>
      <TableWrap>
        <table className="w-full text-left text-sm">
          <caption className="px-3 py-2 text-left font-display font-bold text-foreground">
            {t("competitors.caption")}
          </caption>
          <thead className="border-b border-border bg-muted">
            <tr>
              {(["business", "address", "rating", "appearances", "avgRank", "best"] as const).map((h) => (
                <th key={h} scope="col" className={thClass}>
                  {t(`competitors.${h}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className={`${tdClass} text-muted-foreground`}>
                  {t("competitors.none")}
                </td>
              </tr>
            ) : (
              rows.slice(0, 25).map((c) => (
                <tr key={c.isTarget ? "you" : (c.placeId ?? c.business)} className={c.isTarget ? "bg-brand-tint" : ""}>
                  <td className={`${tdClass} font-semibold`}>
                    {c.business} {c.isTarget && <Pill>{t("competitors.you")}</Pill>}
                  </td>
                  <td className={tdClass}>{c.address ?? "-"}</td>
                  <td className={`${tdClass} tabular-nums`}>
                    {c.rating === null ? (
                      "-"
                    ) : (
                      <>
                        {c.rating.toFixed(1)} <span aria-hidden>★</span>
                        {c.reviewCount !== null && (
                          <span className="text-muted-foreground"> ({c.reviewCount})</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className={`${tdClass} tabular-nums`}>{c.appearances}</td>
                  <td className={`${tdClass} tabular-nums`}>{c.averageRank.toFixed(1)}</td>
                  <td className={`${tdClass} tabular-nums`}>{c.bestRank}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}
