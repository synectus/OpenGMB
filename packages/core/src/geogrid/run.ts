import { useAccountDaily } from "../limits/counters";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { gridCompetitorSnapshots, gridConfigs, gridPoints, gridRuns, gridTasks, type Db, type Tx } from "@opengmb/db";
import { usdToMicro } from "../ai/money";
import { assertCredit, debit, CreditExhaustedError } from "../billing";
import { deferBlockedJob, deferIfBlocked, enqueueJob } from "../jobs";
import { isOrgBlocked, orgIsActive } from "../account-state";
import { hasByoKey, loadByoCredentials } from "./byo";
import type { ActionAuditEntry } from "../registry";
import { workerAudit } from "../reviews/reply-state";
import { sendAlert } from "../monitoring/alert";
import { notifyBudgetExceeded } from "./budget-alert";
import {
  assertWithinBudget,
  assertWithinPlatformCap,
  BudgetExceededError,
  PlatformCapExceededError,
  estimateCostUsd,
  getGridBilling,
  roundUpUsd,
} from "./cost";
import { taskPriceUsd, type GridSpeed } from "../config/geogrid";
import {
  DfsAccountError,
  DfsNotReadyError,
  resolvePointResult,
  type DriverRegistry,
  type GridDriver,
  type SubmitResult,
} from "./drivers";
import { buildGrid } from "./math";
import { isDue } from "./schedule";
import { snapshotRowsFromPoints } from "./competitor-snapshots";
import type { Competitor } from "./analytics";

export const GRID_RUN_QUEUE = "geogrid.run";
export const GRID_COLLECT_QUEUE = "geogrid.collect";
export const GRID_SCHEDULE_QUEUE = "geogrid.schedule";
/** Daily at 05:00 UTC. Which configs are due is decided by their own schedule, not by this cron. */
export const GRID_SCHEDULE_CRON = "0 5 * * *";
export const GRID_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 30, retryBackoff: true } as const;

type DataSource = (typeof gridRuns.$inferSelect)["dataSource"];
type ConfigRow = typeof gridConfigs.$inferSelect;
type Audit = (entry: ActionAuditEntry) => Promise<void>;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time comparison of a presented token against the stored sha256 hash. */
export function tokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The drivers that spend money on DataForSEO (Maps rank and keyword rank). */
const isDfsDriver = (id: ConfigRow["driverId"]) => id === "dataforseo_standard" || id === "dataforseo_serp";

/** A keyword-rank config checks one Google search from the location, not a grid of points. */
const configGrid = (config: ConfigRow) =>
  config.kind === "keyword_rank"
    ? [{ row: 0, col: 0, lat: config.centerLat, lng: config.centerLng }]
    : buildGrid({ lat: config.centerLat, lng: config.centerLng, size: config.gridSize, radiusM: config.radiusM });

export function pointCount(config: Pick<ConfigRow, "gridSize">): number {
  return config.gridSize * config.gridSize;
}

/**
 * Create one queued run per keyword and enqueue each, inside the caller's transaction. Checks the
 * org's monthly budget against the total estimate first (BudgetExceededError, nothing written).
 */
