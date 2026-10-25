import { PgBoss } from "pg-boss";
import {
  NOTIFICATION_REGISTER_CRON,
  NOTIFICATION_REGISTER_QUEUE,
  runNotificationRegistration,
  type RegisterJob,
  CUSTOMER_MEDIA_QUEUE_OPTIONS,
  purgeStaleMediaUploads,
  CUSTOMER_MEDIA_SCAN_QUEUE,
  CUSTOMER_MEDIA_SCHEDULE_QUEUE,
  GRID_COLLECT_QUEUE,
  GRID_QUEUE_OPTIONS,
  GRID_RUN_QUEUE,
  GRID_SCHEDULE_CRON,
  GRID_SCHEDULE_QUEUE,
  COMPETITOR_COLLECT_CRON,
  COMPETITOR_COLLECT_QUEUE,
  COMPETITOR_REFRESH_CRON,
  COMPETITOR_REFRESH_QUEUE,
  collectCompetitorProfiles,
  AI_VISIBILITY_CRON,
  AI_VISIBILITY_QUEUE,
  enqueueDueAiVisibilityChecks,
  runAiVisibilityCheck,
  enqueueDueCompetitorRefreshes,
  LOCATION_IMPORT_QUEUE,
  LOCATION_CENTER_QUEUE,
  LOCATION_CENTER_QUEUE_OPTIONS,
  processLocationCenter,
  type LocationCenterJob,
  LOCATION_OP_QUEUE,
  LOCATION_OP_QUEUE_OPTIONS,
  LOCATION_OP_SWEEP_CRON,
  LOCATION_OP_SWEEP_QUEUE,
  REVIEW_REQUEST_SWEEP_CRON,
  REVIEW_REQUEST_SWEEP_QUEUE,
  sweepDueLocationOps,
  sweepReviewRequests,
  POST_DELETE_QUEUE,
  POST_EDIT_QUEUE,
  POST_QUEUE_OPTIONS,
  POST_SEND_QUEUE,
  POST_SWEEP_CRON,
  POST_SWEEP_QUEUE,
  PROFILE_APPLY_QUEUE,
  PROFILE_QUEUE_OPTIONS,
  PROFILE_SNAPSHOT_QUEUE,
  PROFILE_SNAPSHOT_SCHEDULE_QUEUE,
  PROFILE_WATCH_CONFIG,
  PROFILE_WATCH_QUEUE_OPTIONS,
  REPLY_DELETE_QUEUE,
  REPLY_PUBLISH_QUEUE,
  REPLY_QUEUE_OPTIONS,
  REVIEWS_CONFIG,
  REVIEW_SCHEDULE_QUEUE,
  REVIEW_SYNC_QUEUE,
  REVIEW_MIRROR_QUEUE,
  processReviewMirror,
  deferOnRateLimit,
  type ReviewMirrorJob,
  DRAFT_ARRIVAL_QUEUE,
  DRAFT_ARRIVAL_QUEUE_OPTIONS,
  processArrivalDraft,
  REVIEW_SYNC_QUEUE_OPTIONS,
  googleJwks,
  createLiveDriverRegistry,
  enqueueCustomerMediaScans,
  enqueueDueGridRuns,
  enqueueNightlyProfileSnapshots,
  enqueueScheduledReviewSyncs,
  processGridCollect,
  sweepStaleGridTasks,
  GRID_SWEEP_CRON,
  processGridRun,
  processCustomerMediaScan,
  processLocationImport,
  processLocationOp,
  processPostDelete,
  processPostEdit,
  processPostSend,
  processProfileApply,
  processProfileSnapshot,
  processReplyDelete,
  processReplyPublish,
  processReviewSync,
  MONITORING,
  checkLimitAlerts,
  collectFailedJobs,
  recordError,
  recordHeartbeat,
  recordJobRun,
  toErrorInfo,
  getIntegration,
  reportStartupConfig,
  startIntegrations,
  sweepDuePosts,
  type CustomerMediaScanJob,
  type LocationOpJob,
  type PostDeleteJob,
  type PostEditJob,
  type PostSendJob,
  type ProfileApplyJob,
  type ProfileSnapshotJob,
  type ReplyDeleteJob,
} from "@opengmb/core";
import { createDb } from "@opengmb/db";
import { GOOGLE_NOTIFICATION_QUEUE, handleGoogleNotificationJobs } from "./google-notification";
import { DIGEST_QUEUE, registerDigestSchedule, resendSendEmail, runDigest } from "./digest";
import { createPerformanceQueues, registerPerformanceJobs } from "./performance";
import { registerReportJobs } from "./reports";
import { registerReviewTopicJobs } from "./review-topics";
import { registerWebhookJobs } from "./webhooks";
import { startServer } from "./http";

