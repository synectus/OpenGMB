import { and, eq, gte, lt, sql } from "drizzle-orm";
import { aiVisibilityRuns, competitorProfileTasks, gridRuns, orgGridSettings, platformDfsSpend, type Db, type Tx } from "@opengmb/db";
import { meteredMarkupPercent } from "../billing";
import { platformLimit } from "../limits/platform-limits";
import { DEFAULT_GRID_SPEED, GEOGRID_DEFAULTS, taskPriceUsd, type GEOGRID_PRICING, type GridSpeed } from "../config/geogrid";
import { CoreError } from "../errors";

export type GridDriverId = keyof typeof GEOGRID_PRICING;

/** Typed FORBIDDEN: starting this run would push the org over its monthly geo-grid budget. */
export class BudgetExceededError extends CoreError {
  constructor(
    public readonly estimateUsd: number,
    public readonly remainingUsd: number,
  ) {
    super(
      "FORBIDDEN",
      `BUDGET_EXCEEDED: this run is estimated at $${estimateUsd.toFixed(4)} but only $${Math.max(0, remainingUsd).toFixed(4)} is left of the monthly geo-grid budget`,
    );
    this.name = "BudgetExceededError";
  }
}

/** Typed FORBIDDEN: starting this run would push the platform's DataForSEO spend over its daily cap. */
export class PlatformCapExceededError extends CoreError {
  constructor(
    public readonly estimateUsd: number,
    public readonly remainingUsd: number,
  ) {
    super(
      "FORBIDDEN",
      `PLATFORM_CAP_EXCEEDED: rank scans are paused for today across the service ($${Math.max(0, remainingUsd).toFixed(4)} of the daily limit is left and this run needs $${estimateUsd.toFixed(4)}). They resume at 00:00 UTC.`,
    );
    this.name = "PlatformCapExceededError";
  }
}

/** Round up to 4 decimals (never undercharge), ignoring float noise below 1e-8. */
export function roundUpUsd(n: number): number {
  return Math.ceil(Math.round(n * 1e6) / 100) / 1e4;
}

/** points x keywords x driver price x (1 + markup). */
export function estimateCostUsd(p: {
  driverId: GridDriverId;
  points: number;
  keywordCount: number;
  markupPercent: number;
  speed?: GridSpeed;
}): number {
  const unit = taskPriceUsd(p.driverId, p.speed ?? DEFAULT_GRID_SPEED);
  return roundUpUsd(p.points * p.keywordCount * unit * (1 + p.markupPercent / 100));
}

export type GridBilling = { monthlyBudgetUsd: number; markupPercent: number; defaultSpeed: GridSpeed; defaultCompetitorRefresh: "manual" | "weekly"; isDefault: boolean };

export async function getGridBilling(db: Db | Tx, orgId: string): Promise<GridBilling> {
  const stored = await readGridBilling(db, orgId);
  // Hosted: the ledger charges cost plus the plan's one markup, so an owner-edited markup cannot lower it.
  const hosted = meteredMarkupPercent();
  return hosted === null ? stored : { ...stored, markupPercent: hosted };
}

async function readGridBilling(db: Db | Tx, orgId: string): Promise<GridBilling> {
  const [row] = await db.select().from(orgGridSettings).where(eq(orgGridSettings.orgId, orgId));
  if (!row) {
    return {
      monthlyBudgetUsd: GEOGRID_DEFAULTS.monthlyBudgetUsd,
      markupPercent: GEOGRID_DEFAULTS.markupPercent,
      defaultSpeed: DEFAULT_GRID_SPEED,
      defaultCompetitorRefresh: "manual",
      isDefault: true,
    };
  }
  return {
    monthlyBudgetUsd: Number(row.monthlyBudgetUsd),
    markupPercent: Number(row.markupPercent),
    defaultSpeed: row.defaultSpeed,
    defaultCompetitorRefresh: row.defaultCompetitorRefresh,
    isDefault: false,
  };
}