export async function requestGridRuns(
  tx: Tx,
  p: {
    config: ConfigRow;
    requestedBy: string | null;
    audit: Audit;
    drivers: DriverRegistry;
    now?: Date;
    /** Queue speed for these runs; default is the org's default speed (what scheduled runs always use). */
    speed?: GridSpeed;
  },
): Promise<{ runId: string; keyword: string; costEstimateUsd: number }[]> {
  const { config } = p;
  const billing = await getGridBilling(tx, config.orgId);
  // BYO: the org's own DataForSEO key pays for the tasks, so we bill at cost (no markup) and the
  // run does not count against, nor get blocked by, the monthly cap on resold spend.
  const byo = isDfsDriver(config.driverId) && (await hasByoKey(tx, config.orgId));
  const markupPercent = byo ? 0 : billing.markupPercent;
  const speed = p.speed ?? billing.defaultSpeed;
  const perRun = estimateCostUsd({
    speed,
    driverId: config.driverId,
    points: pointCount(config),
    keywordCount: 1,
    markupPercent,
  });
  const total = estimateCostUsd({
    speed,
    driverId: config.driverId,
    points: pointCount(config),
    keywordCount: config.keywords.length,
    markupPercent,
  });
  const now = p.now ?? new Date();
  // The Places relevance check costs nothing, so no budget stops it: a daily cap per account keeps one
  // account from using up the shared Places quota. Scheduled runs (no requester) are not counted.
  if (config.driverId === "places_relevance" && p.requestedBy) {
    await useAccountDaily(tx, config.orgId, "relevance_points", pointCount(config) * config.keywords.length, now);
  }
  // The org budget is checked for every non-BYO request (a fixture request is a dry run of it).
  if (!byo) await assertWithinBudget(tx, config.orgId, total, now);
  // Snapshot where this run's data comes from. Collect always uses the run's own source.
  const dataSource = p.drivers.dataSource(config.driverId);
  const live = dataSource === "live";
  const providerPerRun = roundUpUsd(pointCount(config) * taskPriceUsd(config.driverId, speed));
  // Our key pays: the platform's daily cap applies. BYO, fixture and sandbox runs spend none of it.
  if (live && !byo && isDfsDriver(config.driverId)) {
    await assertWithinPlatformCap(tx, providerPerRun * config.keywords.length, now);
  }
  // Hosted billing: the balance (minus scans already queued) must cover the whole estimate. Only live,
  // non-BYO runs cost anything; fixture and sandbox runs are never credit-checked. Grid runs take only the org lock.
  if (live && !byo) await assertCredit(tx, config.orgId, usdToMicro(total), now);
  const driver = p.drivers(config.driverId, { speed });
  const out = [];
  for (const keyword of config.keywords) {
    const [run] = await tx
      .insert(gridRuns)
      .values({
        orgId: config.orgId,
        configId: config.id,
        keyword,
        driverId: config.driverId,
        byo,
        speed,
        dataSource,
        // Fake (fixture or sandbox) runs cost nothing anywhere: usage and invoices never show them.
        costEstimateUsd: (live ? perRun : 0).toFixed(4),
        providerEstimateUsd: (live && !byo ? providerPerRun : 0).toFixed(4),
        requestedBy: p.requestedBy,
      })
      .returning({ id: gridRuns.id });
    const jobId = await enqueueJob(tx, GRID_RUN_QUEUE, { runId: run!.id });
    await p.audit({
      action: "geogrid.run_requested",
      entityType: "grid_run",
      entityId: run!.id,
      before: null,
      after: {
        configId: config.id,
        keyword,
        driverId: driver.id,
        isMapsRank: driver.isMapsRank,
        byo,
        speed,
        dataSource,
        costEstimateUsd: perRun,
        jobId,
      },
    });
    out.push({ runId: run!.id, keyword, costEstimateUsd: perRun });
  }
  return out;
}

type RunDeps = {
  drivers: DriverRegistry;
  /** Public base URL of the worker (WORKER_PUBLIC_URL); needed to build pingback URLs. */
  pingbackBaseUrl: string | undefined;
  /** Platform alert (default: sendAlert). Called once per run when OUR DataForSEO account refuses. */
  alert?: (subject: string, text: string) => Promise<unknown>;
};

/**
 * The driver a run uses. A BYO run (decided when it was requested) gets the org's decrypted
 * credentials; if the key was deleted since, it fails rather than silently spending OUR key on a
 * run billed as the customer's own.
 */
async function driverForRun(
  db: Db,
  drivers: DriverRegistry,
  run: { orgId: string; driverId: string; byo: boolean; dataSource: DataSource; speed: GridSpeed },
): Promise<GridDriver> {
  // The run's own data source, never the current one: a run is collected from where it was submitted.
  if (!run.byo) return drivers(run.driverId, { dataSource: run.dataSource, speed: run.speed });
  const credentials = await loadByoCredentials(db, run.orgId);
  if (!credentials)
    throw new Error("byo_key_missing: the DataForSEO key was removed after this run was requested");
  return drivers(run.driverId, { credentials, dataSource: run.dataSource, speed: run.speed });
}

async function failRun(tx: Tx, orgId: string, runId: string, error: string) {
  await tx
    .update(gridTasks)
    .set({ status: "failed", error })
    .where(and(eq(gridTasks.runId, runId), inArray(gridTasks.status, ["pending", "submitted"])));
  await tx
    .update(gridRuns)
    .set({
      status: "failed",
      error,
      costChargedUsd: "0.0000",
      // A run that failed with nothing bought cost nothing; do not keep counting its estimate toward the cap.
      providerCostUsd: sql`coalesce(${gridRuns.providerCostUsd}, 0)`,
      finishedAt: new Date(),
    })
    .where(eq(gridRuns.id, runId));
  await workerAudit(
    tx,
    orgId,
  )({
    action: "geogrid.run_finished",
    entityType: "grid_run",
    entityId: runId,
    before: null,
    after: { status: "failed", error, costChargedUsd: 0 },
  });
}