reportStartupConfig("worker");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const HEARTBEAT_QUEUE = "heartbeat";
const port = Number(process.env.WORKER_PORT || 3200);

const { db, sql } = createDb(connectionString);
await startIntegrations("worker", db);
const boss = new PgBoss(connectionString);
boss.on("error", (err) => console.error("[worker] pg-boss error", err));

await boss.start();
await boss.createQueue(HEARTBEAT_QUEUE);
await boss.createQueue(GOOGLE_NOTIFICATION_QUEUE);
// The location import enqueues a snapshot job per imported location: the queue must exist before
// the first import job can run on a fresh database.
await createPerformanceQueues(boss);
await boss.createQueue(LOCATION_IMPORT_QUEUE);
// Coordinates for a new (or moved) location, its own job so the import never waits on it.
await boss.createQueue(LOCATION_CENTER_QUEUE, LOCATION_CENTER_QUEUE_OPTIONS);
await boss.updateQueue(LOCATION_CENTER_QUEUE, LOCATION_CENTER_QUEUE_OPTIONS);
await boss.work<LocationCenterJob>(LOCATION_CENTER_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const r = await processLocationCenter(db, job.data);
    console.log(`[worker] ${LOCATION_CENTER_QUEUE} job ${job.id} processed (${r.outcome})`);
  }
});
// OPS2: a Google rate limit re-queues the job later (70 s, then doubling) instead of failing it.
const sendJob = (queue: string, data: object, options: { startAfter: number }) => boss.send(queue, data, options);
await boss.work<{ importId: string; rlAttempt?: number }>(LOCATION_IMPORT_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const r = await deferOnRateLimit({
      queue: LOCATION_IMPORT_QUEUE,
      data: job.data,
      send: sendJob,
      run: () => processLocationImport(db, job.data.importId),
    });
    console.log(`[worker] ${LOCATION_IMPORT_QUEUE} job ${job.id} ${r === "done" ? "processed" : "deferred"}`);
  }
});
await boss.createQueue(REVIEW_SYNC_QUEUE, REVIEW_SYNC_QUEUE_OPTIONS);
// createQueue does not change an existing queue: keep its retry options in step with the code.
await boss.updateQueue(REVIEW_SYNC_QUEUE, REVIEW_SYNC_QUEUE_OPTIONS);
await boss.work<{ syncId: string; rlAttempt?: number }, void, { includeMetadata: true }>(
  REVIEW_SYNC_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const r = await deferOnRateLimit({
        queue: REVIEW_SYNC_QUEUE,
        data: job.data,
        send: sendJob,
        run: ({ canDefer }) =>
          processReviewSync(db, job.data.syncId, {
            isFinalAttempt: job.retryCount >= job.retryLimit,
            deferRateLimit: canDefer,
          }),
      });
      console.log(`[worker] ${REVIEW_SYNC_QUEUE} job ${job.id} ${r === "done" ? "processed" : "deferred"}`);
    }
  },
);
await boss.createQueue(REVIEW_MIRROR_QUEUE, REVIEW_SYNC_QUEUE_OPTIONS);
await boss.updateQueue(REVIEW_MIRROR_QUEUE, REVIEW_SYNC_QUEUE_OPTIONS);
await boss.work<ReviewMirrorJob>(REVIEW_MIRROR_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const r = await deferOnRateLimit({
      queue: REVIEW_MIRROR_QUEUE,
      data: job.data,
      send: sendJob,
      run: () => processReviewMirror(db, job.data),
    });
    console.log(`[worker] ${REVIEW_MIRROR_QUEUE} job ${job.id} ${r === "done" ? "processed" : "deferred"}`);
  }
});
for (const queue of [REPLY_PUBLISH_QUEUE, REPLY_DELETE_QUEUE]) {
  await boss.createQueue(queue, REPLY_QUEUE_OPTIONS);
  await boss.updateQueue(queue, REPLY_QUEUE_OPTIONS);
}
await boss.work<{ replyId: string }, void, { includeMetadata: true }>(
  REPLY_PUBLISH_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const status = await processReplyPublish(db, job.data.replyId, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(
        `[worker] ${REPLY_PUBLISH_QUEUE} job ${job.id} processed (${status ?? "skipped"})`,
      );
    }
  },
);
await boss.work<ReplyDeleteJob, void, { includeMetadata: true }>(
  REPLY_DELETE_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const outcome = await processReplyDelete(db, job.data, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${REPLY_DELETE_QUEUE} job ${job.id} processed (${outcome})`);
    }
  },
);
for (const queue of [POST_SEND_QUEUE, POST_DELETE_QUEUE, POST_EDIT_QUEUE]) {
  await boss.createQueue(queue, POST_QUEUE_OPTIONS);
  await boss.updateQueue(queue, POST_QUEUE_OPTIONS);
}
await boss.work<PostSendJob, void, { includeMetadata: true }>(
  POST_SEND_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const status = await processPostSend(db, job.data, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${POST_SEND_QUEUE} job ${job.id} processed (${status ?? "skipped"})`);
    }
  },
);
await boss.work<PostDeleteJob, void, { includeMetadata: true }>(
  POST_DELETE_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const r = await processPostDelete(db, job.data, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${POST_DELETE_QUEUE} job ${job.id} processed (${JSON.stringify(r)})`);
    }
  },
);
await boss.work<PostEditJob, void, { includeMetadata: true }>(
  POST_EDIT_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const status = await processPostEdit(db, job.data, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${POST_EDIT_QUEUE} job ${job.id} processed (${status ?? "skipped"})`);
    }
  },
);
// Profile edits: one job per location of an approved change set. The job may wait for the
// per-location edit queue (10 edits/min), which is why it runs here and never in an action.
await boss.createQueue(PROFILE_APPLY_QUEUE, PROFILE_QUEUE_OPTIONS);
await boss.updateQueue(PROFILE_APPLY_QUEUE, PROFILE_QUEUE_OPTIONS);
await boss.work<ProfileApplyJob, void, { includeMetadata: true }>(
  PROFILE_APPLY_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const r = await processProfileApply(db, job.data, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${PROFILE_APPLY_QUEUE} job ${job.id} processed (${r})`);
    }
  },
);
// Change watch: a nightly schedule fans out one snapshot job per active location; each job reads
// Google outside any transaction, stores a snapshot when the hash changed and records the diff.
for (const queue of [PROFILE_SNAPSHOT_QUEUE, PROFILE_SNAPSHOT_SCHEDULE_QUEUE]) {
  await boss.createQueue(queue, PROFILE_WATCH_QUEUE_OPTIONS);
  await boss.updateQueue(queue, PROFILE_WATCH_QUEUE_OPTIONS);
}
await boss.work<ProfileSnapshotJob>(PROFILE_SNAPSHOT_QUEUE, async (jobs) => {
  for (const job of jobs) {
    let out = "";
    const d = await deferOnRateLimit({
      queue: PROFILE_SNAPSHOT_QUEUE,
      data: job.data,
      send: sendJob,
      run: async () => {
        out = String(await processProfileSnapshot(db, job.data));
      },
    });
    console.log(`[worker] ${PROFILE_SNAPSHOT_QUEUE} job ${job.id} ${d === "done" ? `processed (${out})` : "deferred"}`);
  }
});
await boss.schedule(
  PROFILE_SNAPSHOT_SCHEDULE_QUEUE,
  PROFILE_WATCH_CONFIG.snapshotCron,
  {},
  { tz: "UTC" },
);
await boss.work(PROFILE_SNAPSHOT_SCHEDULE_QUEUE, async () => {
  const r = await recordJobRun(db, "profile_snapshot", () => enqueueNightlyProfileSnapshots(db));
  console.log(`[worker] ${PROFILE_SNAPSHOT_SCHEDULE_QUEUE}: ${JSON.stringify(r)}`);
});
// Photos and place action links: one job per queued operation (the job may wait for the
// per-location edit queue, which is why it runs here and never in an action).
await boss.createQueue(LOCATION_OP_QUEUE, LOCATION_OP_QUEUE_OPTIONS);
await boss.updateQueue(LOCATION_OP_QUEUE, LOCATION_OP_QUEUE_OPTIONS);
await boss.work<LocationOpJob, void, { includeMetadata: true }>(
  LOCATION_OP_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const r = await processLocationOp(db, job.data, {
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${LOCATION_OP_QUEUE} job ${job.id} processed (${r})`);
    }
  },
);
// Customer-photo monitoring: nightly fan-out, one scan job per active location.
for (const queue of [CUSTOMER_MEDIA_SCAN_QUEUE, CUSTOMER_MEDIA_SCHEDULE_QUEUE]) {
  await boss.createQueue(queue, CUSTOMER_MEDIA_QUEUE_OPTIONS);
  await boss.updateQueue(queue, CUSTOMER_MEDIA_QUEUE_OPTIONS);
}
await boss.work<CustomerMediaScanJob>(CUSTOMER_MEDIA_SCAN_QUEUE, async (jobs) => {
  for (const job of jobs) {
    let out = "";
    const d = await deferOnRateLimit({
      queue: CUSTOMER_MEDIA_SCAN_QUEUE,
      data: job.data,
      send: sendJob,
      run: async () => {
        out = (await processCustomerMediaScan(db, job.data)).status;
      },
    });
    console.log(`[worker] ${CUSTOMER_MEDIA_SCAN_QUEUE} job ${job.id} ${d === "done" ? `processed (${out})` : "deferred"}`);
  }
});
await boss.schedule(
  CUSTOMER_MEDIA_SCHEDULE_QUEUE,
  PROFILE_WATCH_CONFIG.customerMediaCron,
  {},
  { tz: "UTC" },
);
await boss.work(CUSTOMER_MEDIA_SCHEDULE_QUEUE, async () => {
  const r = await enqueueCustomerMediaScans(db);
  console.log(`[worker] ${CUSTOMER_MEDIA_SCHEDULE_QUEUE}: ${JSON.stringify(r)}`);
  // Same nightly tick: drop staged bytes of failed photo uploads past their retention.
  const purged = await purgeStaleMediaUploads(db);
  console.log(`[worker] media upload purge: ${JSON.stringify(purged)}`);
});
// Scheduled posts: a minute-level sweep claims due posts (the database is the schedule).
await boss.createQueue(POST_SWEEP_QUEUE);
await boss.schedule(POST_SWEEP_QUEUE, POST_SWEEP_CRON, {}, { tz: "UTC" });
await boss.work(POST_SWEEP_QUEUE, async () => {
  const r = await sweepDuePosts(db);
  if (r.claimed > 0) console.log(`[worker] ${POST_SWEEP_QUEUE}: claimed ${r.claimed}`);
});
// Scheduled photo uploads: the same minute-level sweep, for location_write_ops.
await boss.createQueue(LOCATION_OP_SWEEP_QUEUE);
await boss.schedule(LOCATION_OP_SWEEP_QUEUE, LOCATION_OP_SWEEP_CRON, {}, { tz: "UTC" });
await boss.work(LOCATION_OP_SWEEP_QUEUE, async () => {
  const r = await sweepDueLocationOps(db);
  if (r.claimed > 0) console.log(`[worker] ${LOCATION_OP_SWEEP_QUEUE}: claimed ${r.claimed}`);
});
// Review request emails (R2): paced first sends and the single reminder.
await boss.createQueue(REVIEW_REQUEST_SWEEP_QUEUE);
await boss.schedule(REVIEW_REQUEST_SWEEP_QUEUE, REVIEW_REQUEST_SWEEP_CRON, {}, { tz: "UTC" });
await boss.work(REVIEW_REQUEST_SWEEP_QUEUE, async () => {
  const r = await sweepReviewRequests(db);
  if (r.sent + r.reminders + r.skipped > 0) console.log(`[worker] ${REVIEW_REQUEST_SWEEP_QUEUE}: sent ${r.sent}, reminders ${r.reminders}, skipped ${r.skipped}`);
});
// Instant review alerts (PS): point Google accounts at our Pub/Sub topic. Queued on connect and by the admin
// button; the daily schedule re-checks every account that has locations here and repairs drift.
await boss.createQueue(NOTIFICATION_REGISTER_QUEUE);
await boss.schedule(NOTIFICATION_REGISTER_QUEUE, NOTIFICATION_REGISTER_CRON, { scope: "relevant" }, { tz: "UTC" });
await boss.work<RegisterJob>(NOTIFICATION_REGISTER_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const r = await runNotificationRegistration(db, job.data ?? { scope: "relevant" });
    console.log(`[worker] ${NOTIFICATION_REGISTER_QUEUE}: ${JSON.stringify(r)}`);
  }
});
await boss.work(HEARTBEAT_QUEUE, async (jobs) => {
  for (const job of jobs) console.log(`[worker] heartbeat job ${job.id} processed`);
});
await boss.work<{ notificationId: string }>(GOOGLE_NOTIFICATION_QUEUE, (jobs) =>
  handleGoogleNotificationJobs(db, jobs),
);
await registerDigestSchedule(boss);
await boss.work(DIGEST_QUEUE, async () => {
  const apiKey = getIntegration("RESEND_API_KEY");
  await recordJobRun(
    db,
    "daily_digest",
    () =>
      runDigest(db, {
        sendEmail: resendSendEmail(apiKey ?? ""),
        apiKey,
        from: getIntegration("EMAIL_FROM"),
        appUrl: process.env.BETTER_AUTH_URL ?? "",
      }),
    () => (apiKey ? null : "skipped: email not set up"),
  );
});
// Geo-grid: live DataForSEO / Places when the keys are set (Settings > Integrations or env), fixtures otherwise.
const gridDrivers = createLiveDriverRegistry();
for (const queue of [GRID_RUN_QUEUE, GRID_COLLECT_QUEUE]) {
  await boss.createQueue(queue, GRID_QUEUE_OPTIONS);
  await boss.updateQueue(queue, GRID_QUEUE_OPTIONS);
}
await boss.work<{ runId: string }>(GRID_RUN_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const outcome = await processGridRun(db, job.data.runId, {
      drivers: gridDrivers,
      pingbackBaseUrl: process.env.WORKER_PUBLIC_URL,
    });
    console.log(`[worker] ${GRID_RUN_QUEUE} job ${job.id} processed (${outcome})`);
  }
});
await boss.work<{ taskId: string }, void, { includeMetadata: true }>(
  GRID_COLLECT_QUEUE,
  { includeMetadata: true },
  async (jobs) => {
    for (const job of jobs) {
      const outcome = await processGridCollect(db, job.data.taskId, {
        drivers: gridDrivers,
        isFinalAttempt: job.retryCount >= job.retryLimit,
      });
      console.log(`[worker] ${GRID_COLLECT_QUEUE} job ${job.id} processed (${outcome})`);
    }
  },
);
await boss.createQueue(GRID_SCHEDULE_QUEUE);
await boss.schedule(GRID_SCHEDULE_QUEUE, GRID_SCHEDULE_CRON, {}, { tz: "UTC" });
await boss.work(GRID_SCHEDULE_QUEUE, async () => {
  const r = await enqueueDueGridRuns(db, { drivers: gridDrivers });
  console.log(`[worker] ${GRID_SCHEDULE_QUEUE}: ${JSON.stringify(r)}`);
});
// Lost pingbacks: every 10 minutes, fetch results for tasks that never got one (and give up after 3 hours).
// Keep the collect queue's localConcurrency at its default (1); anything up to 10 stays under DataForSEO's 30 simultaneous requests.
const GRID_SWEEP_QUEUE = "geogrid.sweep";
await boss.createQueue(GRID_SWEEP_QUEUE);
await boss.schedule(GRID_SWEEP_QUEUE, GRID_SWEEP_CRON, {}, { tz: "UTC" });
await boss.work(GRID_SWEEP_QUEUE, async () => {
  const r = await recordJobRun(db, "geogrid_sweep", () => sweepStaleGridTasks(db));
  console.log(`[worker] ${GRID_SWEEP_QUEUE}: ${JSON.stringify(r)}`);
});
// K2 part 2: competitor profiles refresh on their own schedule (daily tick, each tracker weekly by default), and their Standard-queue answers are collected every 10 minutes.
await boss.createQueue(COMPETITOR_REFRESH_QUEUE);
await boss.schedule(COMPETITOR_REFRESH_QUEUE, COMPETITOR_REFRESH_CRON, {}, { tz: "UTC" });
await boss.work(COMPETITOR_REFRESH_QUEUE, async () => {
  const r = await enqueueDueCompetitorRefreshes(db);
  console.log(`[worker] ${COMPETITOR_REFRESH_QUEUE}: ${JSON.stringify(r)}`);
});
// K5: AI search visibility. A daily tick checks each enabled location once a week; a manual check is a job with a locationId and force.
await boss.createQueue(AI_VISIBILITY_QUEUE);
await boss.schedule(AI_VISIBILITY_QUEUE, AI_VISIBILITY_CRON, {}, { tz: "UTC" });
await boss.work<{ locationId?: string; force?: boolean }>(AI_VISIBILITY_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const { locationId, force } = job.data ?? {};
    const r = locationId ? await runAiVisibilityCheck(db, locationId, { force: !!force }) : await enqueueDueAiVisibilityChecks(db);
    console.log(`[worker] ${AI_VISIBILITY_QUEUE}: ${JSON.stringify(r)}`);
  }
});
await boss.createQueue(COMPETITOR_COLLECT_QUEUE);
await boss.schedule(COMPETITOR_COLLECT_QUEUE, COMPETITOR_COLLECT_CRON, {}, { tz: "UTC" });
await boss.work(COMPETITOR_COLLECT_QUEUE, async () => {
  const r = await collectCompetitorProfiles(db);
  console.log(`[worker] ${COMPETITOR_COLLECT_QUEUE}: ${JSON.stringify(r)}`);
});

