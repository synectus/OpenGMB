import { and, eq, inArray, sql } from "drizzle-orm";
import { profileChanges, reviews, suspensionCases, type Db, type Tx } from "@opengmb/db";
import { needsYouSql, waitingToPublishSql } from "../reviews/reply-stage";

/** A case in one of these statuses is unresolved: the location shows "Suspension case open". */
export const OPEN_SUSPENSION_STATUSES = ["open", "appealed"] as const;

export type LocationStats = {
  locationId: string;
  /** Synced reviews. `unreplied`: reviews that need you (reply-stage.ts), any age, as /reviews?replied=no. `waitingToPublish`: approved reply not yet on Google. */
  reviews: { total: number; avgRating: number | null; unreplied: number; waitingToPublish: number };
  /** Open profile changes (snapshot diffs and Google suggestions): the location's alerts. */
  openChanges: number;
  suspensionOpen: boolean;
};

/**
 * Per-location counts from our own tables, in the order of `ids`. No Google call. `ids` must already
 * be limited to the caller's scope; this function only adds the org filter. Takes a `Db` too, so
 * outside-transaction actions (3C1's `locations.overview`) can reuse it.
 */
export async function locationStats(
  tx: Db | Tx,
  orgId: string,
  ids: string[],
): Promise<LocationStats[]> {
  if (ids.length === 0) return [];
  const rev = await tx
    .select({
      locationId: reviews.locationId,
      total: sql<number>`count(*)::int`,
      avg: sql<string | null>`avg(${reviews.starRating})`,
      unreplied: sql<number>`(count(*) filter (where ${needsYouSql}))::int`,
      waiting: sql<number>`(count(*) filter (where ${waitingToPublishSql}))::int`,
    })
    .from(reviews)
    .where(and(eq(reviews.orgId, orgId), inArray(reviews.locationId, ids)))
    .groupBy(reviews.locationId);
  const changes = await tx
    .select({ locationId: profileChanges.locationId, n: sql<number>`count(*)::int` })
    .from(profileChanges)
    .where(
      and(
        eq(profileChanges.orgId, orgId),
        eq(profileChanges.status, "open"),
        inArray(profileChanges.locationId, ids),
      ),
    )
    .groupBy(profileChanges.locationId);
  const cases = await tx
    .selectDistinct({ locationId: suspensionCases.locationId })
    .from(suspensionCases)
    .where(
      and(
        eq(suspensionCases.orgId, orgId),
        inArray(suspensionCases.status, [...OPEN_SUSPENSION_STATUSES]),
        inArray(suspensionCases.locationId, ids),
      ),
    );
  const open = new Set(cases.map((c) => c.locationId));
  return ids.map((id) => {
    const r = rev.find((x) => x.locationId === id);
    return {
      locationId: id,
      reviews: {
        total: r?.total ?? 0,
        avgRating: r?.avg == null ? null : Number(r.avg),
        unreplied: r?.unreplied ?? 0,
        waitingToPublish: r?.waiting ?? 0,
      },
      openChanges: changes.find((c) => c.locationId === id)?.n ?? 0,
      suspensionOpen: open.has(id),
    };
  });
}