/** If every task of the run has settled, finish the run and record what was charged. */
export async function finalizeRunIfSettled(tx: Tx, runId: string): Promise<boolean> {
  const tasks = await tx
    .select({ status: gridTasks.status })
    .from(gridTasks)
    .where(eq(gridTasks.runId, runId));
  if (tasks.length === 0 || tasks.some((t) => t.status !== "done" && t.status !== "failed")) {
    return false;
  }
  const done = tasks.filter((t) => t.status === "done").length;
  const [run] = await tx.select().from(gridRuns).where(eq(gridRuns.id, runId));
  if (!run || run.status !== "running") return false;
  const status = done > 0 ? "done" : "failed";
  const charged = roundUpUsd((Number(run.costEstimateUsd) * done) / tasks.length);
  await tx
    .update(gridRuns)
    .set({
      status,
      costChargedUsd: charged.toFixed(4),
      finishedAt: new Date(),
      ...(status === "failed" ? { error: "No point could be collected" } : {}),
    })
    .where(eq(gridRuns.id, runId));
  await workerAudit(
    tx,
    run.orgId,
  )({
    action: "geogrid.run_finished",
    entityType: "grid_run",
    entityId: runId,
    before: null,
    after: { status, pointsCollected: done, pointsTotal: tasks.length, costChargedUsd: charged },
  });
  if (status === "done") await writeCompetitorSnapshot(tx, run);
  // Ids and numbers only: no credentials, and no keyword (it can be client data).
  console.log(
    `[geogrid] run ${runId} finished status=${status} collected=${done}/${tasks.length} provider_cost_usd=${Number(run.providerCostUsd ?? 0).toFixed(4)} charged_usd=${charged.toFixed(4)}`,
  );
  // Fixture and sandbox runs are never debited (their charge is 0 anyway); BYO is paid by the customer's own key.
  if (!run.byo && run.dataSource === "live") {
    // The run leaves "running" in the update above, so this settles exactly once; debit is also idempotent by run id.
    const d = await debit(tx, { orgId: run.orgId, reason: "scan", refId: run.id, microUsd: usdToMicro(charged), now: new Date() });
    if (d.shortfallMicro > 0) console.error(`[billing] scan shortfall org=${run.orgId} run=${run.id} micro=${d.shortfallMicro}`);
  }
  return true;
}

/**
 * K2: store the competitors of a finished tracker run, one row per business for the run's day (UTC).
 * Quick scans and keyword-rank runs are skipped. A second run the same day replaces the day's rows,
 * so the latest run of the day is the snapshot.
 */
export async function writeCompetitorSnapshot(tx: Tx, run: typeof gridRuns.$inferSelect): Promise<number> {
  const [config] = await tx.select().from(gridConfigs).where(eq(gridConfigs.id, run.configId));
  if (!config || config.kind !== "tracker" || !config.locationId) return 0;
  const points = await tx.select({ competitors: gridPoints.competitors }).from(gridPoints).where(eq(gridPoints.runId, run.id));
  const rows = snapshotRowsFromPoints(points.map((p) => ({ competitors: p.competitors as Competitor[] })));
  const snapshotDate = new Date().toISOString().slice(0, 10);
  // The run is the latest of the day: drop the day's earlier rows (including businesses this run no longer saw).
  await tx
    .delete(gridCompetitorSnapshots)
    .where(
      and(
        eq(gridCompetitorSnapshots.configId, run.configId),
        eq(gridCompetitorSnapshots.keyword, run.keyword),
        eq(gridCompetitorSnapshots.snapshotDate, snapshotDate),
        eq(gridCompetitorSnapshots.dataSource, run.dataSource),
      ),
    );
  if (rows.length === 0) return 0;
  await tx.insert(gridCompetitorSnapshots).values(
    rows.map((r) => ({
      orgId: run.orgId,
      configId: run.configId,
      locationId: config.locationId!,
      runId: run.id,
      keyword: run.keyword,
      placeId: r.placeId,
      title: r.title,
      address: r.address,
      snapshotDate,
      dataSource: run.dataSource,
      appearances: r.appearances,
      avgRank: r.averageRank.toFixed(2),
      bestRank: r.bestRank,
      rating: r.rating === null ? null : r.rating.toFixed(1),
      reviewCount: r.reviewCount,
      category: r.category ?? null,
      additionalCategories: r.additionalCategories ?? null,
      categoryIds: r.categoryIds ?? null,
    })),
  );
  return rows.length;
}

