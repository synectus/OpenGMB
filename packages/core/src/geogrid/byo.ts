import { and, eq, gte, lt, sql } from "drizzle-orm";
import { gridRuns, gridTasks, orgDataforseoCredentials, type Db, type Tx } from "@opengmb/db";
import { taskPriceUsd } from "../config/geogrid";
import { decryptSecret } from "../crypto";
import type { DfsCredentials } from "./drivers/fixtures";

/** "jane.doe@example.com" -> "ja***@example.com"; anything without an @ -> "ja***". Never the full login. */
export function maskLogin(login: string): string {
  const at = login.indexOf("@");
  const local = at === -1 ? login : login.slice(0, at);
  const domain = at === -1 ? "" : login.slice(at);
  return `${local.slice(0, 2)}***${domain}`;
}

export async function hasByoKey(db: Db | Tx, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ orgId: orgDataforseoCredentials.orgId })
    .from(orgDataforseoCredentials)
    .where(eq(orgDataforseoCredentials.orgId, orgId));
  return !!row;
}

/** Decrypted credentials, or null when the org has no key. Only drivers and the verify action call this. */
export async function loadByoCredentials(
  db: Db | Tx,
  orgId: string,
): Promise<DfsCredentials | null> {
  const [row] = await db
    .select()
    .from(orgDataforseoCredentials)
    .where(eq(orgDataforseoCredentials.orgId, orgId));
  return row ? { login: row.login, password: decryptSecret(row.passwordEnc) } : null;
}

export type UsageBucket = {
  runs: number;
  /** Points submitted to the provider (one task per point per keyword). */
  points: number;
  /** Tasks that returned results; the billable ones. */
  tasks: number;
  costAtDataforseoUsd: number;
  chargedUsd: number;
};
export type UsageMonth = {
  month: string;
  byo: UsageBucket;
  resold: UsageBucket;
  total: UsageBucket;
};

const empty = (): UsageBucket => ({
  runs: 0,
  points: 0,
  tasks: 0,
  costAtDataforseoUsd: 0,
  chargedUsd: 0,
});
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Per UTC month of run creation in [from, to): runs, points, billable tasks, what DataForSEO
 * charges for them (tasks x the configured per-task price) and what we charged the org. BYO runs
 * are charged at cost (no markup); resold runs carry the org's markup. Unsettled runs count their
 * finished tasks but charge 0 until they settle.
 */
export async function usageByMonth(
  db: Db | Tx,
  orgId: string,
  from: Date,
  to: Date,
): Promise<UsageMonth[]> {
  const runs = await db
    .select({
      id: gridRuns.id,
      byo: gridRuns.byo,
      driverId: gridRuns.driverId,
      speed: gridRuns.speed,
      createdAt: gridRuns.createdAt,
      charged: gridRuns.costChargedUsd,
    })
    .from(gridRuns)
    .where(
      and(eq(gridRuns.orgId, orgId), gte(gridRuns.createdAt, from), lt(gridRuns.createdAt, to)),
    );
  const counts = await db
    .select({
      runId: gridTasks.runId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`(count(*) filter (where ${gridTasks.status} = 'done'))::int`,
    })
    .from(gridTasks)
    .innerJoin(gridRuns, eq(gridRuns.id, gridTasks.runId))
    .where(
      and(eq(gridRuns.orgId, orgId), gte(gridRuns.createdAt, from), lt(gridRuns.createdAt, to)),
    )
    .groupBy(gridTasks.runId);
  const byRun = new Map(counts.map((c) => [c.runId, c]));

  const months = new Map<string, UsageMonth>();
  for (const r of runs) {
    const month = r.createdAt.toISOString().slice(0, 7);
    const m = months.get(month) ?? { month, byo: empty(), resold: empty(), total: empty() };
    months.set(month, m);
    const c = byRun.get(r.id);
    const add = (b: UsageBucket) => {
      b.runs += 1;
      b.points += c?.total ?? 0;
      b.tasks += c?.done ?? 0;
      b.costAtDataforseoUsd += (c?.done ?? 0) * taskPriceUsd(r.driverId, r.speed);
      b.chargedUsd += Number(r.charged ?? 0);
    };
    add(r.byo ? m.byo : m.resold);
    add(m.total);
  }
  const out = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const m of out) {
    for (const b of [m.byo, m.resold, m.total]) {
      b.costAtDataforseoUsd = round4(b.costAtDataforseoUsd);
      b.chargedUsd = round4(b.chargedUsd);
    }
  }
  return out;
}