/** [start, end) of the UTC calendar month containing `now`. */
export function monthBounds(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/**
 * Resold spend this UTC month (BYO runs excluded): the charged cost of settled runs, plus the ESTIMATE of runs still queued or
 * running (reserved so concurrent runs cannot jointly overshoot). A failed run counts what it was charged.
 */
export async function monthToDateUsd(db: Db | Tx, orgId: string, now: Date): Promise<number> {
  const { start, end } = monthBounds(now);
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(case when ${gridRuns.status} in ('queued','running') then ${gridRuns.costEstimateUsd} else coalesce(${gridRuns.costChargedUsd}, 0) end), 0)`,
    })
    .from(gridRuns)
    .where(
      and(
        eq(gridRuns.orgId, orgId),
        // BYO runs are paid by the customer's own DataForSEO account: not resold spend, not capped.
        eq(gridRuns.byo, false),
        // Fixture and sandbox runs are not real spend (their stored costs are 0 anyway).
        eq(gridRuns.dataSource, "live"),
        gte(gridRuns.createdAt, start),
        lt(gridRuns.createdAt, end),
      ),
    );
  // K2 part 2: competitor profile refreshes are charged to the same monthly budget, at submit time.
  const [profiles] = await db
    .select({ total: sql<string>`coalesce(sum(${competitorProfileTasks.chargedUsd}), 0)` })
    .from(competitorProfileTasks)
    .where(
      and(
        eq(competitorProfileTasks.orgId, orgId),
        eq(competitorProfileTasks.dataSource, "live"),
        gte(competitorProfileTasks.createdAt, start),
        lt(competitorProfileTasks.createdAt, end),
      ),
    );
  // K5: AI search visibility checks are charged to the same monthly budget, when the check is stored.
  const [ai] = await db
    .select({ total: sql<string>`coalesce(sum(${aiVisibilityRuns.chargedUsd}), 0)` })
    .from(aiVisibilityRuns)
    .where(and(eq(aiVisibilityRuns.orgId, orgId), eq(aiVisibilityRuns.dataSource, "live"), gte(aiVisibilityRuns.createdAt, start), lt(aiVisibilityRuns.createdAt, end)));
  return Number(row?.total ?? 0) + Number(profiles?.total ?? 0) + Number(ai?.total ?? 0);
}

/** Throws BudgetExceededError when `estimateUsd` does not fit in what is left this month. */
export async function assertWithinBudget(
  db: Db | Tx,
  orgId: string,
  estimateUsd: number,
  now: Date,
): Promise<void> {
  const billing = await getGridBilling(db, orgId);
  const spent = await monthToDateUsd(db, orgId, now);
  const remaining = billing.monthlyBudgetUsd - spent;
  if (estimateUsd > remaining + 1e-9) throw new BudgetExceededError(estimateUsd, remaining);
}

/** [start, end) of the UTC day containing `now`. */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * DataForSEO spend on OUR key this UTC day, all orgs: what the provider reported for submitted
 * runs, else the estimate for runs not submitted yet. BYO, fixture and sandbox runs are excluded.
 */
export async function platformDayToDateUsd(db: Db | Tx, now: Date): Promise<number> {
  const { start, end } = utcDayBounds(now);
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(coalesce(${gridRuns.providerCostUsd}, ${gridRuns.providerEstimateUsd})), 0)`,
    })
    .from(gridRuns)
    .where(
      and(
        eq(gridRuns.byo, false),
        eq(gridRuns.dataSource, "live"),
        gte(gridRuns.createdAt, start),
        lt(gridRuns.createdAt, end),
      ),
    );
  // One-off lookups on our key (such as a location's coordinates) count against the same cap.
  const [other] = await db
    .select({ total: sql<string>`coalesce(sum(${platformDfsSpend.costUsd}), 0)` })
    .from(platformDfsSpend)
    .where(and(gte(platformDfsSpend.createdAt, start), lt(platformDfsSpend.createdAt, end)));
  return Number(row?.total ?? 0) + Number(other?.total ?? 0);
}

/**
 * Throws PlatformCapExceededError when `providerEstimateUsd` does not fit in today's cap. Takes an
 * advisory lock first so concurrent requests from different orgs cannot jointly overshoot; the lock
 * lasts until the caller's transaction ends.
 */
export async function assertWithinPlatformCap(tx: Tx, providerEstimateUsd: number, now: Date): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('geogrid.platform_cap'))`);
  const remaining = (await platformLimit(tx, "dfs_daily_cap_usd")) - (await platformDayToDateUsd(tx, now));
  if (providerEstimateUsd > remaining + 1e-9) {
    throw new PlatformCapExceededError(providerEstimateUsd, remaining);
  }
}
