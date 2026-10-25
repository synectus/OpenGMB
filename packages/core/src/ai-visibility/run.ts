import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { aiVisibilityResults, aiVisibilityRuns, aiVisibilitySettings, gridConfigs, gridPoints, gridRuns, locations, platformDfsSpend, type Db, type Tx } from "@opengmb/db";
import { usdToMicro } from "../ai/money";
import { CreditExhaustedError, assertCredit, debit } from "../billing";
import { AI_ENGINES, AI_VISIBILITY, checkCostUsd, type AiEngine } from "../config/ai-visibility";
import { dfsLocationCodeFor } from "../config/dfs-locations";
import { competitorTable, type Competitor } from "../geogrid/analytics";
import { notifyBudgetExceeded } from "../geogrid/budget-alert";
import { BudgetExceededError, PlatformCapExceededError, assertWithinBudget, assertWithinPlatformCap, getGridBilling, roundUpUsd } from "../geogrid/cost";
import { DfsAccountError } from "../geogrid/drivers/errors";
import { rankSource, type RankSource } from "../geogrid/drivers/source";
import { isDue } from "../geogrid/schedule";
import { locationRegionCode } from "../locations/center";
import { sendAlert } from "../monitoring/alert";
import { workerAudit } from "../reviews/reply-state";
import { buildPrompts } from "./prompts";
import { answerOf, parseAnswer } from "./parse";
import { FIXTURE_COMPETITORS, fixtureAiTransport, liveAiTransport, type AiTransport } from "./transport";

export const AI_VISIBILITY_QUEUE = "ai_visibility.check";
/** Daily tick; each enabled location is then due once a week. */
export const AI_VISIBILITY_CRON = "45 5 * * *";

export type AiCheckDeps = {
  source?: RankSource;
  transport?: AiTransport;
  now?: Date;
  /** A manual check ignores the weekly schedule. */
  force?: boolean;
  alert?: (subject: string, text: string) => Promise<unknown>;
  /** Tests only; production checks every org. */
  orgIds?: string[];
};

export type AiCheckOutcome =
  | { outcome: "stored"; runId: string; results: number; chargedUsd: number }
  | { outcome: "not_enabled" | "not_due" | "no_prompts" | "skipped_limit" | "failed" };

/** Only engines we know, in the fixed order; never an empty list. */
export function cleanEngines(engines: readonly string[] | null | undefined): AiEngine[] {
  const picked = AI_ENGINES.filter((e) => engines?.includes(e));
  return picked.length ? picked : [...AI_VISIBILITY.defaultEngines];
}

/** What one check costs: DataForSEO's price and what the org is charged (with its markup). */
export async function checkEstimate(db: Db | Tx, orgId: string, engines: readonly AiEngine[]): Promise<{ providerUsd: number; chargedUsd: number; prompts: number }> {
  const markup = (await getGridBilling(db, orgId)).markupPercent;
  const providerUsd = roundUpUsd(checkCostUsd(engines));
  return { providerUsd, chargedUsd: roundUpUsd(providerUsd * (1 + markup / 100)), prompts: AI_VISIBILITY.promptsPerCheck };
}

/** The competitors of the location's trackers' latest finished runs, most often seen first. */
async function knownCompetitors(db: Db, locationId: string): Promise<string[]> {
  const configs = await db.select({ id: gridConfigs.id }).from(gridConfigs).where(and(eq(gridConfigs.locationId, locationId), eq(gridConfigs.kind, "tracker")));
  if (configs.length === 0) return [];
  const runs = await db
    .select({ id: gridRuns.id, configId: gridRuns.configId, keyword: gridRuns.keyword })
    .from(gridRuns)
    .where(and(inArray(gridRuns.configId, configs.map((c) => c.id)), eq(gridRuns.status, "done")))
    .orderBy(desc(gridRuns.createdAt))
    .limit(60);
  const latest = new Map<string, string>();
  for (const r of runs) {
    const key = `${r.configId}:${r.keyword}`;
    if (!latest.has(key)) latest.set(key, r.id);
  }
  if (latest.size === 0) return [];
  const points = await db.select({ runId: gridPoints.runId, competitors: gridPoints.competitors }).from(gridPoints).where(inArray(gridPoints.runId, [...latest.values()]));
  const byName = new Map<string, number>();
  for (const runId of latest.values()) {
    for (const c of competitorTable(points.filter((p) => p.runId === runId).map((p) => ({ competitors: p.competitors as Competitor[] })))) {
      byName.set(c.business, (byName.get(c.business) ?? 0) + c.appearances);
    }
  }
  return [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n]) => n);
}

