import { getTranslations } from "next-intl/server";
import type { reviewsCompetitorBenchmark } from "@opengmb/core";
import { reviews_competitorBenchmark } from "../../app/_generated/actions";
import { EmptyState, ErrorText, Panel } from "../ui";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Out = Handler<typeof reviewsCompetitorBenchmark>;

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** R9: one location's review count, rating and velocity next to its top 3 competitors, from stored tracker snapshots (no new paid calls). */
export async function CompetitorBenchmark({ locationId }: { locationId: string }) {
  const t = await getTranslations("reviewsTools");
  const res = await reviews_competitorBenchmark({ locationId });
  if (!res.ok) return <ErrorText message={`${res.error.code}: ${res.error.message}`} />;
  const d = res.data as Out;
  const a = "analytics";
  return (
    <Panel title={t(`${a}.benchTitle`)}>
      <p className="text-[13px] text-muted-foreground">{t(`${a}.benchIntro`)}</p>
      {d.dataSource && d.dataSource !== "live" && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center rounded-full border border-warn-border bg-warn-bg px-2.5 py-0.5 text-xs font-bold text-warn">
            {t(`${a}.benchNotLive`)}
          </span>
          <span>{t(`${a}.benchSample`)}</span>
        </p>
      )}
      {d.competitors.length === 0 ? (
        <EmptyState title={t(`${a}.benchTitle`)}>{t(`${a}.benchNone`)}</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[13px]">
            <thead>
              <tr className="text-muted-foreground">
                {(["benchColBusiness", "benchColReviews", "benchColRating", "benchColVelocity"] as const).map((h) => (
                  <th key={h} scope="col" className="px-3.5 py-2 font-semibold">{t(`${a}.${h}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border bg-secondary/40">
                <th scope="row" className="px-3.5 py-2.5 text-left font-semibold">{t(`${a}.benchYou`, { name: d.own.name })}</th>
                <td className="px-3.5 py-2.5 tabular-nums">{d.own.reviewCount}</td>
                <td className="px-3.5 py-2.5 tabular-nums">{d.own.rating === null ? t("none") : d.own.rating.toFixed(1)}</td>
                <td className="px-3.5 py-2.5 tabular-nums">{t(`${a}.benchYourVelocity`, { count: d.own.last30Days })}</td>
              </tr>
              {d.competitors.map((c) => (
                <tr key={c.placeId} className="border-t border-border">
                  <th scope="row" className="px-3.5 py-2.5 text-left font-semibold">{c.title}</th>
                  <td className="px-3.5 py-2.5 tabular-nums">{c.reviewCount ?? t(`${a}.benchUnknown`)}</td>
                  <td className="px-3.5 py-2.5 tabular-nums">{c.rating === null ? t(`${a}.benchUnknown`) : c.rating.toFixed(1)}</td>
                  <td className="px-3.5 py-2.5 tabular-nums">
                    {c.velocity ? signed(c.velocity.perThirtyDays) : <span className="text-muted-foreground">{t(`${a}.benchNoHistory`)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.competitors.some((c) => c.velocity) && (
        <p className="text-xs text-muted-foreground">
          {t(`${a}.benchVelocityNote`, {
            from: d.competitors.flatMap((c) => (c.velocity ? [c.velocity.fromDay] : [])).sort()[0]!,
            to: d.competitors.flatMap((c) => (c.velocity ? [c.velocity.toDay] : [])).sort().pop()!,
          })}
        </p>
      )}
    </Panel>
  );
}
