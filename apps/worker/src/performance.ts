import type { PgBoss } from "pg-boss";
import {
  PERFORMANCE_CONFIG,
  PERFORMANCE_QUEUE_OPTIONS,
  PERFORMANCE_SCHEDULE_QUEUE,
  PERFORMANCE_SNAPSHOT_QUEUE,
  enqueueNightlySnapshots,
  processPerformanceSnapshot,
  deferOnRateLimit,
  recordJobRun,
  type PerformanceSnapshotJob,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";

/** Create (and re-sync options of) the performance queues. Idempotent; see registerPerformanceJobs. */
export async function createPerformanceQueues(boss: PgBoss) {
  for (const queue of [PERFORMANCE_SNAPSHOT_QUEUE, PERFORMANCE_SCHEDULE_QUEUE]) {
    await boss.createQueue(queue, PERFORMANCE_QUEUE_OPTIONS);
    await boss.updateQueue(queue, PERFORMANCE_QUEUE_OPTIONS);
  }
}

/**
 * Nightly Business Profile performance snapshots: a schedule queue fans out one snapshot job per
 * active location; each job fetches from Google (mock client until live access is approved) and
 * upserts. Safe to call on every start.
 */
export async function registerPerformanceJobs(boss: PgBoss, db: Db) {
  await createPerformanceQueues(boss);
  await boss.work<PerformanceSnapshotJob>(PERFORMANCE_SNAPSHOT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      let status = "";
      const d = await deferOnRateLimit({
        queue: PERFORMANCE_SNAPSHOT_QUEUE,
        data: job.data,
        send: (queue, data, options) => boss.send(queue, data, options),
        run: async () => {
          status = (await processPerformanceSnapshot(db, job.data)).status;
        },
      });
      console.log(`[worker] ${PERFORMANCE_SNAPSHOT_QUEUE} job ${job.id} ${d === "done" ? `processed (${status})` : "deferred"}`);
    }
  });
  await boss.schedule(
    PERFORMANCE_SCHEDULE_QUEUE,
    PERFORMANCE_CONFIG.snapshotCron,
    {},
    { tz: "UTC" },
  );
  await boss.work(PERFORMANCE_SCHEDULE_QUEUE, async () => {
    const r = await recordJobRun(db, "performance_snapshot", () => enqueueNightlySnapshots(db));
    console.log(`[worker] ${PERFORMANCE_SCHEDULE_QUEUE}: ${JSON.stringify(r)}`);
  });
}
