import { useTranslations } from "next-intl";
import Link from "next/link";
import { geogridHref, usd } from "../../lib/rank-tracking";
import type { TimeFormat } from "../../lib/time-format";
import { StatusBadge, TableWrap, tdClass, thClass } from "../page-parts";
import { DriverBadge } from "./badges";

export type HistoryRun = {
  id: string;
  keyword: string;
  status: "queued" | "running" | "done" | "failed";
  driverLabel: string;
  isMapsRank: boolean;
  /** Queue speed this run was requested at. */
  speed: "standard" | "fast";
  costChargedUsd: number | null;
  /** Only "live" is real Google Maps data; the others are sample data. */
  dataSource: "fixture" | "sandbox" | "live";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  summary: { averageRank: number | null; top3Share: number | null; foundShare: number | null };
};

const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);

export function RunHistory({
  configId,
  workspaceId,
  runs,
  currentId,
  tf,
  chargedLabel,
}: {
  configId: string;
  workspaceId?: string;
  runs: HistoryRun[];
  currentId: string | null;
  tf: TimeFormat;
  /** The Charged column header, from the server. Undefined for client roles: Charged is an agency number, so its text must not reach them. */
  chargedLabel?: string;
}) {
  const t = useTranslations("geogrid");
  return (
    <section aria-label={t("history.label")} className="flex flex-col gap-2">
      <h2 className="font-display text-base font-bold text-foreground">{t("history.heading")}</h2>
      <TableWrap>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted">
            <tr>
              {(["when", "keyword", "source", "status", "avgRank", "top3", "found"] as const).map((h) => (
                <th key={h} scope="col" className={thClass}>
                  {t(`history.${h}`)}
                </th>
              ))}
              {chargedLabel && (
                <th scope="col" className={thClass}>
                  {chargedLabel}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((r) => (
              <tr key={r.id} className={r.id === currentId ? "bg-brand-tint" : ""}>
                <td className={tdClass}>
                  <Link
                    href={geogridHref({ config: configId, run: r.id })}
                    aria-current={r.id === currentId ? "true" : undefined}
                    className="font-semibold text-brand-text underline underline-offset-2"
                  >
                    {tf.dateTime(r.finishedAt ?? r.createdAt, workspaceId)}
                  </Link>
                </td>
                <td className={tdClass}>{r.keyword}</td>
                <td className={tdClass}>
                  <DriverBadge label={r.driverLabel} isMapsRank={r.isMapsRank} />
                </td>
                <td className={tdClass}>
                  <StatusBadge status={r.status} />
                </td>
                <td className={`${tdClass} tabular-nums`}>
                  {r.summary.averageRank === null || r.status !== "done" ? "-" : r.summary.averageRank.toFixed(1)}
                </td>
                <td className={`${tdClass} tabular-nums`}>{r.status === "done" ? pct(r.summary.top3Share) : "-"}</td>
                <td className={`${tdClass} tabular-nums`}>{r.status === "done" ? pct(r.summary.foundShare) : "-"}</td>
                {chargedLabel && (
                  <td className={`${tdClass} tabular-nums`}>
                    {r.costChargedUsd === null ? "-" : usd(r.costChargedUsd, t)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}
