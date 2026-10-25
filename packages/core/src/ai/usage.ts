import { and, eq, gte, sql } from "drizzle-orm";
import { aiUsage, workspaceAiSettings, type Tx } from "@opengmb/db";
import { utcMonthStart } from "./money";

/** Serialises every AI call on the platform, so two calls cannot both pass the same cap check. */
export async function lockAiBudget(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('ai-budget', 0))`);
}

/** Micro-USD spent platform-wide (all organizations) in the UTC month of `now`. */
export async function platformSpentMicroUsd(tx: Tx, now: Date): Promise<number> {
  const [r] = await tx
    .select({ s: sql<string>`coalesce(sum(${aiUsage.costMicroUsd}), 0)` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, utcMonthStart(now)));
  return Number(r?.s ?? 0);
}

export async function workspaceSpentMicroUsd(tx: Tx, workspaceId: string, now: Date): Promise<number> {
  const [r] = await tx
    .select({ s: sql<string>`coalesce(sum(${aiUsage.costMicroUsd}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.createdAt, utcMonthStart(now))));
  return Number(r?.s ?? 0);
}

export async function workspaceCapMicroUsd(tx: Tx, workspaceId: string): Promise<number | null> {
  const [r] = await tx
    .select({ c: workspaceAiSettings.monthlyCapMicroUsd })
    .from(workspaceAiSettings)
    .where(eq(workspaceAiSettings.workspaceId, workspaceId));
  return r?.c ?? null;
}
