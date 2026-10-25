import type { PgBoss } from "pg-boss";
import {
  processWebhookDelivery,
  purgeOldWebhookDeliveries,
  recordJobRun,
  WEBHOOK_PURGE_CRON,
  WEBHOOK_PURGE_QUEUE,
  WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_OPTIONS,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";

export type WebhookJob = {
  id: string;
  data: { deliveryId: string };
  retryCount: number;
  retryLimit: number;
};

/** Sends each queued delivery. A retryable failure throws inside, so pg-boss retries the job. */
export async function handleWebhookJobs(db: Db, jobs: WebhookJob[]) {
  for (const job of jobs) {
    const outcome = await processWebhookDelivery(db, job.data.deliveryId, {
      isFinalAttempt: job.retryCount >= job.retryLimit,
    });
    console.log(`[worker] ${WEBHOOK_QUEUE} job ${job.id} processed (${outcome ?? "skipped"})`);
  }
}

/** G7a: outgoing webhooks. Creating a queue does not change an existing one, so update it too. */
export async function registerWebhookJobs(
  boss: PgBoss,
  db: Db,
  /** Tests pass their own names so a live consumer never competes for another file's jobs. */
  queues: { deliver: string; purge: string } = { deliver: WEBHOOK_QUEUE, purge: WEBHOOK_PURGE_QUEUE },
) {
  await boss.createQueue(queues.deliver, WEBHOOK_QUEUE_OPTIONS);
  await boss.updateQueue(queues.deliver, WEBHOOK_QUEUE_OPTIONS);
  await boss.work<{ deliveryId: string }, void, { includeMetadata: true }>(
    queues.deliver,
    { includeMetadata: true },
    (jobs) => handleWebhookJobs(db, jobs),
  );
  // Daily: drop settled deliveries past retention (their payload holds review text).
  await boss.createQueue(queues.purge);
  await boss.schedule(queues.purge, WEBHOOK_PURGE_CRON, {}, { tz: "UTC" });
  await boss.work(queues.purge, async () => {
    const deleted = await recordJobRun(
      db,
      "webhook_purge",
      () => purgeOldWebhookDeliveries(db),
      (n) => `deleted ${n}`,
    );
    console.log(`[worker] ${queues.purge}: deleted ${deleted}`);
  });
}
