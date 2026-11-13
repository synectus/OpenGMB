import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { seoKeywordsHref, shortCity } from "../../lib/seo-keywords";
import { Pill } from "../page-parts";
import { EmptyState } from "../ui";

export type HistoryRun = {
  id: string;
  seed: string;
  countryIso: string;
  city: string | null;
  status: "queued" | "running" | "done" | "failed";
  rowCount: number;
  createdAt: string;
};

/** The last 20 searches of a workspace. `charged` maps a run id to its already-formatted amount; the page passes it to staff only. */
export async function ResearchHistory({ runs, workspaceId, charged }: { runs: HistoryRun[]; workspaceId: string; charged?: Record<string, string> }) {
  const t = await getTranslations("seoKeywords");
  if (runs.length === 0) return <EmptyState title={t("page.emptyHistory")}>{t("page.emptyHistoryHint")}</EmptyState>;
  return (
    <section aria-label={t("history.heading")} className="flex flex-col gap-2">
      <h2 className="font-display text-base font-bold text-foreground">{t("history.heading")}</h2>
      <ul className="flex flex-col divide-y divide-border rounded-panel border border-border bg-card">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <Link href={seoKeywordsHref({ ws: workspaceId, run: r.id })} className="font-semibold text-brand-text underline underline-offset-2">
              {r.seed}
            </Link>
            <span className="text-muted-foreground">{r.city ? shortCity(r.city) : t(`countries.${r.countryIso}`)}</span>
            <span className="text-muted-foreground">{r.createdAt.slice(0, 10)}</span>
            <span className="text-muted-foreground">{t("history.rows", { count: r.rowCount })}</span>
            <Pill tone={r.status === "done" ? "good" : r.status === "failed" ? "bad" : "warn"}>{t(`history.status.${r.status}`)}</Pill>
            {charged?.[r.id] ? <span className="text-muted-foreground">{charged[r.id]}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