// A2: one AI reply draft per new review, its own job so the sync never waits on or fails because of AI.
await boss.createQueue(DRAFT_ARRIVAL_QUEUE, DRAFT_ARRIVAL_QUEUE_OPTIONS);
await boss.updateQueue(DRAFT_ARRIVAL_QUEUE, DRAFT_ARRIVAL_QUEUE_OPTIONS);
await boss.work<{ reviewId: string }>(DRAFT_ARRIVAL_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const r = await processArrivalDraft(db, job.data.reviewId);
    console.log(`[worker] ${DRAFT_ARRIVAL_QUEUE} job ${job.id} processed (${r})`);
  }
});

// Review polling: a schedule queue fans out one `reviews.sync` per active linked location.
await boss.createQueue(REVIEW_SCHEDULE_QUEUE, REVIEW_SYNC_QUEUE_OPTIONS);
await boss.updateQueue(REVIEW_SCHEDULE_QUEUE, REVIEW_SYNC_QUEUE_OPTIONS);
await boss.schedule(REVIEW_SCHEDULE_QUEUE, REVIEWS_CONFIG.syncCron, {}, { tz: "UTC" });
await boss.work(REVIEW_SCHEDULE_QUEUE, async () => {
  const r = await recordJobRun(db, "review_sync", () => enqueueScheduledReviewSyncs(db));
  console.log(`[worker] ${REVIEW_SCHEDULE_QUEUE}: ${JSON.stringify(r)}`);
});
await registerPerformanceJobs(boss, db);
await registerReportJobs(boss, db);
await registerReviewTopicJobs(boss, db);
await registerWebhookJobs(boss, db);
await boss.send(HEARTBEAT_QUEUE, { at: new Date().toISOString() });

