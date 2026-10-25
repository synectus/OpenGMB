import Link from "next/link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import type { locationsHealthcheckSummary, locationsList } from "@opengmb/core";
import { HEALTHCHECK_CONFIG } from "@opengmb/core";
import { RunAgainButton } from "../../../../components/health/run-again-button";
import { LocationsHeader } from "../../../../components/locations/locations-header";
import { EmptyState, ErrorText, Panel, linkClass } from "../../../../components/ui";
import { requireUser } from "../../../../lib/guard";
import {
  averagePercent,
  commonFailing,
  exclusionNote,
  pageNote,
  pageWindow,
  parsePage,
  scoreTone,
  summaryLine,
  topFailing,
} from "../../../../lib/health";
import { scopeFilter } from "../../../../lib/scope";
import { narrowArgs } from "../../../../lib/scope-pages";
import { currentScope } from "../../../../lib/scope-server";
import { locations_healthcheckSummary, locations_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Loc = Handler<typeof locationsList>["locations"][number];

const TEXT = { good: "text-good", warn: "text-warn", bad: "text-bad" } as const;
const CHIP = { necessary: "bg-bad-bg text-bad", important: "bg-warn-bg text-warn", nice: "bg-secondary text-secondary-foreground" } as const;
const LEGEND = [
  { key: "legendGood", cls: "bg-good" },
  { key: "legendWarn", cls: "bg-warn" },
  { key: "legendBad", cls: "bg-bad" },
  { key: "legendNone", cls: "bg-input" },
] as const;

function Running({ count }: { count: number }) {
  const t = useTranslations("locations");
  return (
    <div role="status" className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p)">
      <p className="text-sm text-info">
        {t("runningLine", { count })}
      </p>
      {Array.from({ length: Math.min(count, 4) || 1 }, (_, i) => (
        <div key={i} aria-hidden className="h-10 animate-pulse rounded-control bg-muted" />
      ))}
    </div>
  );
}

const PAGE_SIZE = HEALTHCHECK_CONFIG.summaryPageSize;

