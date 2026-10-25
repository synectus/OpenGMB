import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { locations, type Db } from "@opengmb/db";
import { enqueueJob } from "../jobs";
import { LOCATION_CENTER_QUEUE, type LocationCenterJob } from "./center";

/**
 * One-off backfill: queue a coordinate lookup for every active, Google-linked location that has none
 * (and is not set by hand). Safe to run again: the job leaves a location that already has coordinates
 * for its address alone. `dryRun` counts without queueing.
 */
export async function enqueueLocationCenterBackfill(
  db: Db,
  opts: { dryRun?: boolean; orgId?: string } = {},
): Promise<{ candidates: number; enqueued: number }> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.status, "active"),
        isNull(locations.centerLat),
        sql`${locations.centerSource} is distinct from 'manual'`,
        isNotNull(locations.googleLocationId),
        isNotNull(locations.connectionId),
        opts.orgId ? eq(locations.orgId, opts.orgId) : undefined,
      ),
    );
  if (opts.dryRun) return { candidates: rows.length, enqueued: 0 };
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const job: LocationCenterJob = { locationId: r.id, reason: "backfill" };
      await enqueueJob(tx, LOCATION_CENTER_QUEUE, job);
    }
  });
  return { candidates: rows.length, enqueued: rows.length };
}
