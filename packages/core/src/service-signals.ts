import { sql } from "drizzle-orm";
import type { Db } from "@opengmb/db";
import { lastHeartbeat } from "./monitoring/worker";

export type ServiceSignals = {
  /** The database answered a trivial query. */
  databaseUp: boolean;
  /** When the worker last wrote its heartbeat (H2), or null when none was ever recorded. */
  workerLastActivityAt: Date | null;
};

/**
 * The raw health signals behind the public status page (/status), read in one small place. The
 * database signal is a trivial query; the worker signal is the worker's heartbeat (H2, written every minute;
 * judged stale by MONITORING.workerStaleMs). Add or swap signals here only: the
 * page and the mapping in apps/web/lib/service-status.ts do not change. Throws if the database
 * cannot be reached; the caller turns that into "database down".
 */
export async function readServiceSignals(db: Db): Promise<ServiceSignals> {
  await db.execute(sql`select 1`);
  return { databaseUp: true, workerLastActivityAt: await lastHeartbeat(db) };
}