async function applyResult(
  tx: Tx,
  task: { id: string; orgId: string; runId: string; row: number; col: number },
  result: ReturnType<typeof resolvePointResult>,
) {
  await tx
    .update(gridPoints)
    .set({
      rank: result.rank,
      top3: result.top3,
      competitors: result.competitors,
      ...(result.organicRank !== undefined
        ? { organicRank: result.organicRank, organicUrl: result.organicUrl ?? null }
        : {}),
    })
    .where(
      and(
        eq(gridPoints.runId, task.runId),
        eq(gridPoints.row, task.row),
        eq(gridPoints.col, task.col),
      ),
    );
  await tx.update(gridTasks).set({ status: "done" }).where(eq(gridTasks.id, task.id));
}

/**
 * Worker side of `geogrid.run`. Phase 1 (tx): queued -> running, points and per-task secrets
 * created. Phase 2 (no tx): driver.submit, which talks to the provider. Phase 3 (tx): tasks marked
 * submitted; "immediate" drivers are collected and the run finished here, "pingback" drivers wait
 * for the webhook. A submit failure fails the run and charges nothing (no retry: re-submitting
 * could buy the same tasks twice). Re-running a run that is not queued does nothing.
 */
export async function processGridRun(
  db: Db,
  runId: string,
  deps: RunDeps,
): Promise<"skipped" | "failed" | "running" | "done"> {
  const plan = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(gridRuns).where(eq(gridRuns.id, runId)).for("update");
    if (!run || run.status !== "queued") return null;
    // AP3b: suspended or deleted. The run stays `queued`; the job is re-queued for later.
    if (await isOrgBlocked(tx, run.orgId)) {
      await deferBlockedJob(tx, GRID_RUN_QUEUE, { runId }, run.orgId);
      return null;
    }
    const [config] = await tx.select().from(gridConfigs).where(eq(gridConfigs.id, run.configId));
    if (!config) return null;
    await tx
      .update(gridRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(gridRuns.id, runId));
    const grid = configGrid(config);
    const tokens = new Map<string, string>();
    await tx.insert(gridPoints).values(
      grid.map((g) => ({
        runId,
        orgId: run.orgId,
        row: g.row,
        col: g.col,
        lat: g.lat,
        lng: g.lng,
      })),
    );
    for (const g of grid) tokens.set(`${g.row}:${g.col}`, randomBytes(32).toString("hex"));
    await tx.insert(gridTasks).values(
      grid.map((g) => ({
        orgId: run.orgId,
        runId,
        row: g.row,
        col: g.col,
        tokenHash: sha256(tokens.get(`${g.row}:${g.col}`)!),
      })),
    );
    return { run, config, grid, tokens };
  });
  if (!plan) return "skipped";
  const { run, config, grid, tokens } = plan;

  let driver: GridDriver;
  try {
    driver = await driverForRun(db, deps.drivers, run);
  } catch (e) {
    await db.transaction((tx) =>
      failRun(tx, run.orgId, runId, `submit_failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return "failed";
  }
  const target = { name: config.targetName, placeId: config.targetPlaceId, domain: config.targetDomain };
  const alert = deps.alert ?? sendAlert;
  // OUR account refusing is ours to fix; a customer's own (BYO) account is theirs, shown in the run error.
  const alertAccount = async (code: number, message: string) => {
    if (run.byo) return;
    await alert(
      `Geo-grid: DataForSEO refused our account (${code})`,
      `Run ${runId} could not be submitted: ${message}. Rank scans on our DataForSEO key will keep failing until this is fixed (check the balance, the daily cost limit and the IP whitelist in the DataForSEO dashboard).`,
    ).catch((e) => console.error("[geogrid] alert failed", e));
  };

  let submitted: SubmitResult;
  try {
    if (driver.completion === "pingback" && !deps.pingbackBaseUrl) {
      throw new Error("WORKER_PUBLIC_URL is not set; cannot build pingback URLs");
    }
    submitted = await driver.submit(
      grid.map((g) => ({
        ...g,
        pingbackUrl:
          driver.completion === "pingback"
            ? `${deps.pingbackBaseUrl!.replace(/\/$/, "")}/webhooks/dataforseo?id=$id&token=${tokens.get(`${g.row}:${g.col}`)}`
            : null,
      })),
      run.keyword,
      target,
    );
  } catch (e) {
    if (e instanceof DfsAccountError) await alertAccount(e.code, e.message);
    await db.transaction((tx) =>
      failRun(tx, run.orgId, runId, `submit_failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return "failed";
  }
  const { refs, failed } = submitted;
  if (submitted.accountError) await alertAccount(submitted.accountError.code, submitted.accountError.message);
  if (refs.length === 0) {
    // Nothing was bought, so nothing is charged.
    await db.transaction((tx) =>
      failRun(tx, run.orgId, runId, `submit_failed: ${failed[0]?.error ?? "no task was created"}`),
    );
    return "failed";
  }

  // Immediate drivers answer now; collect before opening the transaction.
  const collected =
    driver.completion === "immediate"
      ? await Promise.all(refs.map(async (r) => ({ r, res: await driver.collect(r) })))
      : [];

  return db.transaction(async (tx) => {
    const now = new Date();
    for (const r of refs) {
      await tx
        .update(gridTasks)
        .set({ taskRef: r.ref, status: "submitted", submittedAt: now })
        .where(and(eq(gridTasks.runId, runId), eq(gridTasks.row, r.row), eq(gridTasks.col, r.col)));
    }
    // Points the provider did not accept: failed now, so the run can still settle on the rest.
    for (const f of failed) {
      await tx
        .update(gridTasks)
        .set({ status: "failed", error: f.error.slice(0, 500) })
        .where(and(eq(gridTasks.runId, runId), eq(gridTasks.row, f.row), eq(gridTasks.col, f.col)));
    }
    await tx
      .update(gridRuns)
      .set({ providerCostUsd: submitted.providerCostUsd.toFixed(4) })
      .where(eq(gridRuns.id, runId));
    console.log(
      `[geogrid] run ${runId} submitted source=${run.dataSource} points=${grid.length} tasks_created=${refs.length} provider_cost_usd=${submitted.providerCostUsd.toFixed(4)} estimate_usd=${Number(run.costEstimateUsd).toFixed(4)}`,
    );
    for (const { r, res } of collected) {
      const [task] = await tx
        .select()
        .from(gridTasks)
        .where(and(eq(gridTasks.runId, runId), eq(gridTasks.row, r.row), eq(gridTasks.col, r.col)));
      await applyResult(tx, task!, resolvePointResult(res, target));
    }
    if (collected.length > 0) {
      await finalizeRunIfSettled(tx, runId);
      return "done" as const;
    }
    return "running" as const;
  });
}

export type PingbackOutcome = "accepted" | "duplicate" | "unauthorized";

/**
 * DataForSEO pingback. Unknown task id and wrong token are indistinguishable (unauthorized). The
 * first valid delivery marks the task received and enqueues its collect job in the same
 * transaction; any later delivery is a no-op duplicate.
 */
export async function acceptPingback(
  db: Db,
  p: { taskRef: string; token: string },
): Promise<PingbackOutcome> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(gridTasks)
      .where(eq(gridTasks.taskRef, p.taskRef))
      .for("update");
    if (!task || !tokenMatches(p.token, task.tokenHash)) return "unauthorized";
    if (task.status !== "submitted") return "duplicate";
    await markReceivedAndCollect(tx, task.id);
    return "accepted";
  });
}

