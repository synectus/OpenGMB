import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { gridCompetitorSnapshots, gridConfigs, locations, reviews } from "@opengmb/db";
import { AccessError, authorize, workspaceScope } from "../actor";
import { defineAction } from "../registry";
import { topCompetitors, velocityPer30Days } from "../reviews/competitor-benchmark";

const DAY_MS = 86_400_000;
const sourceOrder = { live: 0, sandbox: 1, fixture: 2 } as const;
type Source = keyof typeof sourceOrder;

const velocityOut = z.object({ perThirtyDays: z.number(), fromDay: z.string(), toDay: z.string() }).nullable();

export const reviewsCompetitorBenchmark = defineAction({
  name: "reviews.competitorBenchmark",
  description:
    "Benchmark a location's reviews against its top 3 competitors: review count, rating and review velocity (reviews gained per 30 days). Competitors come from the stored geo-grid tracker snapshots of the location (latest snapshot day, ranked by grid appearances then average rank, one data source only: live, else sandbox, else fixture; sample data is never mixed with live). A competitor's velocity is its review count change between its oldest and newest stored snapshot day of that source, scaled to 30 days; null means not enough history (fewer than 2 snapshot days). The location's own velocity is its synced reviews from the last 30 days. Reads stored data only, no paid calls. competitors is empty and dataSource null when the location has no tracker snapshots. Needs review:read.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    locationId: z.string(),
    /** Where the competitor data came from; anything but live is sample data. Null when there is none. */
    dataSource: z.enum(["fixture", "sandbox", "live"]).nullable(),
    snapshotDate: z.string().nullable(),
    own: z.object({
      name: z.string(),
      reviewCount: z.number().int(),
      rating: z.number().nullable(),
      /** Reviews received in the last 30 days. */
      last30Days: z.number().int(),
    }),
    competitors: z.array(
      z.object({
        placeId: z.string(),
        title: z.string(),
        reviewCount: z.number().int().nullable(),
        rating: z.number().nullable(),
        appearances: z.number().int(),
        averageRank: z.number(),
        velocity: velocityOut,
      }),
    ),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const [loc] = await tx
      .select({ id: locations.id, name: locations.name, workspaceId: locations.workspaceId })
      .from(locations)
      .where(and(eq(locations.id, input.locationId), eq(locations.orgId, actor.orgId), eq(locations.status, "active")));
    const scope = workspaceScope(actor);
    if (!loc || (scope !== "all" && !scope.includes(loc.workspaceId))) throw new AccessError("NOT_FOUND", "Location not found");
    authorize(actor, "review:read", { workspaceId: loc.workspaceId });

    const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const [own] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        avg: sql<string | null>`avg(${reviews.starRating})`,
        recent: sql<number>`count(*) filter (where ${reviews.createTime} >= ${since}::timestamptz)::int`,
      })
      .from(reviews)
      .where(and(eq(reviews.orgId, actor.orgId), eq(reviews.locationId, loc.id)));
    const ownOut = {
      name: loc.name,
      reviewCount: own?.count ?? 0,
      rating: own?.avg == null ? null : Math.round(Number(own.avg) * 10) / 10,
      last30Days: own?.recent ?? 0,
    };

    const configs = await tx
      .select({ id: gridConfigs.id })
      .from(gridConfigs)
      .where(and(eq(gridConfigs.orgId, actor.orgId), eq(gridConfigs.locationId, loc.id), eq(gridConfigs.kind, "tracker")));
    const none = { locationId: loc.id, dataSource: null, snapshotDate: null, own: ownOut, competitors: [] };
    if (configs.length === 0) return none;
    const configIds = configs.map((c) => c.id);
    const base = and(eq(gridCompetitorSnapshots.orgId, actor.orgId), inArray(gridCompetitorSnapshots.configId, configIds));

    const days = await tx
      .selectDistinct({
        configId: gridCompetitorSnapshots.configId,
        keyword: gridCompetitorSnapshots.keyword,
        day: gridCompetitorSnapshots.snapshotDate,
        source: gridCompetitorSnapshots.dataSource,
      })
      .from(gridCompetitorSnapshots)
      .where(base)
      .orderBy(desc(gridCompetitorSnapshots.snapshotDate));
    if (days.length === 0) return none;
    // The newest snapshot day wins; on a day with two sources the real one does. Everything below is that one source.
    const newest = [...days].sort((x, y) => (x.day === y.day ? sourceOrder[x.source] - sourceOrder[y.source] : x.day < y.day ? 1 : -1))[0]!;
    const source: Source = newest.source;
    // Per tracker and keyword, the newest day of that source.
    const latest = new Map<string, { configId: string; keyword: string; day: string }>();
    for (const d of days) {
      if (d.source !== source) continue;
      const k = `${d.configId}\u0000${d.keyword}`;
      const cur = latest.get(k);
      if (!cur || d.day > cur.day) latest.set(k, { configId: d.configId, keyword: d.keyword, day: d.day });
    }
    const rows = await tx
      .select()
      .from(gridCompetitorSnapshots)
      .where(and(base, eq(gridCompetitorSnapshots.dataSource, source)));
    const current = rows.filter((r) => latest.get(`${r.configId}\u0000${r.keyword}`)?.day === r.snapshotDate);
    const top = topCompetitors(
      current.map((r) => ({
        placeId: r.placeId,
        title: r.title,
        appearances: r.appearances,
        averageRank: Number(r.avgRank),
        rating: r.rating === null ? null : Number(r.rating),
        reviewCount: r.reviewCount,
      })),
    );
    const history = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (r.reviewCount === null) continue;
      const perDay = history.get(r.placeId) ?? new Map<string, number>();
      perDay.set(r.snapshotDate, Math.max(perDay.get(r.snapshotDate) ?? 0, r.reviewCount));
      history.set(r.placeId, perDay);
    }
    return {
      locationId: loc.id,
      dataSource: source,
      snapshotDate: [...latest.values()].map((l) => l.day).sort().pop() ?? null,
      own: ownOut,
      competitors: top.map((c) => {
        const v = velocityPer30Days([...(history.get(c.placeId) ?? [])].map(([day, reviewCount]) => ({ day, reviewCount })));
        return {
          placeId: c.placeId,
          title: c.title,
          reviewCount: c.reviewCount,
          rating: c.rating,
          appearances: c.appearances,
          averageRank: c.averageRank,
          velocity: v && { perThirtyDays: v.perThirtyDays, fromDay: v.fromDay, toDay: v.toDay },
        };
      }),
    };
  },
});