async function Results({ ws, urlWs, only, locs, page }: { ws?: string; urlWs: string | null; only: { groupId?: string; locationIds?: string[] }; locs: Loc[]; page: number }) {
  // The group or location scope is paged inside the action, so page 2 of a group is its own 26th to 50th.
  const base = { ...(ws ? { workspaceId: ws } : {}), ...only };
  const t = await getTranslations("locations");
  const first = await locations_healthcheckSummary({ ...base, offset: (page - 1) * PAGE_SIZE });
  if (!first.ok) return <ErrorText message={`${first.error.code}: ${first.error.message}`} />;
  let s = first.data as Handler<typeof locationsHealthcheckSummary>;
  const w = pageWindow(page, PAGE_SIZE, s.total);
  if (w.page !== page) {
    // A stale link past the last page: show the last one instead of an empty list.
    const last = await locations_healthcheckSummary({ ...base, offset: w.offset });
    if (!last.ok) return <ErrorText message={`${last.error.code}: ${last.error.message}`} />;
    s = last.data as Handler<typeof locationsHealthcheckSummary>;
  }
  const rows = s.locations;
  const href = (p: number) => `/locations/health?${new URLSearchParams({ ...(urlWs ? { ws: urlWs } : {}), page: String(p) })}`;
  const avg = averagePercent(rows);
  const excluded = exclusionNote(locs);
  const common = commonFailing(rows);

  return (
    <>
      <section aria-label={t("summaryLabel")} className="flex flex-wrap items-start justify-between gap-4 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <div className="flex flex-col gap-1">
          <p className="font-display text-lg font-bold text-foreground">{summaryLine(rows.length, locs.length, avg)}</p>
          {excluded && <p className="text-sm text-muted-foreground">{excluded}</p>}
          <p className="text-xs text-muted-foreground">{pageNote(w, PAGE_SIZE)}</p>
        </div>
        <RunAgainButton
          title={t("runningTitle")}
          detail={t("runningDetail", { count: rows.length })}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-label={t("rankedLabel")} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
          <h2 className="font-display text-base font-bold text-foreground">{t("lowestFirst")}</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noneChecked")}</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {rows.map((l, i) => {
                const tone = scoreTone(l.score.percent);
                return (
                  <li key={l.locationId} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="w-6 text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="font-semibold text-foreground">{l.name}</span>
                      <span className="text-xs text-muted-foreground">{t("necessaryFailing", { count: l.failingNecessary })}</span>
                      <span className="flex flex-wrap gap-1">
                        {topFailing(l.failing).map((f) => (
                          <span key={f.id} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${CHIP[f.importance]}`}>
                            {f.title}
                          </span>
                        ))}
                      </span>
                    </div>
                    <span className={`font-display text-xl font-extrabold tabular-nums ${TEXT[tone]}`}>{l.score.percent}%</span>
                    <Link href={`/locations/${l.locationId}/health`} aria-label={t("openHealthAria", { name: l.name })} className={linkClass}>
                      {t("open")}
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
          {w.pages > 1 && (
            <nav aria-label={t("healthPagesNav")} className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
              {w.hasPrev ? <Link href={href(w.page - 1)} className={linkClass}>{t("prevPage")}</Link> : <span />}
              <span className="text-muted-foreground">{t("pageOf", { page: w.page, pages: w.pages })}</span>
              {w.hasNext ? <Link href={href(w.page + 1)} className={linkClass}>{t("nextPage")}</Link> : <span />}
            </nav>
          )}
        </section>

        <div className="flex flex-col gap-5">
          <Panel title={t("commonFailing")}>
            {common.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noFailing")}</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {common.map((m) => (
                  <li key={m.title} className="flex justify-between gap-3">
                    <span className="text-foreground">{m.title}</span>
                    <span className="tabular-nums text-muted-foreground">{m.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <section aria-label={t("mapTitle")} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-foreground">{t("mapTitle")}</h2>
              <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn">{t("notLive")}</span>
            </div>
            <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {LEGEND.map((g) => (
                <li key={g.key} className="flex items-center gap-1.5">
                  <span aria-hidden className={`size-2.5 rounded-full ${g.cls}`} />
                  {t(g.key)}
                </li>
              ))}
            </ul>
            <div className="flex aspect-[4/3] items-center justify-center rounded-control border border-dashed border-input bg-muted p-4 text-center text-sm text-muted-foreground">
              {t("mapPlaceholder")}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export default async function LocationsHealthPage({ searchParams }: { searchParams: Promise<{ ws?: string; page?: string }> }) {
  await requireUser();
  const t = await getTranslations("locations");
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const scope = await currentScope(sp.ws);
  const ws = scope.workspaceId ?? undefined;
  // A group or location scope is passed to the summary, which pages inside it.
  const only = narrowArgs(scope);
  const locRes = await locations_list(scopeFilter(scope));
  const header = <LocationsHeader view="health" ws={scope.urlWs} />;
  if (!locRes.ok) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <ErrorText message={`${locRes.error.code}: ${locRes.error.message}`} />
      </div>
    );
  }
  const locs = (locRes.data as Handler<typeof locationsList>).locations;
  const eligible = locs.filter((l) => l.status === "active" && l.googleLocationId !== null && !l.needsRelink).length;

  return (
    <div className="flex flex-col gap-5">
      {header}
      {eligible === 0 ? (
        <EmptyState title={t("healthEmptyTitle")}>{t("healthEmptyBody")}</EmptyState>
      ) : (
        <Suspense key={`${scope.value}:${page}`} fallback={<Running count={Math.min(eligible, PAGE_SIZE)} />}>
          <Results ws={ws} urlWs={scope.urlWs ?? null} only={only} locs={locs} page={page} />
        </Suspense>
      )}
    </div>
  );
}
