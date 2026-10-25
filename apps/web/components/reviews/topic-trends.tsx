import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { reviewsTopicTrends, reviewTopicsStatus } from "@opengmb/core";
import { reviewTopics_status, reviews_topicTrends } from "../../app/_generated/actions";
import { sparkPoints } from "../../lib/review-analytics";
import { topicRows } from "../../lib/review-topics";
import { ErrorText, Panel } from "../ui";
import { TopicControls } from "./topic-controls";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Trends = Handler<typeof reviewsTopicTrends>;
type Status = Handler<typeof reviewTopicsStatus>;

/**
 * The Topics panel of Reviews > Analytics: per topic the mentions, the positive / mixed / negative split and
 * the negative share by week, then the same per location. Counts only, from reviews already classified.
 */
export async function TopicTrendsPanel({
  scope,
  workspaceId,
  canClassify,
  canConfigure,
  filterBase,
}: {
  scope: { workspaceId?: string; locationIds?: string[]; groupId?: string };
  /** The one client the controls act on; undefined when the scope spans several clients. */
  workspaceId: string | undefined;
  canClassify: boolean;
  canConfigure: boolean;
  /** Query string (no topic) that keeps the scope, for the "show these reviews" links. */
  filterBase: string;
}) {
  const t = await getTranslations("reviewTopics");
  const [res, st] = await Promise.all([
    reviews_topicTrends(scope),
    workspaceId ? reviewTopics_status({ workspaceId }) : Promise.resolve(null),
  ]);
  if (!res.ok) return <ErrorText message={`${res.error.code}: ${res.error.message}`} />;
  const d = res.data as Trends;
  const status = st?.ok ? (st.data as Status) : null;
  const topics = topicRows(d.topics);
  const label = (id: string) => t(`topic.${id}`);
  const href = (topic: string) => `/reviews?${filterBase}${filterBase ? "&" : ""}topic=${topic}`;

  return (
    <Panel title={t("title")} description={d.classifiedReviews > 0 ? t("summary", { count: d.classifiedReviews }) : t("empty")}>
      {workspaceId && status ? (
        <TopicControls
          workspaceId={workspaceId}
          pending={status.pending}
          aiOn={status.aiOn}
          autoClassify={status.autoClassify}
          canClassify={canClassify}
          canConfigure={canConfigure}
        />
      ) : (
        canClassify && <p className="text-[13px] text-muted-foreground">{t("classify.pickClient")}</p>
      )}

      {topics.length > 0 && (
        <>
          <div className="flex flex-wrap gap-3.5 text-xs text-foreground">
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-good" />{t("legendPositive")}</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-muted-foreground" />{t("legendMixed")}</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm bg-bad" />{t("legendNegative")}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-semibold">{t("colTopic")}</th>
                  <th scope="col" className="px-3 py-1.5 font-semibold">{t("colMentions")}</th>
                  <th scope="col" className="px-3 py-1.5 font-semibold">{t("colSplit")}</th>
                  <th scope="col" className="px-3 py-1.5 font-semibold">{t("colTrend")}</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((r) => {
                  const points = sparkPoints(r.weeklyNegative);
                  return (
                    <tr key={r.topic} className="border-t border-border">
                      <th scope="row" className="py-2 pr-3 font-semibold">
                        <Link href={href(r.topic)} title={t("openFilter")} className="text-foreground underline underline-offset-2">{label(r.topic)}</Link>
                      </th>
                      <td className="px-3 py-2 tabular-nums">{r.total}</td>
                      <td className="min-w-[220px] px-3 py-2">
                        <span
                          role="img"
                          aria-label={t("splitLabel", { topic: label(r.topic), positive: r.positive, mixed: r.mixed, negative: r.negative })}
                          className="flex h-3 overflow-hidden rounded-full bg-secondary"
                        >
                          <span className="bg-good" style={{ width: `${r.pct.positive}%` }} />
                          <span className="bg-muted-foreground" style={{ width: `${r.pct.mixed}%` }} />
                          <span className="bg-bad" style={{ width: `${r.pct.negative}%` }} />
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">{r.pct.positive}% · {r.pct.mixed}% · {r.pct.negative}%</span>
                      </td>
                      <td className="px-3 py-1.5">
                        {points ? (
                          <svg role="img" aria-label={r.trend === "up" ? t("trendUp") : r.trend === "down" ? t("trendDown") : t("trendSteady")} viewBox="0 0 80 22" width="80" height="22">
                            <polyline fill="none" strokeWidth="1.8" points={points} className={r.trend === "up" ? "stroke-bad" : r.trend === "down" ? "stroke-good" : "stroke-muted-foreground"} />
                          </svg>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-bold text-brand-text">{t("showWeekly")}</summary>
            <div className="overflow-x-auto">
              <table className="mt-2 w-full min-w-[640px] text-left text-[13px]">
                <caption className="pb-1 text-left text-xs text-muted-foreground">{t("weeklyCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="py-1">{t("colTopic")}</th>
                    {d.weeks.map((w) => (
                      <th key={w} scope="col" className="px-1.5 text-xs font-medium tabular-nums">{w.slice(5)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topics.map((r) => (
                    <tr key={r.topic} className="border-t border-border">
                      <th scope="row" className="py-1 pr-2 font-medium">{label(r.topic)}</th>
                      {r.weekly.map((w, i) => (
                        <td key={d.weeks[i]} className="px-1.5 tabular-nums">{w.total === 0 ? "-" : `${w.negative}/${w.total}`}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {d.locations.length > 1 && (
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <h3 className="text-sm font-bold">{t("byLocation")}</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[13px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-3 font-semibold">{t("colLocation")}</th>
                      <th scope="col" className="px-3 py-1.5 font-semibold">{t("colClassified")}</th>
                      <th scope="col" className="px-3 py-1.5 font-semibold">{t("colTopics")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.locations.map((l) => (
                      <tr key={l.locationId} className="border-t border-border align-top">
                        <th scope="row" className="py-2 pr-3 font-semibold">
                          <Link href={`/reviews?loc=${l.locationId}`} className="text-foreground underline underline-offset-2">{l.name}</Link>
                        </th>
                        <td className="px-3 py-2 tabular-nums">{l.classifiedReviews}</td>
                        <td className="px-3 py-2">
                          <ul className="flex flex-col gap-0.5">
                            {[...l.topics].sort((a, b) => b.total - a.total).map((x) => (
                              <li key={x.topic} className={x.negativeShare !== null && x.negativeShare >= 0.5 ? "text-bad" : ""}>
                                {t("locationLine", { topic: label(x.topic), total: x.total, negative: x.negative })}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
