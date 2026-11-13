"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatVolume, intentLabel, kdLabel, shortCity } from "../../lib/seo-keywords";
import { TableWrap, tdClass, thClass } from "../page-parts";
import { EmptyState } from "../ui";

export type ResultRow = {
  keyword: string;
  searchVolume: number | null;
  cpc: number | null;
  keywordDifficulty: number | null;
  intent: string;
  localVolume?: number | null;
};
export type ResultRun = {
  seed: string;
  countryIso: string;
  city: string | null;
  status: "queued" | "running" | "done" | "failed";
  dataSource: "fixture" | "sandbox" | "live";
  localVolumeNote: string | null;
};

const MAX_REFRESHES = 60;
const cpcText = (n: number | null, none: string) => (n === null ? none : `$${n.toFixed(2)}`);

export function KeywordResults({ run, rows }: { run: ResultRun; rows: ResultRow[] }) {
  const t = useTranslations("seoKeywords");
  const router = useRouter();
  const [polls, setPolls] = useState(0);
  const waiting = run.status === "queued" || run.status === "running";
  useEffect(() => {
    if (!waiting || polls >= MAX_REFRESHES) return;
    const id = setTimeout(() => {
      setPolls((n) => n + 1);
      router.refresh();
    }, 2000);
    return () => clearTimeout(id);
  }, [waiting, polls, router]);

  const place = run.city ? shortCity(run.city) : t(`countries.${run.countryIso}`);
  const hasCity = !!run.city && !run.localVolumeNote;
  const sorted = [...rows].sort((a, b) => (hasCity ? (b.localVolume ?? -1) - (a.localVolume ?? -1) : (b.searchVolume ?? -1) - (a.searchVolume ?? -1)));
  const none = t("labels.noData");

  if (waiting) {
    return (
      <div role="status" className="rounded-panel border border-border bg-card p-4 text-sm text-muted-foreground">
        {polls >= MAX_REFRESHES ? t("results.stillWorking") : t("results.searching")}
      </div>
    );
  }
  if (run.status === "failed") {
    return (
      <p role="alert" className="text-sm font-medium text-bad">
        {t("results.failed")}
      </p>
    );
  }
  if (rows.length === 0) return <EmptyState title={t("results.empty")} />;

  return (
    <section aria-label={t("results.heading", { seed: run.seed })} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-base font-bold text-foreground">{t("results.heading", { seed: run.seed })}</h2>
        <p className="text-sm text-muted-foreground">{t("results.meta", { count: rows.length, place })}</p>
        {run.dataSource !== "live" && <p className="text-xs text-warn">{t("results.sample")}</p>}
        {run.localVolumeNote && <p className="text-xs text-muted-foreground">{t("results.noLocalVolume")}</p>}
      </div>
      <div className="hidden sm:block">
        <TableWrap>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th scope="col" className={thClass}>{t("results.keyword")}</th>
                {hasCity && <th scope="col" className={thClass}>{t("results.localVolume", { city: place })}</th>}
                <th scope="col" className={thClass}>{t("results.nationalVolume")}</th>
                <th scope="col" className={thClass}>{t("results.difficulty")}</th>
                <th scope="col" className={thClass}>{t("results.intent")}</th>
                <th scope="col" className={thClass}>{t("results.cpc")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.keyword}>
                  <td className={tdClass}>{r.keyword}</td>
                  {hasCity && <td className={tdClass}>{formatVolume(r.localVolume, t)}</td>}
                  <td className={tdClass}>{formatVolume(r.searchVolume, t)}</td>
                  <td className={tdClass}>{r.keywordDifficulty === null ? none : `${r.keywordDifficulty} ${kdLabel(r.keywordDifficulty, t)}`}</td>
                  <td className={tdClass}>{intentLabel(r.intent, t)}</td>
                  <td className={tdClass}>{cpcText(r.cpc, none)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>
      <ul className="flex flex-col gap-2 sm:hidden">
        {sorted.map((r) => (
          <li key={r.keyword} className="flex flex-col gap-1 rounded-panel border border-border bg-card p-3 text-sm">
            <strong className="text-foreground">{r.keyword}</strong>
            {hasCity && (
              <span className="text-muted-foreground">
                {t("results.localVolume", { city: place })}: {formatVolume(r.localVolume, t)}
              </span>
            )}
            <span className="text-muted-foreground">
              {t("results.nationalVolume")}: {formatVolume(r.searchVolume, t)}
            </span>
            <span className="text-muted-foreground">
              {t("results.difficulty")}: {r.keywordDifficulty === null ? none : `${r.keywordDifficulty} ${kdLabel(r.keywordDifficulty, t)}`}
            </span>
            <span className="text-muted-foreground">
              {t("results.intent")}: {intentLabel(r.intent, t)}
            </span>
            <span className="text-muted-foreground">
              {t("results.cpc")}: {cpcText(r.cpc, none)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
