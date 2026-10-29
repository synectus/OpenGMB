import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type {
  performanceActivity,
  performanceByLocation,
  performanceKeywords,
  performanceSummary,
} from "@opengmb/core";
import { PERFORMANCE_CONFIG, isYmd, roleHasPermission } from "@opengmb/core";
import { ChooseClient } from "../../../components/choose-client";
import { LineChart } from "../../../components/line-chart";
import { PerformanceRefresh } from "../../../components/performance-refresh";
import {
  ActivityPanel,
  ByLocation,
  DeviceSplit,
  KeywordTable,
  KpiTiles,
} from "../../../components/performance/panels";
import { filterFieldClass, linkButtonClass } from "../../../components/page-parts";
import { EmptyState, ErrorText, PageHeader, buttonClass } from "../../../components/ui";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import {
  PRESETS,
  daysIn,
  matchPreset,
  outcomeSentence,
  performanceHref,
  periodPhrase,
  presetRange,
} from "../../../lib/performance";
import { PERFORMANCE_MAX_LOCATIONS, performanceTarget, refreshLocationId } from "../../../lib/scope-pages";
import { currentScope, scopeData } from "../../../lib/scope-server";
import { getTimeFormat } from "../../../lib/time-format-server";
import {
  performance_activity,
  performance_byLocation,
  performance_keywords,
  performance_summary,
} from "../../_generated/actions";
import { EmptyNext } from "../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Res = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const err = (r: Res | null) => (r && !r.ok ? `${r.error.code}: ${r.error.message}` : null);
const TILE_KEYS = ["impressionsMaps", "impressionsSearch", "calls", "websiteClicks", "directions"] as const;

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; scope?: string; from?: string; to?: string; kpi?: string }>;
}) {
  const { userId } = await requireUser();
  const t = await getTranslations("performance");
  const { role } = await actorContextFor(userId);
  const canRefresh = roleHasPermission(role, "report:manage");
  const canTrack = roleHasPermission(role, "geogrid:manage");
  const q = await searchParams;
  const tf = await getTimeFormat(q.ws ?? q.scope);
  const today = tf.today(); // the client's own day, so "yesterday" is theirs
  const def = presetRange("30", today);
  const range = q.from && q.to && isYmd(q.from) && isYmd(q.to) ? { from: q.from, to: q.to } : def;

  // ?scope=l:<id> is what the location hub linked to before; ?ws= is everyone else's deep link.
  const scope = await currentScope(q.ws ?? q.scope);
  const data = await scopeData();
  const pt = performanceTarget(scope);
  const target =
    pt.kind === "workspace" ? { workspaceId: pt.workspaceId } : pt.kind === "locations" ? { locationIds: pt.locationIds } : null;
  const emptyGroup = pt.kind === "empty" && scope.kind === "group";
  const cutGroup = scope.kind === "group" && scope.locationIds.length > PERFORMANCE_MAX_LOCATIONS;
  const chooseClient = pt.kind === "pick" && data.workspaces.length > 0;
  const singleLocation = refreshLocationId(scope);

  const [sumRes, kwRes, byRes, actRes] = target
    ? await Promise.all([
        performance_summary({ ...target, ...range }),
        performance_keywords({ ...target, months: 3, limit: 20 }),
        performance_byLocation({ ...target, ...range }),
        performance_activity({ ...target, ...range }),
      ])
    : [null, null, null, null];
  const summary = sumRes?.ok ? (sumRes.data as Handler<typeof performanceSummary>) : null;
  const prevRes =
    summary?.hasData
      ? await performance_summary({ ...target!, from: summary.previousFrom, to: summary.previousTo })
      : null;
  const previous = prevRes?.ok ? (prevRes.data as Handler<typeof performanceSummary>) : null;
  const kw = kwRes?.ok ? (kwRes.data as Handler<typeof performanceKeywords>) : null;
  const rows = byRes?.ok ? (byRes.data as Handler<typeof performanceByLocation>).rows.map((r) => ({ ...r, lastDataDate: r.lastDataDate && tf.day(r.lastDataDate) })) : [];
  const act = actRes?.ok ? (actRes.data as Handler<typeof performanceActivity>) : null;

  // performance_byLocation rows carry no address: join the request's location list (scopeData), not the action output.
  const addressOf = (id: string) => {
    const l = data.locations.find((x) => x.id === id);
    return { addressSummary: l?.addressSummary, phone: l?.phone };
  };
  const kpi = (TILE_KEYS as readonly string[]).includes(q.kpi ?? "") ? q.kpi! : "calls";
  const series = summary?.series.find((s) => s.key === kpi);
  const prevSeries = previous?.series.find((s) => s.key === kpi);
  const days = daysIn(range);
  const sentence = summary ? outcomeSentence(summary.kpis, periodPhrase(range, today, tf, undefined, t), days, t) : null;
  const preset = matchPreset(range, today);
  const href = (over: { from?: string; to?: string; kpi?: string }) =>
    performanceHref({ ws: scope.urlWs, from: range.from, to: range.to, kpi, ...over });
  const replyHref = `/reviews?replied=no&from=${range.from}&to=${range.to}${scope.urlWs ? `&ws=${scope.urlWs}` : ""}`;
  const label = "flex flex-col gap-1 text-sm font-medium text-muted-foreground";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <PageHeader
          title={t("title")}
          description={t("description")}
          actions={
            <>
              {canRefresh && target && (
                <PerformanceRefresh locationId={singleLocation} months={PERFORMANCE_CONFIG.retentionMonths.value} />
              )}
              <Link
                href={`/reports/new?type=performance${scope.urlWs ? `&ws=${scope.urlWs}` : ""}`}
                className={linkButtonClass}
              >
                {t("createReport")}
              </Link>
            </>
          }
        />
        {canRefresh && target && !singleLocation && (
          <p className="text-xs text-muted-foreground">{t("refreshNeedsOne")}</p>
        )}
        {!canRefresh && (
          <p className="text-xs text-muted-foreground">{t("viewOnly")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("scopeHint")}</p>
        {cutGroup && <p className="text-xs text-muted-foreground">{t("cutGroup")}</p>}
      </div>
      <ErrorText message={data.error} />

      {data.locations.length === 0 ? (
        <EmptyState
          title={t("noLocations")}
          action={<Link href="/locations" className={linkButtonClass}>{t("importLocations")}</Link>}
        />
      ) : (
        <form method="get" aria-label={t("dateRange")} className="flex flex-wrap items-end gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
          <label className={label}>
            {t("from")}
            <input type="date" name="from" defaultValue={range.from} className={filterFieldClass} />
          </label>
          <label className={label}>
            {t("to")}
            <input type="date" name="to" defaultValue={range.to} className={filterFieldClass} />
          </label>
          <input type="hidden" name="kpi" value={kpi} />
          {scope.urlWs && <input type="hidden" name="ws" value={scope.urlWs} />}
          <nav aria-label={t("presets")} className="flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const r = presetRange(p.key, today);
              const on = preset === p.key;
              return (
                <Link
                  key={p.key}
                  href={href(r)}
                  aria-current={on ? "true" : undefined}
                  className={`inline-flex min-h-(--control-h) items-center rounded-control border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    on ? "border-brand bg-brand-tint font-bold text-foreground" : "border-input bg-card font-medium text-foreground hover:bg-muted"
                  }`}
                >
                  {t(`preset_${p.key}`)}
                </Link>
              );
            })}
          </nav>
          <button type="submit" className={buttonClass}>{t("show")}</button>
        </form>
      )}

      {chooseClient && (
        <ChooseClient
          title={t("pickClientTitle")}
          text={t("pickClientText")}
          path="/performance"
          workspaces={data.workspaces}
        />
      )}
      {emptyGroup && <EmptyState title={t("emptyGroup")} />}
      <ErrorText message={err(sumRes as Res | null)} />

      {summary && !summary.hasData &&
        rows
          .filter((r) => r.googleAccessDenied)
          .map((r) => (
            <p key={r.locationId} role="note" className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
              {r.title}: {t("googleDenied")}
            </p>
          ))}
      {summary && !summary.hasData && (
        <EmptyNext id="performance" href={href(presetRange("90", today))} />
      )}

      {summary?.hasData && (
        <>
          {sentence && (
            <section aria-label={t("outcomes")} className="flex flex-col gap-1 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
              <h2 className="font-display text-base font-bold text-foreground">{t("outcomes")}</h2>
              <p className="text-base text-foreground">{sentence}</p>
              <p className="text-xs text-muted-foreground">{t("comparedWith", { from: tf.day(summary.previousFrom), to: tf.day(summary.previousTo) })}</p>
            </section>
          )}
          <KpiTiles
            tiles={TILE_KEYS.map((key) => ({ ...summary.kpis.find((k) => k.key === key)!, label: t(`kpi_${key}`) }))}
            selected={kpi}
            hrefFor={(key) => href({ kpi: key })}
          />
          {series && (
            <section aria-label={t("perDay", { label: t(`kpi_${series.key}`) })} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
              <div>
                <h2 className="font-display text-base font-bold text-foreground">{t("perDay", { label: t(`kpi_${series.key}`) })}</h2>
                <p className="text-xs text-muted-foreground">{t("chartRange", { from: tf.day(summary.from), to: tf.day(summary.to) })}</p>
              </div>
              <LineChart
                id="perf-chart"
                label={t(`kpi_${series.key}`)}
                points={series.points.map((p) => ({ ...p, date: tf.day(p.date) }))}
                previous={prevSeries?.points.map((p) => ({ ...p, date: tf.day(p.date) }))}
                legend={{
                  current: t("rangeSpan", { from: tf.day(summary.from), to: tf.day(summary.to) }),
                  previous: t("legendPrevious", { from: tf.day(summary.previousFrom), to: tf.day(summary.previousTo) }),
                }}
              />
            </section>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
            <DeviceSplit metrics={summary.metrics} />
            <ActivityPanel a={act} replyHref={replyHref} error={err(actRes as Res | null)} />
          </div>
        </>
      )}

      {target && (
        <>
          <ErrorText message={err(kwRes as Res | null)} />
          {kw && (
            <KeywordTable
              months={kw.months}
              keywords={kw.keywords}
              trackLocations={canTrack ? rows.filter((r) => r.status === "active").map((r) => ({ id: r.locationId, title: r.title, ...addressOf(r.locationId) })) : null}
            />
          )}
          {summary?.hasData && <ByLocation rows={rows} days={days} error={err(byRes as Res | null)} />}
        </>
      )}
    </div>
  );
}
