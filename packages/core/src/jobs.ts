import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import type { Tx } from "@opengmb/db";

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
