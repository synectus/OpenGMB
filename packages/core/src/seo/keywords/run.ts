import { and, eq, lt, or, sql } from "drizzle-orm";
import { platformDfsSpend, seoKeywordResearchRuns, type Db } from "@opengmb/db";
import { usdToMicro } from "../../ai/money";
import { debit } from "../../billing";
import { DFS_COUNTRY_LOCATIONS } from "../../config/dfs-locations";
import { SEO_KEYWORDS, SEO_PRICES } from "../../config/seo";
import { getGridBilling, roundUpUsd } from "../../geogrid/cost";
import { DfsAccountError } from "../../geogrid/drivers/errors";
import { enqueueJob } from "../../jobs";
import { bumpCounter, readCounter } from "../../limits/counters";
import { sendAlert } from "../../monitoring/alert";
import { workerAudit } from "../../reviews/reply-state";
import { isAdsKeyword } from "../ported/openseo/ads-keyword";
import { interleaveRows } from "../ported/openseo/interleave";
import { mapLabsItems, type LabsRow } from "../ported/openseo/labs-items";
import { fixtureKeywordTransport, liveKeywordTransport, type KeywordTransport } from "./transport";

export const SEO_KEYWORDS_QUEUE = "seo.keyword-research";
export const SEO_KEYWORDS_SWEEP_QUEUE = "seo.keyword-research-sweep";
export const ADS_COUNTER_KIND = "dfs_google_ads_live";

export type KeywordRunDeps = {
  now?: Date;
  transport?: KeywordTransport;
  enqueue?: (runId: string, startAfterSeconds: number) => Promise<void>;
  alert?: (subject: string, text: string) => Promise<unknown>;
  /** Tests only: the clock for the Ads slot and the wait for the next minute. */
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};
export type KeywordRunOutcome = { outcome: "done" | "failed" | "deferred" | "not_queued" };

/** One stored result row: the national Labs numbers plus the chosen city's Google Ads volume. */
export type SeoKeywordRow = LabsRow & { localVolume?: number | null; localCpc?: number | null };

const minuteKey = (now: Date) => now.toISOString().slice(0, 16);

/** True when this minute's Google Ads Live allowance is used up (reads only; nothing is taken). */
async function adsMinuteFull(db: Db, now: Date): Promise<boolean> {
  return (await readCounter(db, "platform", ADS_COUNTER_KIND, minuteKey(now))) >= SEO_KEYWORDS.adsCallsPerMinute;
}

/** Take one Google Ads Live call for the minute `now` falls in; false when the minute is full. */
async function takeAdsSlot(db: Db, now: Date): Promise<boolean> {
  const n = await bumpCounter(db, "platform", ADS_COUNTER_KIND, minuteKey(now));
  if (n <= SEO_KEYWORDS.adsCallsPerMinute) return true;
  await bumpCounter(db, "platform", ADS_COUNTER_KIND, minuteKey(now), -1);
  return false;
}

async function enqueueLater(db: Db, runId: string, seconds: number, deps: KeywordRunDeps): Promise<void> {
  if (deps.enqueue) return deps.enqueue(runId, seconds);
  await db.transaction(async (tx) => {
    await enqueueJob(tx, SEO_KEYWORDS_QUEUE, { runId }, { startAfterSeconds: seconds });
  });
}

/**
 * DataForSEO can answer the same keyword in both Labs calls, and the seed keyword twice in one (seed_keyword_data, then items),
 * with numbers in only one of them. The first answer used to win, so a seed row could show no national volume or CPC while the
 * other answer had it. Gaps in a row are filled from any other row for the same keyword.
 */
function fillGaps(rows: LabsRow[], others: LabsRow[]): LabsRow[] {
  const by = new Map(others.map((o) => [o.keyword, o]));
  return rows.map((r) => {
    const o = by.get(r.keyword);
    if (!o) return r;
    return {
      ...r,
      searchVolume: r.searchVolume ?? o.searchVolume,
      cpc: r.cpc ?? o.cpc,
      competition: r.competition ?? o.competition,
      keywordDifficulty: r.keywordDifficulty ?? o.keywordDifficulty,
      trend: r.trend.length ? r.trend : o.trend,
      intent: r.intent === "unknown" ? o.intent : r.intent,
    };
  });
}

async function labsLeg(transport: KeywordTransport, kind: "suggestions" | "ideas", run: { seed: string; countryIso: string; languageCode: string; rowLimit: number }) {
  const r = await transport.labs(kind, {
    seed: run.seed,
    locationCode: DFS_COUNTRY_LOCATIONS.codes[run.countryIso]!,
    languageCode: run.languageCode,
    limit: Math.ceil(run.rowLimit / 2),
  });
  // Duplicates inside one answer: the first keeps its place, and takes what the later copies have that it lacks.
  const rows = mapLabsItems(r.items);
  return { rows: fillGaps(rows, mapLabsItems([...r.items].reverse())), costUsd: r.costUsd };
}

