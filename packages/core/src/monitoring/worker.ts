import { eq, sql } from "drizzle-orm";
import { monitorState, type Db, type Tx } from "@opengmb/db";
import { MONITORING } from "../config/monitoring";
import { sendAlert } from "./alert";
import { recordError, sanitizeMessage } from "./errors";

const HEARTBEAT = "worker_heartbeat";
const DOWN = "worker_down";
const FAILED_CURSOR = "failed_jobs_cursor";

/** The worker calls this every tick: "I am alive at `now`". */
export async function recordHeartbeat(db: Db, now: Date = new Date()): Promise<void> {
  await db
    .insert(monitorState)
    .values({ key: HEARTBEAT, updatedAt: now })
    .onConflictDoUpdate({ target: monitorState.key, set: { updatedAt: now } });
}

export async function lastHeartbeat(db: Db | Tx): Promise<Date | null> {
  const [row] = await db.select().from(monitorState).where(eq(monitorState.key, HEARTBEAT));
  return row?.updatedAt ?? null;
}

export type WorkerCheck = "unknown" | "ok" | "down" | "down-alerted" | "recovered";

/**
 * Run from a process that is not the worker (the web server). A heartbeat older than the threshold
 * raises one alert per outage (claimed by inserting the `worker_down` row, so replicas cannot both
 * send it); the first fresh heartbeat afterwards sends one recovery notice and clears the flag.
 * No heartbeat ever recorded means no worker has run against this database: nothing to alert on.
 */
export async function checkWorker(db: Db, now: Date = new Date()): Promise<WorkerCheck> {
  const beat = await lastHeartbeat(db);
  if (!beat) return "unknown";
  const ageMs = now.getTime() - beat.getTime();
  if (ageMs > MONITORING.workerStaleMs) {
    const claimed = await db
      .insert(monitorState)
      .values({ key: DOWN, value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing()
      .returning({ key: monitorState.key });
    if (claimed.length === 0) return "down";
    await sendAlert(
      "Worker is down",
      `The background worker has not checked in for ${Math.round(ageMs / 60000)} minutes (last heartbeat ${beat.toISOString()}). Reviews, posts and reports are not being processed until it is restarted. You will get one more email when it is back.`,
    );
    return "down-alerted";
  }
  const cleared = await db.delete(monitorState).where(eq(monitorState.key, DOWN)).returning({ at: monitorState.value });
  if (cleared.length === 0) return "ok";
  await sendAlert("Worker is back", `The background worker is checking in again (outage began ${cleared[0]!.at}).`);
  return "recovered";
}

/**
 * pg-boss jobs that failed for good (retries used up) since the last look, each recorded as a
 * worker error named after its queue. The first run only sets the starting point. Returns how many
 * failed jobs were recorded.
 */
export async function collectFailedJobs(db: Db, now: Date = new Date()): Promise<number> {
  const [cur] = await db.select().from(monitorState).where(eq(monitorState.key, FAILED_CURSOR));
  if (!cur) {
    await db.insert(monitorState).values({ key: FAILED_CURSOR, value: now.toISOString(), updatedAt: now }).onConflictDoNothing();
    return 0;
  }
  // Kept as the database's own text so microseconds are not lost and a job is never read twice.
  const cursorText = cur.value ?? now.toISOString();
  const rows = (await db.execute(sql`
    select name, output, completed_on::text as completed_at from pgboss.job
    where state = 'failed' and completed_on > ${cursorText}::timestamptz
    order by completed_on asc limit 200`)) as unknown as {
    name: string;
    output: { message?: string } | null;
    completed_at: string;
  }[];
  for (const r of rows) {
    const message = typeof r.output?.message === "string" ? r.output.message : "job failed";
    await recordError(db, "worker", { name: `job:${r.name}`, message: sanitizeMessage(message) }, now);
  }
  if (rows.length > 0) {
    await db
      .update(monitorState)
      .set({ value: rows[rows.length - 1]!.completed_at, updatedAt: now })
      .where(eq(monitorState.key, FAILED_CURSOR));
  }
  return rows.length;
}
