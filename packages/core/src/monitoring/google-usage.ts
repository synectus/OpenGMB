import { desc, gte, sql } from "drizzle-orm";
import { googleApiCalls, googleRateWindows, type Db, type Tx } from "@opengmb/db";
import { GOOGLE_LIMITS } from "../config/google-limits";
import { MONITORING } from "../config/monitoring";
import { PROJECT_BUCKET } from "../google/throttler";

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Counts one Google call (a retry is a call too: Google counts it). Never throws. */
export async function recordGoogleCall(db: Db, method: string, now: Date = new Date()): Promise<void> {
  try {
    await db
      .insert(googleApiCalls)
      .values({ day: utcDay(now), method, calls: 1 })
      .onConflictDoUpdate({
        target: [googleApiCalls.day, googleApiCalls.method],
        set: { calls: sql`${googleApiCalls.calls} + 1` },
      });
  } catch (e) {
    console.error("[monitoring] could not count a Google call", e instanceof Error ? e.message : e);
  }
}

/** Calls per day and method for the last days, plus the busiest minute of the last hour. Read-only. */
export async function googleUsage(db: Db | Tx, now: Date = new Date(), bucket: string = PROJECT_BUCKET) {
  const from = utcDay(new Date(now.getTime() - (MONITORING.googleUsageDays - 1) * 86_400_000));
  const rows = await db
    .select()
    .from(googleApiCalls)
    .where(gte(googleApiCalls.day, from))
    .orderBy(desc(googleApiCalls.day), desc(googleApiCalls.calls));
  const days: { day: string; total: number; methods: { method: string; calls: number }[] }[] = [];
  for (const r of rows) {
    let d = days[days.length - 1];
    if (!d || d.day !== r.day) days.push((d = { day: r.day, total: 0, methods: [] }));
    d.total += r.calls;
    d.methods.push({ method: r.method, calls: r.calls });
  }
  const [peak] = await db
    .select({ peak: sql<number>`coalesce(max(${googleRateWindows.count}), 0)::int` })
    .from(googleRateWindows)
    .where(
      sql`${googleRateWindows.bucketKey} = ${bucket} and ${googleRateWindows.windowStart} > ${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz`,
    );
  return {
    limitPerMinute: GOOGLE_LIMITS.projectQpm.limit,
    busiestMinuteLastHour: peak?.peak ?? 0,
    days,
  };
}