/** A submitted task is ready to fetch (pingback arrived, or the sweeper found it stale): mark it and queue its collect job. */
export async function markReceivedAndCollect(tx: Tx, taskId: string): Promise<void> {
  await tx
    .update(gridTasks)
    .set({ status: "received", receivedAt: new Date() })
    .where(eq(gridTasks.id, taskId));
  await enqueueJob(tx, GRID_COLLECT_QUEUE, { taskId });
}

/** Worker side of `geogrid.collect`: fetch one point's results and store them. */
export async function processGridCollect(
  db: Db,
  taskId: string,
  deps: { drivers: DriverRegistry; isFinalAttempt?: boolean },
): Promise<"skipped" | "done" | "failed" | "not_ready"> {
  const loaded = await db
    .select({ task: gridTasks, run: gridRuns, config: gridConfigs })
    .from(gridTasks)
    .innerJoin(gridRuns, eq(gridRuns.id, gridTasks.runId))
    .innerJoin(gridConfigs, eq(gridConfigs.id, gridRuns.configId))
    .where(eq(gridTasks.id, taskId));
  const row = loaded[0];
  if (!row || row.task.status !== "received" || !row.task.taskRef) return "skipped";
  const { task, run, config } = row;
  // AP3b: suspended or deleted. The task stays `received`; the job is re-queued for later.
  if (await deferIfBlocked(db, run.orgId, GRID_COLLECT_QUEUE, { taskId })) return "skipped";
  const driver = await driverForRun(db, deps.drivers, run);
  const target = { name: config.targetName, placeId: config.targetPlaceId, domain: config.targetDomain };

  let results;
  try {
    results = await driver.collect({ row: task.row, col: task.col, ref: task.taskRef! });
  } catch (e) {
    if (e instanceof DfsNotReadyError) {
      // Not a failure and not a retry: back to "submitted" so the sweeper (or a late pingback) tries again.
      await db
        .update(gridTasks)
        .set({ status: "submitted" })
        .where(and(eq(gridTasks.id, task.id), eq(gridTasks.status, "received")));
      return "not_ready";
    }
    if (!deps.isFinalAttempt) throw e; // pg-boss retries
    const msg = `collect_failed: ${e instanceof Error ? e.message : String(e)}`;
    await db.transaction(async (tx) => {
      await tx
        .update(gridTasks)
        .set({ status: "failed", error: msg })
        .where(eq(gridTasks.id, task.id));
      await finalizeRunIfSettled(tx, run.id);
    });
    return "failed";
  }
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .select()
      .from(gridTasks)
      .where(eq(gridTasks.id, task.id))
      .for("update");
    if (!fresh || fresh.status !== "received") return "skipped" as const;
    await applyResult(tx, task, resolvePointResult(results, target));
    await finalizeRunIfSettled(tx, run.id);
    return "done" as const;
  });
}

