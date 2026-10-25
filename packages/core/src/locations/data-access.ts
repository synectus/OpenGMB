import { and, eq, inArray } from "drizzle-orm";
import { locationDataAccess, type Db } from "@opengmb/db";
import { writeAudit } from "../audit";
import { GOOGLE_ACCESS_CONFIG, type GoogleAccessResource } from "../config/google-retry";
import { isGooglePermissionDenied } from "../google/errors";

const DAY_MS = 86_400_000;
export const GOOGLE_ACCESS_DENIED = "permission_denied";

/** True for a plain per-location 403 (see isGooglePermissionDenied). */
export const isLocationAccessDenied = (e: unknown) =>
  isGooglePermissionDenied(e, GOOGLE_ACCESS_CONFIG.notLocationSpecificReasons);

type Loc = { id: string; orgId: string };

/**
 * Is this location's `resource` marked as refused by Google AND still inside the skip window?
 * False when never marked, or when the window has passed (time to re-check once).
 */
export async function isGoogleAccessBlocked(
  db: Db,
  locationId: string,
  resource: GoogleAccessResource,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ lastCheckedAt: locationDataAccess.lastCheckedAt })
    .from(locationDataAccess)
    .where(and(eq(locationDataAccess.locationId, locationId), eq(locationDataAccess.resource, resource)));
  if (!row) return false;
  return now.getTime() - row.lastCheckedAt.getTime() < GOOGLE_ACCESS_CONFIG.recheckDays * DAY_MS;
}

/**
 * Record a refusal. First sighting keeps `firstSeenAt` and writes one audit row; a failed re-check
 * only moves `lastCheckedAt`. Returns whether this was the first sighting.
 */
export async function markGoogleAccessDenied(
  db: Db,
  loc: Loc,
  resource: GoogleAccessResource,
  now: Date = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(locationDataAccess)
      .values({ locationId: loc.id, orgId: loc.orgId, resource, reason: GOOGLE_ACCESS_DENIED, firstSeenAt: now, lastCheckedAt: now })
      .onConflictDoNothing()
      .returning({ id: locationDataAccess.locationId });
    if (inserted.length === 0) {
      await tx
        .update(locationDataAccess)
        .set({ lastCheckedAt: now })
        .where(and(eq(locationDataAccess.locationId, loc.id), eq(locationDataAccess.resource, resource)));
      return false;
    }
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "google_access.denied",
      entityType: "location",
      entityId: loc.id,
      after: { resource, reason: GOOGLE_ACCESS_DENIED },
    });
    return true;
  });
}

/** A call worked: drop any mark. */
export async function clearGoogleAccessDenied(db: Db, locationId: string, resource: GoogleAccessResource) {
  await db
    .delete(locationDataAccess)
    .where(and(eq(locationDataAccess.locationId, locationId), eq(locationDataAccess.resource, resource)));
}

/** Locations (of those given) whose `resource` is currently marked refused. */
export async function deniedLocationIds(db: Db, locationIds: string[], resource: GoogleAccessResource): Promise<Set<string>> {
  if (locationIds.length === 0) return new Set();
  const rows = await db
    .select({ id: locationDataAccess.locationId })
    .from(locationDataAccess)
    .where(and(inArray(locationDataAccess.locationId, locationIds), eq(locationDataAccess.resource, resource)));
  return new Set(rows.map((r) => r.id));
}