// H2: tell the web server we are alive, and report jobs that failed for good (retries used up).
// The web server alerts when the heartbeat goes stale; a worker cannot report its own death.
const monitorTick = async () => {
  try {
    await recordHeartbeat(db);
    await collectFailedJobs(db);
    await checkLimitAlerts(db);
  } catch (e) {
    console.error("[worker] monitor tick failed", e instanceof Error ? e.message : e);
  }
};
await monitorTick();
setInterval(monitorTick, MONITORING.workerTickMs).unref();
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection", reason);
  void recordError(db, "worker", toErrorInfo(reason));
});

const jwks = googleJwks();
const pubsubConfig = () => {
  const audience = getIntegration("PUBSUB_AUDIENCE");
  const serviceAccountEmail = getIntegration("PUBSUB_SERVICE_ACCOUNT_EMAIL");
  return audience && serviceAccountEmail ? { audience, serviceAccountEmail, jwks } : null;
};
const pubsub = pubsubConfig();
const server = await startServer(port, { db, boss, pubsub: pubsubConfig });

console.log(
  `[worker] pg-boss started, heartbeat + ${GOOGLE_NOTIFICATION_QUEUE} + ${LOCATION_IMPORT_QUEUE} + ${REVIEW_SYNC_QUEUE} + ${REPLY_PUBLISH_QUEUE} + ${REPLY_DELETE_QUEUE} + ${POST_SEND_QUEUE} + ${POST_DELETE_QUEUE} + ${POST_EDIT_QUEUE} + ${POST_SWEEP_QUEUE} + ${PROFILE_APPLY_QUEUE} + ${PROFILE_SNAPSHOT_QUEUE} + ${LOCATION_OP_QUEUE} + ${LOCATION_OP_SWEEP_QUEUE} + ${CUSTOMER_MEDIA_SCAN_QUEUE} + ${DIGEST_QUEUE} workers registered; http on :${server.port}; pubsub webhook ${pubsub ? "configured" : "NOT configured (503)"}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server
      .close()
      .then(() => boss.stop())
      .then(() => sql.end())
      .finally(() => process.exit(0));
  });
}