/**
 * Daily schedule job: enqueue a run for every active, non-manual config that is due. A config over
 * budget is skipped (audited) and still marked as scheduled, so it retries next period rather than
 * every day. `orgIds` restricts the run to those orgs (tests only; production runs every org).
 */
export async function enqueueDueGridRuns(
  db: Db,
  deps: { drivers: DriverRegistry; now?: Date; orgIds?: string[]; alert?: (subject: string, text: string) => Promise<unknown> },
): Promise<{ checked: number; enqueued: number; skippedBudget: number }> {
  const now = deps.now ?? new Date();
  const candidates = await db
    .select({ id: gridConfigs.id })
    .from(gridConfigs)
    .where(
      and(
        eq(gridConfigs.active, true),
        ne(gridConfigs.schedule, "manual"),
        deps.orgIds ? inArray(gridConfigs.orgId, deps.orgIds) : undefined,
        orgIsActive(gridConfigs.orgId),
      ),
    );
  let enqueued = 0;
  let skippedBudget = 0;
  for (const { id } of candidates) {
    await db.transaction(async (tx) => {
      const [config] = await tx
        .select()
        .from(gridConfigs)
        .where(eq(gridConfigs.id, id))
        .for("update");
      if (!config || !config.active || !isDue(config.schedule, config.lastScheduledAt, now)) return;
      await tx.update(gridConfigs).set({ lastScheduledAt: now }).where(eq(gridConfigs.id, id));
      const audit = workerAudit(tx, config.orgId);
      try {
        await requestGridRuns(tx, { config, requestedBy: null, audit, drivers: deps.drivers, now });
        enqueued++;
      } catch (e) {
        const noCredit = e instanceof CreditExhaustedError;
        if (!(e instanceof BudgetExceededError) && !(e instanceof PlatformCapExceededError) && !noCredit) throw e;
        skippedBudget++;
        const scope = e instanceof PlatformCapExceededError ? "platform" : "org";
        await audit({
          action: "geogrid.schedule_skipped",
          entityType: "grid_config",
          entityId: id,
          before: null,
          after: {
            reason: noCredit ? "credit_exhausted" : scope === "platform" ? "platform_cap_exceeded" : "budget_exceeded",
            message: e.message,
          },
        });
        // A spent credit balance is not a budget breach: no budget alert for it.
        if (!noCredit) await notifyBudgetExceeded(tx, { orgId: config.orgId, scope, now, alert: deps.alert });
      }
    });
  }
  return { checked: candidates.length, enqueued, skippedBudget };
}
