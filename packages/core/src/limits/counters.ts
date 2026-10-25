import { sql } from "drizzle-orm";
import { limitCounters, type Db, type Tx } from "@opengmb/db";
import { CoreError } from "../errors";
import { ACCOUNT_DAILY_LABELS, accountDailyCaps, type AccountDailyKind } from "../config/platform-limits";

export const utcDayKey = (d: Date) => d.toISOString().slice(0, 10);
export const utcHourKey = (d: Date) => d.toISOString().slice(0, 13);

/** Adds `by` to a counter and returns the new total. */
export async function bumpCounter(
  db: Db | Tx,
  scope: string,
  kind: string,
  period: string,
  by = 1,
): Promise<number> {
  const [r] = await db
    .insert(limitCounters)
    .values({ scope, kind, period, count: by })
    .onConflictDoUpdate({
      target: [limitCounters.scope, limitCounters.kind, limitCounters.period],
      set: { count: sql`${limitCounters.count} + ${by}`, updatedAt: new Date() },
    })
    .returning({ count: limitCounters.count });
  return r!.count;
}

export async function readCounter(db: Db | Tx, scope: string, kind: string, period: string): Promise<number> {
  const r = await db.execute(
    sql`select count from limit_counters where scope = ${scope} and kind = ${kind} and period = ${period}`,
  );
  return Number((r as unknown as { count: number }[])[0]?.count ?? 0);
}

/**
 * Counts `by` uses of a quota-limited action for this organization today and refuses (RATE_LIMITED,
 * plain message) when that goes over the daily cap. Call inside the action's transaction: a refusal
 * throws, so the increment rolls back and the count stays at the cap.
 */
export async function useAccountDaily(
  tx: Db | Tx,
  orgId: string,
  kind: AccountDailyKind,
  by = 1,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const cap = accountDailyCaps(env)[kind];
  const total = await bumpCounter(tx, orgId, `daily:${kind}`, utcDayKey(now), by);
  if (total > cap) {
    throw new CoreError(
      "RATE_LIMITED",
      `DAILY_LIMIT: your account has reached its limit of ${cap} ${ACCOUNT_DAILY_LABELS[kind]} for today. It resets at 00:00 UTC.`,
    );
  }
}
