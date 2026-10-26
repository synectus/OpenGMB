import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { competitorProfiles, competitorProfileTasks, gridConfigs, gridPoints, gridRuns, locations, platformDfsSpend, type Db } from "@opengmb/db";
import { usdToMicro } from "../ai/money";
import { CreditExhaustedError, assertCredit, debit } from "../billing";
import { dfsLocationCodeFor } from "../config/dfs-locations";
import { locationRegionCode } from "../locations/center";
import { COMPETITOR_PROFILES, PROFILE_PROVIDER_USD } from "../config/competitor-profiles";
import { competitorTable, type Competitor } from "../geogrid/analytics";
import { notifyBudgetExceeded } from "../geogrid/budget-alert";
import {
  BudgetExceededError,
  PlatformCapExceededError,
  assertWithinBudget,
  assertWithinPlatformCap,
  getGridBilling,
  roundUpUsd,
} from "../geogrid/cost";
import { DfsAccountError } from "../geogrid/drivers/errors";
import { rankSource, type RankSource } from "../geogrid/drivers/source";
import { isDue } from "../geogrid/schedule";
import { sendAlert } from "../monitoring/alert";
import { workerAudit } from "../reviews/reply-state";
import {
  fixtureProfileTransport,
  liveProfileTransport,
  parseInfoItem,
  parseUpdatesResult,
  refreshCostUsd,
  selectTopCompetitors,
  type PostedTask,
  type ProfileKind,
  type ProfileTransport,
} from "./profiles";
import { orgIsActive } from "../account-state";

export const COMPETITOR_REFRESH_QUEUE = "competitors.profiles_refresh";
export const COMPETITOR_REFRESH_CRON = "30 5 * * *";
export const COMPETITOR_COLLECT_QUEUE = "competitors.profiles_collect";
export const COMPETITOR_COLLECT_CRON = "*/10 * * * *";

/** A place fetched within this window (by any of the org's trackers) is not fetched again. */
const DEDUPE_MS = 24 * 3_600_000;
const KINDS: readonly ProfileKind[] = ["info", "updates"];

export type RefreshDeps = {
  source?: RankSource;
  transport?: ProfileTransport;
  now?: Date;
  /** Tests only; production refreshes every org. */
  orgIds?: string[];
  alert?: (subject: string, text: string) => Promise<unknown>;
};

export type RefreshOutcome =
  | { outcome: "submitted"; requested: number; skippedNoPlaceId: number; chargedUsd: number }
  | { outcome: "nothing_to_fetch"; skippedNoPlaceId: number }
  | { outcome: "no_scan_data" | "skipped_limit" | "not_due" | "failed" };

const day = (d: Date) => d.toISOString().slice(0, 10);

function transportFor(source: RankSource, deps: RefreshDeps): ProfileTransport {
  return deps.transport ?? (source === "fixture" ? fixtureProfileTransport() : liveProfileTransport());
}

async function regionOfTracker(db: Db, orgId: string, locationId: string): Promise<string | null> {
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.orgId, orgId)));
  return loc ? locationRegionCode(db, loc) : null;
}

/** The competitors of the tracker's latest finished run per keyword, for the given data source. */
async function topFor(db: Db, config: typeof gridConfigs.$inferSelect, source: RankSource) {
  const runs = await db
    .select({ id: gridRuns.id, keyword: gridRuns.keyword })
    .from(gridRuns)
    .where(and(eq(gridRuns.configId, config.id), eq(gridRuns.status, "done"), eq(gridRuns.dataSource, source)))
    .orderBy(desc(gridRuns.createdAt));
  const latest = new Map<string, string>();
  for (const r of runs) if (!latest.has(r.keyword)) latest.set(r.keyword, r.id);
  if (latest.size === 0) return null;
  const points = await db
    .select({ runId: gridPoints.runId, competitors: gridPoints.competitors })
    .from(gridPoints)
    .where(inArray(gridPoints.runId, [...latest.values()]));
  const perKeyword = [...latest.values()].map((runId) =>
    competitorTable(points.filter((p) => p.runId === runId).map((p) => ({ competitors: p.competitors as Competitor[] }))),
  );
  const titles = new Map<string, string>();
  for (const rows of perKeyword) for (const r of rows) if (r.placeId) titles.set(r.placeId, r.business);
  return { ...selectTopCompetitors(perKeyword), titles };
}

