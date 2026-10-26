import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { gridTasks, type Db } from "@opengmb/db";
import { GEOGRID_DEFAULTS } from "../config/geogrid";
import { orgIsActive } from "../account-state";
import { finalizeRunIfSettled, markReceivedAndCollect } from "./run";

/**
 * Lost-pingback safety net. A task still "submitted" after staleAfterMs is treated as if its pingback
 * had arrived (marked received, collect job queued); one still empty after giveUpAfterMs is failed so
 * the run can settle. Age is measured from submitted_at (created_at for tasks submitted before K1).
 * Safe to run at any time: a late pingback for a task already moved on is a duplicate.
 */
export async function sweepStaleGridTasks(
  db: Db,
  opts: { now?: Date; staleAfterMs?: number; giveUpAfterMs?: number; orgIds?: string[] } = {},
): Promise<{ checked: number; enqueued: number; failed: number }> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (opts.staleAfterMs ?? GEOGRID_DEFAULTS.staleTaskAfterMs));
  const giveUpBefore = new Date(now.getTime() - (opts.giveUpAfterMs ?? GEOGRID_DEFAULTS.giveUpTaskAfterMs));
  const age = sql`coalesce(${gridTasks.submittedAt}, ${gridTasks.createdAt})`;
  const stale = await db
    .select({ id: gridTasks.id })
    .from(gridTasks)
    .where(
      and(
        eq(gridTasks.status, "submitted"),
        lt(age, sql`${staleBefore.toISOString()}::timestamptz`),
        // Tests only; production sweeps every org.
        opts.orgIds ? inArray(gridTasks.orgId, opts.orgIds) : undefined,
        // AP3b: a blocked org's tasks stay `submitted`; the sweep takes them after unsuspend.
        orgIsActive(gridTasks.orgId),
      ),
    );
  let enqueued = 0;
  let failed = 0;
  for (const { id } of stale) {
    await db.transaction(async (tx) => {
      const [task] = await tx.select().from(gridTasks).where(eq(gridTasks.id, id)).for("update");
      if (!task || task.status !== "submitted") return; // a pingback got there first
      const since = task.submittedAt ?? task.createdAt;
      if (since < giveUpBefore) {
        await tx
          .update(gridTasks)
          .set({ status: "failed", error: `no_result: DataForSEO returned nothing within ${Math.round((opts.giveUpAfterMs ?? GEOGRID_DEFAULTS.giveUpTaskAfterMs) / 3_600_000)}h` })
          .where(eq(gridTasks.id, id));
        await finalizeRunIfSettled(tx, task.runId);
        failed++;
      } else {
        await markReceivedAndCollect(tx, id);
        enqueued++;
      }
    });
  }
  return { checked: stale.length, enqueued, failed };
}