async function trackedKeywords(db: Db, locationId: string): Promise<string[]> {
  const rows = await db
    .select({ keywords: gridConfigs.keywords })
    .from(gridConfigs)
    .where(and(eq(gridConfigs.locationId, locationId), eq(gridConfigs.kind, "tracker"), eq(gridConfigs.active, true)))
    .orderBy(gridConfigs.createdAt);
  return rows.flatMap((r) => r.keywords);
}

/**
 * One check of one location: build the prompts, gate the cost (live only: org budget, credit balance, platform daily cap),
 * ask every chosen engine, and store what each answered. Fixture data is free and labelled `fixture`; sandbox is free and
 * labelled `sandbox`; they never count toward spend.
 */
export async function runAiVisibilityCheck(db: Db, locationId: string, deps: AiCheckDeps = {}): Promise<AiCheckOutcome> {
  const now = deps.now ?? new Date();
  const source = deps.source ?? rankSource();
  const [settings] = await db.select().from(aiVisibilitySettings).where(eq(aiVisibilitySettings.locationId, locationId));
  if (!settings || !settings.enabled) return { outcome: "not_enabled" };
  if (!deps.force && !isDue(AI_VISIBILITY.schedule, settings.lastCheckedAt, now)) return { outcome: "not_due" };
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.orgId, settings.orgId)));
  if (!loc || loc.status !== "active") return { outcome: "not_enabled" };
  const orgId = settings.orgId;
  const engines = cleanEngines(settings.engines);
  const business = loc.title ?? loc.name;
  const prompts = buildPrompts({ category: settings.category, city: settings.city, keywords: await trackedKeywords(db, locationId) });
  const markChecked = (tx: Pick<Db, "update">) => tx.update(aiVisibilitySettings).set({ lastCheckedAt: now }).where(eq(aiVisibilitySettings.locationId, locationId));
  if (prompts.length === 0) return { outcome: "no_prompts" };

  // Gate (live only). The estimate is reserved before any call is made.
  const live = source === "live";
  const estimate = prompts.length * engines.reduce((s, e) => s + AI_VISIBILITY.engines[e].unitUsd, 0);
  let spendId: string | null = null;
  let markup = 0;
  if (live) {
    try {
      spendId = await db.transaction(async (tx) => {
        markup = (await getGridBilling(tx, orgId)).markupPercent;
        const charge = roundUpUsd(estimate * (1 + markup / 100));
        await assertWithinBudget(tx, orgId, charge, now);
        await assertCredit(tx, orgId, usdToMicro(charge), now);
        await assertWithinPlatformCap(tx, estimate, now);
        const [row] = await tx.insert(platformDfsSpend).values({ kind: "ai_visibility", locationId, costUsd: estimate.toFixed(4) }).returning({ id: platformDfsSpend.id });
        return row!.id;
      });
    } catch (e) {
      const noCredit = e instanceof CreditExhaustedError;
      if (!(e instanceof BudgetExceededError) && !(e instanceof PlatformCapExceededError) && !noCredit) throw e;
      const scope = e instanceof PlatformCapExceededError ? "platform" : "org";
      await db.transaction(async (tx) => {
        await markChecked(tx); // retried next period, not every day
        await workerAudit(tx, orgId)({
          action: "ai_visibility.check_skipped",
          entityType: "location",
          entityId: locationId,
          before: null,
          after: { reason: noCredit ? "credit_exhausted" : scope === "platform" ? "platform_cap_exceeded" : "budget_exceeded", message: (e as Error).message },
        });
        if (!noCredit) await notifyBudgetExceeded(tx, { orgId, scope, now, alert: deps.alert });
      });
      return { outcome: "skipped_limit" };
    }
  }

  // Provider calls, no transaction open.
  const transport = deps.transport ?? (source === "fixture" ? fixtureAiTransport() : liveAiTransport());
  const region = source === "fixture" ? null : await locationRegionCode(db, loc);
  const ctx = { locationCode: dfsLocationCodeFor(region), countryIso: (region ?? "US").toUpperCase(), business };
  const competitors = [...(await knownCompetitors(db, locationId)), ...(source === "fixture" ? FIXTURE_COMPETITORS : [])];
  type Row = { engine: AiEngine; prompt: string; mentioned: boolean; position: number | null; competitors: string[]; sourceDomains: string[]; excerpt: string; error: string | null };
  const rows: Row[] = [];
  let providerTotal = 0;
  let accountError: DfsAccountError | null = null;
  for (const prompt of prompts) {
    if (accountError) break;
    const answers = await Promise.all(
      engines.map(async (engine) => {
        try {
          const r = await transport.ask(engine, prompt, ctx);
          return { engine, ...r, error: null as string | null };
        } catch (e) {
          if (e instanceof DfsAccountError) accountError = e;
          return { engine, result: null as unknown, costUsd: 0, error: e instanceof Error ? e.name : "error" };
        }
      }),
    );
    for (const a of answers) {
      const failed = a.error ?? (a.result === null ? "no_answer" : null);
      if (live) providerTotal += a.costUsd > 0 ? a.costUsd : failed ? 0 : AI_VISIBILITY.engines[a.engine].unitUsd;
      const parsed = failed ? null : parseAnswer(answerOf(a.engine, a.result), business, competitors);
      rows.push({
        engine: a.engine,
        prompt,
        mentioned: parsed?.mentioned ?? false,
        position: parsed?.position ?? null,
        competitors: parsed?.competitors ?? [],
        sourceDomains: parsed?.sourceDomains ?? [],
        excerpt: parsed?.excerpt ?? "",
        error: failed,
      });
    }
  }
  if (accountError) {
    const e = accountError as DfsAccountError;
    await (deps.alert ?? sendAlert)(
      `AI visibility: DataForSEO refused our account (${e.code})`,
      `Location ${locationId} could not be checked: ${e.message}. Check the balance, the daily cost limit and the IP whitelist in the DataForSEO dashboard.`,
    ).catch((err) => console.error("[ai-visibility] alert failed", err));
  }
  const answered = rows.filter((r) => !r.error).length;
  const charged = live ? roundUpUsd(providerTotal * (1 + markup / 100)) : 0;
  if (answered === 0) {
    // Nothing usable came back: release the reservation, charge nothing, keep the schedule due.
    if (spendId) await db.update(platformDfsSpend).set({ costUsd: providerTotal.toFixed(4) }).where(eq(platformDfsSpend.id, spendId));
    console.error(`[ai-visibility] location ${locationId} check failed: no engine answered`);
    return { outcome: "failed" };
  }

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(aiVisibilityRuns)
      .values({ orgId, locationId, dataSource: source, promptCount: prompts.length, providerCostUsd: providerTotal.toFixed(6), chargedUsd: charged.toFixed(6), createdAt: now })
      .returning({ id: aiVisibilityRuns.id });
    await tx.insert(aiVisibilityResults).values(rows.map((r) => ({ ...r, orgId, runId: run!.id, createdAt: now })));
    if (live) {
      if (spendId) await tx.update(platformDfsSpend).set({ costUsd: providerTotal.toFixed(4) }).where(eq(platformDfsSpend.id, spendId));
      await debit(tx, { orgId, reason: "scan", refId: `ai_visibility:${run!.id}`, microUsd: usdToMicro(charged), now });
    }
    await markChecked(tx);
    await workerAudit(tx, orgId)({
      action: "ai_visibility.check",
      entityType: "location",
      entityId: locationId,
      before: null,
      after: { source, engines, prompts: prompts.length, answered, failed: rows.length - answered, chargedUsd: charged },
    });
    return run!.id;
  });
  console.log(`[ai-visibility] location ${locationId} source=${source} calls=${rows.length} answered=${answered} provider_usd=${providerTotal.toFixed(4)} charged_usd=${charged.toFixed(4)}`);
  return { outcome: "stored", runId, results: rows.length, chargedUsd: charged };
}

/** Daily job: check every enabled location whose weekly check is due. */
export async function enqueueDueAiVisibilityChecks(db: Db, deps: AiCheckDeps = {}): Promise<{ checked: number; stored: number; skipped: number }> {
  const candidates = await db
    .select({ locationId: aiVisibilitySettings.locationId, orgId: aiVisibilitySettings.orgId })
    .from(aiVisibilitySettings)
    .where(and(eq(aiVisibilitySettings.enabled, true), ne(aiVisibilitySettings.category, "")))
    .orderBy(aiVisibilitySettings.locationId);
  let stored = 0;
  let skipped = 0;
  const due = deps.orgIds ? candidates.filter((c) => deps.orgIds!.includes(c.orgId)) : candidates;
  for (const c of due) {
    try {
      const r = await runAiVisibilityCheck(db, c.locationId, { ...deps, force: false });
      if (r.outcome === "stored") stored++;
      else if (r.outcome === "skipped_limit" || r.outcome === "failed") skipped++;
    } catch (e) {
      skipped++;
      console.error(`[ai-visibility] location ${c.locationId} check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: due.length, stored, skipped };
}