/**
 * Refresh one tracker's top competitors' profiles: pick the top 10 by appearances, leave out any
 * fetched in the last day (by this or another tracker of the org), reserve the cost under the org's
 * budget, credit balance and the platform's daily cap (live only), then post one info task and one
 * updates task per business. The answers are collected later by `collectCompetitorProfiles`.
 * Fixture data is free and labelled `fixture`; sandbox is free and labelled `sandbox`; they never mix with live.
 */
export async function refreshCompetitorProfiles(db: Db, configId: string, deps: RefreshDeps = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? new Date();
  const source = deps.source ?? rankSource();
  const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
  if (!config || config.kind !== "tracker" || !config.active || !isDue(config.competitorRefresh, config.competitorRefreshedAt, now)) {
    return { outcome: "not_due" };
  }
  const found = await topFor(db, config, source);
  if (!found) return { outcome: "no_scan_data" }; // nothing scanned yet from this source: try again tomorrow
  const { top, skippedNoPlaceId, titles } = found;

  const recent = new Set(
    (
      await db
        .select({ placeId: competitorProfileTasks.placeId })
        .from(competitorProfileTasks)
        .where(
          and(
            eq(competitorProfileTasks.orgId, config.orgId),
            eq(competitorProfileTasks.dataSource, source),
            ne(competitorProfileTasks.status, "failed"),
            gte(competitorProfileTasks.submittedAt, new Date(now.getTime() - DEDUPE_MS)),
          ),
        )
    ).map((r) => r.placeId),
  );
  const fresh = top.filter((c) => !recent.has(c.placeId));
  const markRefreshed = (tx: Pick<Db, "update">) =>
    tx.update(gridConfigs).set({ competitorRefreshedAt: now, competitorSkippedNoPlaceId: skippedNoPlaceId }).where(eq(gridConfigs.id, config.id));
  if (fresh.length === 0) {
    await markRefreshed(db);
    return { outcome: "nothing_to_fetch", skippedNoPlaceId };
  }

  // Gate (live only): org budget, credit balance, platform cap. Cost is reserved before any call is made.
  const live = source === "live";
  let spendIds: string[] = [];
  let markup = 0;
  if (live) {
    const estimate = refreshCostUsd(fresh.length, 0);
    try {
      spendIds = await db.transaction(async (tx) => {
        markup = (await getGridBilling(tx, config.orgId)).markupPercent;
        await assertWithinBudget(tx, config.orgId, refreshCostUsd(fresh.length, markup), now);
        await assertCredit(tx, config.orgId, usdToMicro(refreshCostUsd(fresh.length, markup)), now);
        await assertWithinPlatformCap(tx, estimate, now);
        const rows = await tx
          .insert(platformDfsSpend)
          .values(fresh.map(() => ({ kind: "competitor_profile", costUsd: String(PROFILE_PROVIDER_USD) })))
          .returning({ id: platformDfsSpend.id });
        return rows.map((r) => r.id);
      });
    } catch (e) {
      const noCredit = e instanceof CreditExhaustedError;
      if (!(e instanceof BudgetExceededError) && !(e instanceof PlatformCapExceededError) && !noCredit) throw e;
      const scope = e instanceof PlatformCapExceededError ? "platform" : "org";
      await db.transaction(async (tx) => {
        await markRefreshed(tx); // retried next period, not every day
        await workerAudit(tx, config.orgId)({
          action: "geogrid.competitor_refresh_skipped",
          entityType: "grid_config",
          entityId: config.id,
          before: null,
          after: { reason: noCredit ? "credit_exhausted" : scope === "platform" ? "platform_cap_exceeded" : "budget_exceeded", message: (e as Error).message },
        });
        if (!noCredit) await notifyBudgetExceeded(tx, { orgId: config.orgId, scope, now, alert: deps.alert });
      });
      return { outcome: "skipped_limit" };
    }
  }

  // Provider calls, no transaction open. A refusal of our account is ours to fix: alert and keep the schedule due.
  const transport = transportFor(source, deps);
  // The tracked business's country decides the DataForSEO location; fixtures need none.
  const locationCode = dfsLocationCodeFor(source === "fixture" || !config.locationId ? null : await regionOfTracker(db, config.orgId, config.locationId));
  const posted: { kind: ProfileKind; task: PostedTask }[] = [];
  const ids = fresh.map((c) => c.placeId);
  try {
    for (const kind of KINDS) {
      for (let i = 0; i < ids.length; i += COMPETITOR_PROFILES.maxTasksPerPost) {
        for (const task of await transport.post(kind, ids.slice(i, i + COMPETITOR_PROFILES.maxTasksPerPost), locationCode)) posted.push({ kind, task });
      }
    }
  } catch (e) {
    if (e instanceof DfsAccountError) {
      await (deps.alert ?? sendAlert)(
        `Competitor profiles: DataForSEO refused our account (${e.code})`,
        `Tracker ${config.id} could not submit competitor profile tasks: ${e.message}. Check the balance, the daily cost limit and the IP whitelist in the DataForSEO dashboard.`,
      ).catch((err) => console.error("[competitors] alert failed", err));
    }
    // Tasks already accepted before the failure are still recorded below and still charged.
    if (posted.length === 0) {
      if (spendIds.length) await db.update(platformDfsSpend).set({ costUsd: "0" }).where(inArray(platformDfsSpend.id, spendIds));
      console.error(`[competitors] refresh of tracker ${config.id} failed to submit: ${e instanceof Error ? e.name : "error"}`);
      return { outcome: "failed" };
    }
  }

  const accepted = posted.filter((p) => p.task.ref);
  const unit = (kind: ProfileKind, t: PostedTask) =>
    t.costUsd > 0 ? t.costUsd : kind === "info" ? COMPETITOR_PROFILES.dataforseo.info.standardUsd : COMPETITOR_PROFILES.dataforseo.updates.taskUsd + COMPETITOR_PROFILES.dataforseo.updates.per10UpdatesUsd;
  const chargeOf = (kind: ProfileKind, t: PostedTask) => (live ? roundUpUsd(unit(kind, t) * (1 + markup / 100)) : 0);
  const providerTotal = live ? accepted.reduce((s, p) => s + unit(p.kind, p.task), 0) : 0;
  const chargedTotal = accepted.reduce((s, p) => s + chargeOf(p.kind, p.task), 0);

  await db.transaction(async (tx) => {
    if (accepted.length) {
      await tx.insert(competitorProfileTasks).values(
        accepted.map(({ kind, task }) => ({
          orgId: config.orgId,
          placeId: task.placeId,
          title: titles.get(task.placeId) ?? null,
          kind,
          dataSource: source,
          taskRef: task.ref!,
          fetchedOn: day(now),
          providerCostUsd: unit(kind, task).toFixed(6),
          chargedUsd: chargeOf(kind, task).toFixed(6),
          submittedAt: now,
        })),
      );
    }
    if (live) {
      // Settle the platform reservation to what DataForSEO actually accepted (spread evenly over the reserved rows).
      if (spendIds.length) {
        await tx.update(platformDfsSpend).set({ costUsd: (providerTotal / spendIds.length).toFixed(4) }).where(inArray(platformDfsSpend.id, spendIds));
      }
      await debit(tx, { orgId: config.orgId, reason: "scan", refId: `competitors:${config.id}:${now.toISOString()}`, microUsd: usdToMicro(chargedTotal), now });
    }
    await markRefreshed(tx);
    await workerAudit(tx, config.orgId)({
      action: "geogrid.competitor_refresh",
      entityType: "grid_config",
      entityId: config.id,
      before: null,
      after: { source, requested: fresh.length, tasksAccepted: accepted.length, tasksRefused: posted.length - accepted.length, skippedNoPlaceId, chargedUsd: chargedTotal },
    });
  });
  console.log(
    `[competitors] tracker ${config.id} refresh source=${source} requested=${fresh.length} accepted=${accepted.length} skipped_no_place_id=${skippedNoPlaceId} provider_usd=${providerTotal.toFixed(4)} charged_usd=${chargedTotal.toFixed(4)}`,
  );
  // Fixture answers are immediate: store them now so the first view is not empty.
  if (source === "fixture") await collectCompetitorProfiles(db, { transport, now, orgIds: [config.orgId] });
  return { outcome: "submitted", requested: fresh.length, skippedNoPlaceId, chargedUsd: chargedTotal };
}