/** Take an Ads slot now; if the minute filled up meanwhile, wait for the next minute once. */
async function takeSlotWithWait(db: Db, deps: KeywordRunDeps): Promise<boolean> {
  const clock = deps.clock ?? (() => new Date());
  if (await takeAdsSlot(db, clock())) return true;
  const t = clock();
  await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(60_000 - (t.getTime() % 60_000) + 500);
  return takeAdsSlot(db, clock());
}

export async function runKeywordResearch(db: Db, runId: string, deps: KeywordRunDeps = {}): Promise<KeywordRunOutcome> {
  const now = deps.now ?? new Date();
  const [run] = await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.id, runId));
  if (!run) return { outcome: "not_queued" };
  // A run left `running` (worker restart, settle error) is claimed again after the stale age; the debit is idempotent.
  const staleBefore = new Date(now.getTime() - SEO_KEYWORDS.staleRunningMs);
  const reclaimable = run.status === "running" && run.startedAt !== null && run.startedAt < staleBefore;
  if (run.status !== "queued" && !reclaimable) return { outcome: "not_queued" };
  const live = run.dataSource === "live";
  const hasCity = !!run.cityLocationName;

  // Google Ads Live is limited per minute for the whole platform: wait and stay queued. The slot itself is taken
  // just before the Ads call; this look only avoids paying for Labs when the minute is already full.
  if (hasCity && run.dataSource !== "fixture" && (await adsMinuteFull(db, now))) {
    await enqueueLater(db, runId, 60, deps);
    return { outcome: "deferred" };
  }
  const claimed = await db
    .update(seoKeywordResearchRuns)
    .set({ status: "running", startedAt: now })
    .where(
      and(
        eq(seoKeywordResearchRuns.id, runId),
        or(eq(seoKeywordResearchRuns.status, "queued"), and(eq(seoKeywordResearchRuns.status, "running"), lt(seoKeywordResearchRuns.startedAt, staleBefore))),
      ),
    )
    .returning({ id: seoKeywordResearchRuns.id });
  if (claimed.length === 0) return { outcome: "not_queued" };

  const transport = deps.transport ?? (run.dataSource === "fixture" ? fixtureKeywordTransport() : liveKeywordTransport());
  let providerTotal = 0;
  let accountError: DfsAccountError | null = null;
  const note = (e: unknown) => {
    if (e instanceof DfsAccountError) accountError = e;
    return e instanceof Error ? e.name : "error";
  };

  // Provider calls, no transaction open.
  const [sugg, ideas] = await Promise.allSettled([labsLeg(transport, "suggestions", run), labsLeg(transport, "ideas", run)]);
  for (const leg of [sugg, ideas]) {
    if (leg.status === "fulfilled") providerTotal += leg.value.costUsd;
    else note(leg.reason);
  }
  let error: string | null = null;
  let rows: SeoKeywordRow[] = [];
  let localVolumeNote: string | null = null;
  if (sugg.status === "rejected" && ideas.status === "rejected") {
    error = note(sugg.reason);
  } else {
    const suggRows = sugg.status === "fulfilled" ? sugg.value.rows : [];
    const ideaRows = ideas.status === "fulfilled" ? ideas.value.rows : [];
    rows = interleaveRows(fillGaps(suggRows, ideaRows), fillGaps(ideaRows, suggRows), run.rowLimit);
    if (rows.length === 0) error = "no_rows";
    else if (hasCity) {
      const keywords = rows.map((r) => r.keyword).filter(isAdsKeyword).slice(0, SEO_PRICES.googleAdsLive.maxKeywordsPerTask);
      if (keywords.length === 0) {
        localVolumeNote = "no_valid_keywords";
      } else {
        try {
          if (run.dataSource !== "fixture" && !(await takeSlotWithWait(db, deps))) throw new Error("ads_rate_limit");
          const ads = await transport.adsVolume({ keywords, locationName: run.cityLocationName!, languageCode: run.languageCode });
          providerTotal += ads.costUsd;
          const byKeyword = new Map(ads.items.map((i) => [i.keyword.trim().toLowerCase(), i]));
          rows = rows.map((r) => {
            const hit = byKeyword.get(r.keyword);
            // A keyword Google Ads did not answer has no city number; never fall back to the national one.
            return { ...r, localVolume: hit?.search_volume ?? null, localCpc: hit?.cpc ?? null };
          });
        } catch (e) {
          note(e);
          localVolumeNote = "local_volume_failed";
        }
      }
      if (localVolumeNote) rows = rows.map((r) => ({ ...r, localVolume: null, localCpc: null }));
    }
  }
  if (accountError) {
    const e = accountError as DfsAccountError;
    await (deps.alert ?? sendAlert)(
      `SEO keyword research: DataForSEO refused our account (${e.code})`,
      `Run ${runId} could not be completed: ${e.message}. Check the balance, the daily cost limit and the IP whitelist in the DataForSEO dashboard.`,
    ).catch((err) => console.error("[seo-keywords] alert failed", err));
  }

  const failed = error !== null;
  let charged = 0;
  const settledByUs = await db.transaction(async (tx) => {
    if (live && !failed) {
      const markup = (await getGridBilling(tx, run.orgId)).markupPercent;
      // The charge never exceeds the price shown (the reserved estimate).
      charged = Math.min(roundUpUsd(providerTotal * (1 + markup / 100)), Number(run.estimateChargeUsd));
    }
    // Settle only the claim this invocation holds: if the sweep failed the run or a second invocation claimed it again
    // (a new started_at), nothing here may change the run, the spend row or the ledger.
    const updated = await tx
      .update(seoKeywordResearchRuns)
      .set({
        status: failed ? "failed" : "done",
        rows: failed ? [] : rows,
        error,
        localVolumeNote,
        providerCostUsd: providerTotal.toFixed(6),
        chargedUsd: charged.toFixed(4),
        completedAt: now,
      })
      .where(and(eq(seoKeywordResearchRuns.id, runId), eq(seoKeywordResearchRuns.status, "running"), eq(seoKeywordResearchRuns.startedAt, now)))
      .returning({ id: seoKeywordResearchRuns.id });
    if (updated.length === 0) return false;
    if (live) {
      if (run.spendId) await tx.update(platformDfsSpend).set({ costUsd: providerTotal.toFixed(4) }).where(eq(platformDfsSpend.id, run.spendId));
      await debit(tx, { orgId: run.orgId, reason: "scan", refId: `seo_keywords:${run.id}`, microUsd: usdToMicro(charged), now });
    }
    await workerAudit(tx, run.orgId)({
      action: failed ? "seo.keyword_research.failed" : "seo.keyword_research.done",
      entityType: "workspace",
      entityId: run.workspaceId,
      before: null,
      after: { runId, rows: rows.length, chargedUsd: charged },
    });
    return true;
  });
  if (!settledByUs) return { outcome: "not_queued" };
  console.log(`[seo-keywords] run ${runId} source=${run.dataSource} rows=${rows.length} provider_usd=${providerTotal.toFixed(4)} charged_usd=${charged.toFixed(4)}`);
  return { outcome: failed ? "failed" : "done" };
}

