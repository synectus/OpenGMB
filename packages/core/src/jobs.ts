import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import type { Db, Tx } from "@opengmb/db";
import { isOrgBlocked, isOrgPurged } from "./account-state";

/**
 * Enqueue a pg-boss job through the caller's transaction, so the job exists if and only if the
 * transaction commits. The PgBoss instance is never started and owns no connection: every statement
 * it runs goes through `tx`. The queue must already exist (the worker creates it at startup).
 */
export async function enqueueJob(
  tx: Tx,
  queue: string,
  data: object,
  opts: { startAfterSeconds?: number } = {},
): Promise<string> {
  const boss = new PgBoss({ db: fromDrizzle(tx, sql) });
  const id = await boss.send(
    queue,
    data,
    opts.startAfterSeconds && opts.startAfterSeconds > 0 ? { startAfter: Math.round(opts.startAfterSeconds) } : {},
  );
  if (!id) throw new Error(`pg-boss did not enqueue a job on ${queue}`);
  return id;
}

/**
 * Install the pg-boss schema (if missing) and create the given queues, then stop. The worker does
 * this at startup; scripts that enqueue before any worker has run against a fresh database (the
 * e2e seed) call it first.
 */
export async function ensureQueues(connectionString: string, queues: string[]): Promise<void> {
  const boss = new PgBoss(connectionString);
  await boss.start();
  try {
    for (const queue of queues) await boss.createQueue(queue);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/** How long a job waits before it runs again when its organization was suspended or deleted at job start (AP3b). */
export const BLOCKED_REDELIVER_SECONDS = 30 * 60;

/**
 * AP3b: the job-start guard for a job whose item has no state a sweep would pick up again (an edit already `applying`,
 * a delete, a webhook). pg-boss marks the job complete when the handler returns, so the guard re-queues the same job for
 * later in the caller's transaction instead of dropping it. After unsuspend the redelivered job runs as if nothing happened;
 * while the org stays blocked it is redelivered again, one cheap row per half hour.
 */
export async function deferBlockedJob(tx: Tx, queue: string, data: object, orgId: string): Promise<void> {
  // AP3c: a purged account never comes back, so its job ends here instead of being redelivered forever.
  if (await isOrgPurged(tx, orgId)) return;
  await enqueueJob(tx, queue, data, { startAfterSeconds: BLOCKED_REDELIVER_SECONDS });
}

/** The usual job-start guard: true (and the same job queued for later) when `orgId` is suspended or deleted. The caller returns without doing the work. */
export async function deferIfBlocked(db: Db, orgId: string, queue: string, data: object): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await isOrgBlocked(tx, orgId))) return false;
    await deferBlockedJob(tx, queue, data, orgId);
    return true;
  });
}
