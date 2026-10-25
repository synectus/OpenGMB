import { getTranslations } from "next-intl/server";
import { last30DaysRange, type performanceByLocation } from "@opengmb/core";
import { performance_byLocation } from "../../app/_generated/actions";
import { growthPotentialView, type GrowthPerformance } from "../../lib/growth-potential";
import type { MapPoint } from "../../lib/rank-map";
import { ErrorText } from "../ui";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

/** Async server component: reads the location's stored Performance API totals for the last 30 days; streamed in Suspense. */
export async function GrowthPotential({
  locationId,
  targetName,
  points,
}: {
  locationId: string;
  targetName: string;
  points: Pick<MapPoint, "rank" | "pending">[];
}) {
  const t = await getTranslations("geogrid");
  const range = last30DaysRange(new Date());
  const r = await performance_byLocation({ locationIds: [locationId], ...range });
  // A viewer without report:read gets no panel, not an error: the numbers are not theirs to see.
  if (!r.ok) return r.error.code === "FORBIDDEN" ? null : <ErrorText message={`${r.error.code}: ${r.error.message}`} />;
  const row = (r.data as Handler<typeof performanceByLocation>).rows[0];
  const performance: GrowthPerformance | null = row
    ? { lastDataDate: row.lastDataDate, actions: row.actions.total, ...range }
    : null;
  const view = growthPotentialView({ sample: false, targetName, points, performance, t });
  return (
    <div className="flex flex-col gap-1.5">
      <p className={view.kind === "estimate" ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>{view.text}</p>
      {view.kind === "estimate" && (
        <>
          <p className="text-xs text-muted-foreground">{view.basis}</p>
          <p className="text-xs font-semibold text-muted-foreground">{view.disclaimer}</p>
        </>
      )}
    </div>
  );
}