/**
 * Safety net for runs the job never settled: a run still `queued` after sweepQueuedAfterMs (pg-boss gave up) or `running`
 * after sweepRunningAfterMs (the job died) is failed with charge 0, which releases its reservation, and its platform
 * spend row is settled to 0. Safe to run at any time.
 */
export async function sweepStaleKeywordRuns(db: Db, opts: { now?: Date } = {}): Promise<{ failed: number }> {
  const now = opts.now ?? new Date();
  const queuedBefore = new Date(now.getTime() - SEO_KEYWORDS.sweepQueuedAfterMs);
  const runningBefore = new Date(now.getTime() - SEO_KEYWORDS.sweepRunningAfterMs);
  const stale = await db
    .select({ id: seoKeywordResearchRuns.id })
    .from(seoKeywordResearchRuns)
    .where(
      or(
        and(eq(seoKeywordResearchRuns.status, "queued"), lt(seoKeywordResearchRuns.createdAt, queuedBefore)),
        and(eq(seoKeywordResearchRuns.status, "running"), lt(sql`coalesce(${seoKeywordResearchRuns.startedAt}, ${seoKeywordResearchRuns.createdAt})`, sql`${runningBefore.toISOString()}::timestamptz`)),
      ),
    );
  let failed = 0;
  for (const { id } of stale) {
    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.id, id)).for("update");
      if (!r || (r.status !== "queued" && r.status !== "running")) return;
      await tx
        .update(seoKeywordResearchRuns)
        .set({ status: "failed", error: "stale", chargedUsd: "0", providerCostUsd: "0", completedAt: now })
        .where(eq(seoKeywordResearchRuns.id, id));
      if (r.spendId) await tx.update(platformDfsSpend).set({ costUsd: "0" }).where(eq(platformDfsSpend.id, r.spendId));
      await workerAudit(tx, r.orgId)({ action: "seo.keyword_research.failed", entityType: "workspace", entityId: r.workspaceId, before: null, after: { runId: id, reason: "stale" } });
      failed++;
    });
  }
  return { failed };
}
