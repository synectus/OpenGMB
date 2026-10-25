// apps/web/components/reviews/analytics-view.tsx
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { reviewsAnalytics, reviewsList } from "@opengmb/core";
import { reviews_analytics, reviews_list } from "../../app/_generated/actions";
import { chartLabel, headline, hoursShort, kpiCards, monthLabel, pct, resolvePeriod, scopeLabel, sparkPoints, starBars, stars, UNREPLIED_ALERT } from "../../lib/review-analytics";
import type { Tr } from "../../lib/reviews-tools-t";
import type { TimeFormat } from "../../lib/time-format";
import { getTimeFormat } from "../../lib/time-format-server";
import { CopyButton } from "../agents/copy-button";
import { filterFieldClass } from "../page-parts";
import { EmptyState, ErrorText, Panel, secondaryButtonClass } from "../ui";
import { VolumeChart } from "./analytics-chart";
import { CompetitorBenchmark } from "./competitor-benchmark";
import { TopicTrendsPanel } from "./topic-trends";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Out = Handler<typeof reviewsAnalytics>;
type Item = Handler<typeof reviewsList>["items"][number];

export type AnalyticsParams = { ws?: string; loc?: string; group?: string; period?: string; from?: string; to?: string };
const TONE = { good: "text-good", bad: "text-bad", neutral: "text-muted-foreground" } as const;
const clip = (s: string | null, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s) : "");

function Latest({ title, tone, item, tf, ws, t }: { title: string; tone: string; item: Item | undefined; tf: TimeFormat; ws?: string; t: Tr }) {
  if (!item) return <div><span className={`text-xs font-bold ${tone}`}>{title}</span><p className="mt-0.5 text-[13px] text-muted-foreground">{t("analytics.noneYet")}</p></div>;
  const who = item.reviewer.isAnonymous ? t("anonymous") : (item.reviewer.displayName ?? t("unknown"));
  return (
    <div>
      <span className={`text-xs font-bold ${tone}`}>{title}</span>
      <p className="mt-0.5 text-[13px]">
        {item.rating}★ {who}, {item.location.name}, {tf.date(item.createTime, ws)}
        {item.comment ? `: "${clip(item.comment, 80)}"` : ""}{" "}
        <Link href={`/reviews?review=${item.id}`} className="font-bold text-brand-text underline underline-offset-2">{t("analytics.open")}</Link>
      </p>
    </div>
  );
}

