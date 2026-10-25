import { getTranslations } from "next-intl/server";
import type { rankingsList } from "@opengmb/core";
import { rankings_list } from "../../app/_generated/actions";
import { Pill } from "../page-parts";
import { EmptyState, ErrorText } from "../ui";
import { NotLiveNote } from "./badges";
import { KeywordRankTable } from "./keyword-rank-table";
import { PreviewAndRun } from "./preview-and-run";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

/** The Keyword rank tab: per location, each tracked keyword's local pack and organic position, daily. */
export async function KeywordRankView({ canManage, sample }: { canManage: boolean; sample: boolean }) {
  const t = await getTranslations("geogrid");
  const res = await rankings_list({});
  if (!res.ok) return <ErrorText message={`${res.error.code}: ${res.error.message}`} />;
  const { trackers } = res.data as Handler<typeof rankingsList>;
  if (trackers.length === 0) {
    return <EmptyState title={t("keywords.empty")}>{t("keywords.emptyHint")}</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">{t("keywords.description")}</p>
        <p className="text-xs text-muted-foreground">{t("keywords.localPackNote")}</p>
        <p className="text-xs text-muted-foreground">{t("keywords.organicNote")}</p>
        {sample && <NotLiveNote>{t("keywords.sampleNote")}</NotLiveNote>}
      </div>
      {trackers.map((tr) => (
        <section key={tr.configId} aria-label={tr.locationTitle} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-bold text-foreground">{tr.locationTitle}</h2>
            <Pill>{tr.active ? t(`schedule.${tr.schedule}`) : t("keywords.inactive")}</Pill>
            {tr.targetDomain ? <span className="text-sm text-muted-foreground">{tr.targetDomain}</span> : null}
          </div>
          {!tr.targetDomain && <p className="text-sm text-muted-foreground">{t("keywords.noWebsite")}</p>}
          {tr.nextRunAt && (
            <p className="text-xs text-muted-foreground">{t("keywords.nextCheck", { date: tr.nextRunAt.slice(0, 10) })}</p>
          )}
          <KeywordRankTable configId={tr.configId} rows={tr.keywords} canManage={canManage} />
          {canManage && tr.active && (
            <div className="flex flex-wrap gap-2">
              <PreviewAndRun
                configId={tr.configId}
                driverId="dataforseo_serp"
                gridSize={1}
                keywordCount={tr.keywords.length}
                label={t("keywords.checkNow")}
                sample={sample}
              />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
