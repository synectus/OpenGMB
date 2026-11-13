import { sql } from "drizzle-orm";
import type { Db, Tx } from "@opengmb/db";

/** The error code the review sync records when Google answers "not found" for a location (OPS3). */
export const GOOGLE_NOT_FOUND_CODE = "google_location_not_found";

/**
 * Active locations among `locationIds` whose newest settled (not pending) review sync failed with google_location_not_found,
 * by name. One query on the review_syncs (location_id, finished_at desc) index; it runs on Home, so it stays small.
 * The caller passes only the locations the person may see, so no other workspace's name is ever returned.
 */
export async function locationsNotFoundAmong(db: Db | Tx, locationIds: string[]): Promise<{ id: string; name: string }[]> {
  if (locationIds.length === 0) return [];
  const ids = sql.join(locationIds.map((i) => sql`${i}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    select l.id, coalesce(nullif(l.title, ''), l.name) as name
    from locations l
    cross join lateral (
      select s.status, s.error from review_syncs s
      where s.location_id = l.id and s.status <> 'pending'
      order by s.finished_at desc nulls last, s.created_at desc, s.id desc limit 1
    ) newest
    where l.id in (${ids}) and l.status = 'active' and newest.status = 'failed' and newest.error = ${GOOGLE_NOT_FOUND_CODE}
    order by name, l.id`)) as unknown as { id: string; name: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
