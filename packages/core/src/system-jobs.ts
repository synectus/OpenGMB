import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
import { jobRuns, type Db } from "@opengmb/db";
import { DIGEST_CRON } from "./config/digest";
import { PERFORMANCE_CONFIG } from "./config/performance";
import { PROFILE_WATCH_CONFIG } from "./config/profile-watch";
import { REVIEWS_CONFIG } from "./config/reviews";
import { WEBHOOK_PURGE_CRON } from "./config/webhooks";
import { GRID_SWEEP_CRON } from "./config/geogrid";
import { CoreError } from "./errors";

/** The scheduled jobs System status reports, with the cron the worker schedules them on. */
export const SYSTEM_JOBS = [
  { key: "review_sync", label: "Review sync", cron: REVIEWS_CONFIG.syncCron, schedule: "Every 2 hours at :15" },
  { key: "performance_snapshot", label: "Performance snapshot", cron: PERFORMANCE_CONFIG.snapshotCron, schedule: "Daily 03:00" },
  { key: "profile_snapshot", label: "Profile snapshot", cron: PROFILE_WATCH_CONFIG.snapshotCron, schedule: "Daily 03:30" },
  { key: "daily_digest", label: "Daily digest", cron: DIGEST_CRON, schedule: "Hourly sweep; sent at 08:00 in each client's time zone" },
  { key: "monthly_reports", label: "Monthly reports", cron: PERFORMANCE_CONFIG.monthlyReportSweepCron, schedule: "Hourly sweep; sent on the 1st at 09:00 in each client's time zone" },
  { key: "webhook_purge", label: "Webhook delivery cleanup", cron: WEBHOOK_PURGE_CRON, schedule: "Daily 04:15" },
  { key: "geogrid_sweep", label: "Rank scan sweeper", cron: GRID_SWEEP_CRON, schedule: "Every 10 minutes" },
] as const;
export type SystemJobKey = (typeof SYSTEM_JOBS)[number]["key"];

/** Most locations system.status returns (sorted by name). Our own choice. */
export const SYSTEM_STATUS_LOCATION_CAP = 500;

type RunRow = {
  startedAt: Date;
  finishedAt: Date | null;
  status: "running" | "ok" | "failed";
  note: string | null;
  error: string | null;
};

/**
 * What System status shows for one job. Late: the last recorded run started before the
 * second-most-recent scheduled time, so two runs in a row were missed. No run recorded is not late.
 */
export function jobView(cron: string, last: RunRow | null, now: Date) {
  const nextRunAt = CronExpressionParser.parse(cron, { currentDate: now, tz: "UTC" }).next().toDate();
  const back = CronExpressionParser.parse(cron, { currentDate: now, tz: "UTC" });
  back.prev();
  const secondLast = back.prev().toDate();
  return {
    lastRunAt: last ? last.startedAt.toISOString() : null,
    result: last ? last.status : ("never" as const),
    note: last?.note ?? null,
    error: last?.error ?? null,
    nextRunAt: nextRunAt.toISOString(),
    late: last !== null && last.startedAt < secondLast,
  };
}

/**
 * Run a scheduled job and record it in job_runs: a "running" row first, then ok (with an optional
 * fixed note) or failed ("CODE: message"; the error is rethrown so pg-boss still retries).
 */
export async function recordJobRun<T>(
  db: Db,
  job: SystemJobKey,
  run: () => Promise<T>,
  note?: (result: T) => string | null,
): Promise<T> {
  const [row] = await db
    .insert(jobRuns)
    .values({ job, startedAt: new Date(), status: "running" })
    .returning({ id: jobRuns.id });
  try {
    const result = await run();
    await db
      .update(jobRuns)
      .set({ status: "ok", finishedAt: new Date(), note: note ? note(result) : null })
      .where(eq(jobRuns.id, row!.id));
    return result;
  } catch (e) {
    const code = e instanceof CoreError ? e.code : "INTERNAL";
    await db
      .update(jobRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: `${code}: ${e instanceof Error ? e.message : "failed"}`.slice(0, 300),
      })
      .where(eq(jobRuns.id, row!.id));
    throw e;
  }
}