/** Daily job: refresh every tracker whose competitor schedule is due. */
export async function enqueueDueCompetitorRefreshes(db: Db, deps: RefreshDeps = {}): Promise<{ checked: number; submitted: number; skipped: number }> {
  const now = deps.now ?? new Date();
  const candidates = await db
    .select({ id: gridConfigs.id, orgId: gridConfigs.orgId })
    .from(gridConfigs)
    .where(and(eq(gridConfigs.kind, "tracker"), eq(gridConfigs.active, true), ne(gridConfigs.competitorRefresh, "manual"), orgIsActive(gridConfigs.orgId)))
    .orderBy(gridConfigs.createdAt, gridConfigs.id);
  let submitted = 0;
  let skipped = 0;
  for (const c of candidates) {
    if (deps.orgIds && !deps.orgIds.includes(c.orgId)) continue;
    try {
      const r = await refreshCompetitorProfiles(db, c.id, { ...deps, now });
      if (r.outcome === "submitted") submitted++;
      else if (r.outcome === "skipped_limit" || r.outcome === "failed") skipped++;
    } catch (e) {
      skipped++;
      console.error(`[competitors] tracker ${c.id} refresh error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: candidates.length, submitted, skipped };
}

/**
 * Fetch the answers of submitted profile tasks and store them. A task DataForSEO has not finished is
 * left for the next sweep; one still empty after `giveUpAfterMs` is failed. Safe to run at any time.
 */
export async function collectCompetitorProfiles(
  db: Db,
  deps: Pick<RefreshDeps, "transport" | "now" | "orgIds"> = {},
): Promise<{ checked: number; stored: number; failed: number; pending: number }> {
  const now = deps.now ?? new Date();
  const open = await db
    .select()
    .from(competitorProfileTasks)
    .where(and(eq(competitorProfileTasks.status, "submitted"), deps.orgIds ? inArray(competitorProfileTasks.orgId, deps.orgIds) : undefined, orgIsActive(competitorProfileTasks.orgId)))
    .orderBy(competitorProfileTasks.submittedAt)
    .limit(500);
  let stored = 0;
  let failed = 0;
  let pending = 0;
  for (const task of open) {
    const fail = async (error: string) => {
      await db.update(competitorProfileTasks).set({ status: "failed", error: error.slice(0, 500), finishedAt: now }).where(eq(competitorProfileTasks.id, task.id));
      failed++;
    };
    const transport = deps.transport ?? transportFor(task.dataSource, deps);
    let res;
    try {
      res = await transport.get(task.kind, task.taskRef);
    } catch (e) {
      if (now.getTime() - task.submittedAt.getTime() > COMPETITOR_PROFILES.giveUpAfterMs) await fail(`collect_failed: ${e instanceof Error ? e.message : String(e)}`);
      else pending++;
      continue;
    }
    if (res.state === "not_ready") {
      if (now.getTime() - task.submittedAt.getTime() > COMPETITOR_PROFILES.giveUpAfterMs) await fail("no_result: DataForSEO returned nothing in time");
      else pending++;
      continue;
    }
    if (task.kind === "info") {
      const info = parseInfoItem((res.result as { items?: unknown[] } | null)?.items?.[0]);
      if (!info) {
        await fail("not_found: DataForSEO returned no business for this place id");
        continue;
      }
      const values = {
        categories: info.categories,
        totalPhotos: info.totalPhotos,
        rating: info.rating === null ? null : info.rating.toFixed(1),
        reviewCount: info.reviewCount,
      };
      await db
        .insert(competitorProfiles)
        .values({ orgId: task.orgId, placeId: task.placeId, title: task.title, fetchedAt: now, fetchedOn: task.fetchedOn, dataSource: task.dataSource, ...values })
        .onConflictDoUpdate({
          target: [competitorProfiles.orgId, competitorProfiles.placeId, competitorProfiles.dataSource, competitorProfiles.fetchedOn],
          set: { ...values, fetchedAt: now },
        });
    } else {
      const posts = parseUpdatesResult(res.result);
      await db
        .insert(competitorProfiles)
        .values({ orgId: task.orgId, placeId: task.placeId, title: task.title, fetchedAt: now, fetchedOn: task.fetchedOn, dataSource: task.dataSource, ...posts })
        .onConflictDoUpdate({
          target: [competitorProfiles.orgId, competitorProfiles.placeId, competitorProfiles.dataSource, competitorProfiles.fetchedOn],
          set: posts,
        });
    }
    await db.update(competitorProfileTasks).set({ status: "done", finishedAt: now }).where(eq(competitorProfileTasks.id, task.id));
    stored++;
  }
  return { checked: open.length, stored, failed, pending };
}