export async function AnalyticsView({
  sp,
  workspaces,
  locations,
  canClassify = false,
  canConfigure = false,
}: {
  sp: AnalyticsParams;
  workspaces: { id: string; name: string }[];
  locations: { id: string; name: string; workspaceId: string }[];
  /** A5: owner, admin, manager may press "Classify reviews". */
  canClassify?: boolean;
  /** A5: owner and admin may switch the daily automatic classification. */
  canConfigure?: boolean;
}) {
  const t = await getTranslations("reviewsTools");
  const tf = await getTimeFormat(sp.ws);
  const period = resolvePeriod(sp, new Date(), tf, undefined, t);
  const wsOf = (i: Item | undefined) => locations.find((l) => l.id === i?.location.id)?.workspaceId;
  const scope = { workspaceId: sp.ws || undefined, locationIds: sp.loc ? [sp.loc] : undefined, groupId: sp.group || undefined };
  const [res, neg, pos] = await Promise.all([
    reviews_analytics({ ...scope, from: period.from.toISOString(), to: period.to.toISOString() }),
    reviews_list({ ...scope, ratings: [1, 2], limit: 1 }),
    reviews_list({ ...scope, ratings: [4, 5], limit: 1 }),
  ]);
  const name = scopeLabel({ ws: sp.ws, loc: sp.loc, workspaces, locations }, t);
  const hidden = (["ws", "loc", "group"] as const).flatMap((k) => (sp[k] ? [<input key={k} type="hidden" name={k} value={sp[k]} />] : []));
  const d = res.ok ? (res.data as Out) : null;
  const negItem = neg.ok ? (neg.data as Handler<typeof reviewsList>).items[0] : undefined;
  const posItem = pos.ok ? (pos.data as Handler<typeof reviewsList>).items[0] : undefined;

  return (
    <div className="flex flex-col gap-4">
      <form method="get" aria-label={t("analytics.period")} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="view" value="analytics" />
        {hidden}
        <label className="flex flex-col gap-1 text-[13px] font-semibold">
          {t("analytics.period")}
          <select name="period" defaultValue={period.key} className={filterFieldClass}>
            <option value="12m">{t("analytics.last12")}</option>
            <option value="90d">{t("analytics.last90")}</option>
            <option value="custom">{t("analytics.custom")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
          {t("analytics.from")}
          <input type="date" name="from" defaultValue={period.key === "custom" ? period.fromDay : ""} className={filterFieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
          {t("analytics.toInclusive")}
          <input type="date" name="to" defaultValue={period.key === "custom" ? period.toDay : ""} className={filterFieldClass} />
        </label>
        <button type="submit" className={secondaryButtonClass}>{t("analytics.update")}</button>
      </form>
      {period.notice && <p className="text-sm text-warn">{period.notice}</p>}
      {!res.ok && <ErrorText message={`${res.error.code}: ${res.error.message}`} />}

      {d && d.current.count === 0 && (
        <EmptyState title={t("analytics.emptyTitle")}>{t("analytics.emptyBody")}</EmptyState>
      )}

      {d && d.current.count > 0 && (
        <>
          <p className="max-w-[980px] font-display text-[17px] leading-[26px] font-semibold">
            {headline({ scope: name, label: period.label, cur: d.current, prev: d.previous }, t)}
          </p>
          {d.truncated && <p className="text-sm text-warn">{t("analytics.truncated")}</p>}

          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            {kpiCards(d.current, d.previous, t).map((k) => (
              <div key={k.label} className="flex flex-col gap-1 rounded-panel border border-border p-4">
                <span className="text-[13px] font-medium text-muted-foreground">{k.label}</span>
                <span className="flex items-baseline gap-2">
                  <strong className="font-display text-[28px] leading-8 tabular-nums">{k.value}</strong>
                  {k.delta && <span className={`text-[13px] font-semibold ${TONE[k.tone]}`}>{k.delta}</span>}
                </span>
                <span className="text-xs text-muted-foreground">{k.note}</span>
              </div>
            ))}
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            {t("analytics.replyTimeNote")}
          </p>

          <div className="flex flex-wrap gap-4">
            <Panel title={t("analytics.volumeTitle")} className="min-w-0 flex-[2_1_560px]">
              <VolumeChart months={d.months} t={t} />
              <div className="flex flex-wrap gap-3.5 text-xs text-foreground">
                <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-chart-1" />{t("analytics.legendHigh")}</span>
                <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-bad" />{t("analytics.legendLow")}</span>
                <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-[3px] w-3.5 bg-brand" />{t("analytics.legendAvg")}</span>
              </div>
              <details>
                <summary className="cursor-pointer text-sm font-bold text-brand-text">{t("analytics.showTable")}</summary>
                <table className="mt-2 w-full text-left text-[13px]">
                  <caption className="sr-only">{chartLabel(d.months, t)}</caption>
                  <thead><tr><th scope="col" className="py-1">{t("analytics.colMonth")}</th><th scope="col">{t("analytics.colNew")}</th><th scope="col">{t("analytics.colLow")}</th><th scope="col">{t("analytics.colAvg")}</th></tr></thead>
                  <tbody>
                    {d.months.map((m) => (
                      <tr key={m.month} className="border-t border-border"><th scope="row" className="py-1 font-medium">{monthLabel(m.month, true, t)}</th><td>{m.total}</td><td>{m.low}</td><td>{m.avg === null ? t("none") : m.avg.toFixed(1)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </Panel>

            <Panel title={t("analytics.starsTitle")} className="min-w-0 flex-[1_1_300px]">
              {starBars(d.stars).map((s) => (
                <div key={s.star} className="grid grid-cols-[30px_minmax(0,1fr)_70px] items-center gap-2.5 text-[13px]">
                  <span className="font-semibold">{s.star}</span>
                  <span aria-hidden className="h-3 rounded-full bg-secondary"><span className={`block h-full rounded-full ${s.fill}`} style={{ width: `${s.pct}%` }} /></span>
                  <span className="text-right tabular-nums">{s.n} · {s.pct}%</span>
                </div>
              ))}
              <div className="mt-1.5 flex flex-col gap-2.5 border-t border-border pt-3">
                <Latest title={t("analytics.latestNeg")} tone="text-bad" item={negItem} tf={tf} ws={wsOf(negItem)} t={t} />
                <Latest title={t("analytics.latestPos")} tone="text-good" item={posItem} tf={tf} ws={wsOf(posItem)} t={t} />
              </div>
            </Panel>
          </div>

          <Panel title={t("analytics.byLocation")}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead>
                  <tr className="text-muted-foreground">
                    {(["colLocation", "colRating", "colReviews", "colUnreplied", "colReplyRate", "colMedian", "colTrend"] as const).map((h) => (
                      <th key={h} scope="col" className="px-3.5 py-2 font-semibold">{t(`analytics.${h}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.locations.map((l) => (
                    <tr key={l.locationId} className="border-t border-border">
                      <td className="px-3.5 py-2.5 font-semibold"><Link href={`/reviews?loc=${l.locationId}`} className="text-foreground underline underline-offset-2">{l.name}</Link></td>
                      <td className="px-3.5 py-2.5 tabular-nums">{stars(l.avgRating, t)}</td>
                      <td className="px-3.5 py-2.5 tabular-nums">{l.count}</td>
                      <td className={`px-3.5 py-2.5 tabular-nums ${l.needsReply > UNREPLIED_ALERT ? "font-bold text-bad" : ""}`}>{l.needsReply}</td>
                      <td className="px-3.5 py-2.5 tabular-nums">{pct(l.replyRate, t)}</td>
                      <td className="px-3.5 py-2.5 tabular-nums">{l.medianReplyHours === null ? t("none") : hoursShort(l.medianReplyHours, t)}</td>
                      <td className="px-3.5 py-1.5">
                        {sparkPoints(l.monthly) ? (
                          <svg role="img" aria-label={l.trend === "up" ? t("analytics.trendUp") : l.trend === "down" ? t("analytics.trendDown") : t("analytics.trendSteady")} viewBox="0 0 80 22" width="80" height="22">
                            <polyline fill="none" strokeWidth="1.8" points={sparkPoints(l.monthly)} className={l.trend === "up" ? "stroke-good" : l.trend === "down" ? "stroke-bad" : "stroke-muted-foreground"} />
                          </svg>
                        ) : <span className="text-muted-foreground">{t("none")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <TopicTrendsPanel
            scope={scope}
            workspaceId={sp.ws || locations.find((l) => l.id === sp.loc)?.workspaceId}
            canClassify={canClassify}
            canConfigure={canConfigure}
            filterBase={new URLSearchParams(Object.entries({ ws: sp.ws, loc: sp.loc, group: sp.group }).filter((e): e is [string, string] => Boolean(e[1]))).toString()}
          />

          <section className="flex flex-wrap items-center gap-3.5 rounded-panel border border-agent-border bg-agent-bg p-4 text-agent">
            <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
              <strong>{t("analytics.aiTitle")}</strong>
              <span className="text-[13px]">{t("analytics.aiBody", { question: t("analytics.aiQuestion", { name }) })}</span>
            </div>
            <CopyButton text={t("analytics.aiQuestion", { name })} label={t("analytics.copyQuestion")} />
            <Link href="/agents" className="font-bold underline underline-offset-2">{t("analytics.connectAgent")}</Link>
          </section>
        </>
      )}

      {sp.loc && <CompetitorBenchmark locationId={sp.loc} />}
    </div>
  );
}
