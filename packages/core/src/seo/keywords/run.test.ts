import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, platformDfsSpend, seoKeywordResearchRuns } from "@opengmb/db";
import { SEO_KEYWORDS } from "../../config/seo";
import { DfsRetryableError } from "../../geogrid/drivers/errors";
import { MockGoogleClient } from "../../google/mock-client";
import { bumpCounter } from "../../limits/counters";
import { makeKit } from "../../testkit";
import { ADS_COUNTER_KIND, runKeywordResearch, sweepStaleKeywordRuns } from "./run";
import { monthToDateUsd } from "../../geogrid/cost";
import { SEO_KEYWORDS as K } from "../../config/seo";
import { readCounter } from "../../limits/counters";
import { fixtureKeywordTransport, type KeywordTransport } from "./transport";

vi.setConfig({ testTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
afterAll(async () => { await kit.deactivateAll(); await sql.end(); vi.unstubAllEnvs(); });

const CITY = "Austin,Texas,United States";
let minute = 0;
/** A distinct, far-future minute per test so the platform-wide Ads counter never leaks between tests. */
const freshNow = () => new Date(Date.UTC(2031, 0, 1, 0, minute++, 5));

async function mkRun(p: { dataSource: "fixture" | "live"; city?: string | null; estimate?: string; withSpend?: boolean; rows?: number }) {
  const org = await kit.makeOrg();
  let spendId: string | null = null;
  if (p.withSpend) {
    const [s] = await db.insert(platformDfsSpend).values({ kind: "seo_keywords", costUsd: "0.2000" }).returning({ id: platformDfsSpend.id });
    spendId = s!.id;
  }
  const [run] = await db
    .insert(seoKeywordResearchRuns)
    .values({
      orgId: org.orgId, workspaceId: org.a, seed: "plumber", countryIso: "US", languageCode: "en", cityLocationName: p.city === undefined ? CITY : p.city,
      rowLimit: p.rows ?? 150, cacheKey: `k-${Math.random()}`, dataSource: p.dataSource, status: "queued", estimateChargeUsd: p.estimate ?? "0.2000", spendId,
    })
    .returning();
  return { org, run: run! };
}
const reload = async (id: string) => (await db.select().from(seoKeywordResearchRuns).where(eq(seoKeywordResearchRuns.id, id)))[0]!;

/** Fixture rows, with the cost DataForSEO would report per call. */
function costed(c: { sugg: number; ideas: number; ads: number }, fail: Partial<{ sugg: boolean; ideas: boolean; ads: boolean }> = {}) {
  const fx = fixtureKeywordTransport();
  const t: KeywordTransport = {
    labs: async (kind, q) => {
      if (kind === "suggestions" ? fail.sugg : fail.ideas) throw new DfsRetryableError(50000, "down");
      return { ...(await fx.labs(kind, q)), costUsd: kind === "suggestions" ? c.sugg : c.ideas };
    },
    adsVolume: async (q) => {
      if (fail.ads) throw new DfsRetryableError(50000, "down");
      return { ...(await fx.adsVolume(q)), costUsd: c.ads };
    },
    adsLocations: fx.adsLocations,
  };
  return t;
}

describe("keyword research worker job", () => {
  it("1. fixture run with a city: blended rows, national KD and city volume, charged 0, no ledger entry", async () => {
    const { org, run } = await mkRun({ dataSource: "fixture" });
    expect(await runKeywordResearch(db, run.id, { now: freshNow() })).toEqual({ outcome: "done" });
    const r = await reload(run.id);
    const rows = r.rows as { keyword: string; keywordDifficulty: number | null; localVolume: number | null }[];
    expect(r.status).toBe("done");
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThanOrEqual(r.rowLimit);
    expect(rows[0]!.keyword).toBe("plumber"); // first from suggestions
    expect(rows[1]!.keyword).toBe("drain cleaning"); // second from ideas
    expect(rows.every((x) => x.keywordDifficulty !== null && x.localVolume !== null)).toBe(true);
    expect(Number(r.chargedUsd)).toBe(0);
    console.log(`[seo-run] fixture rows=${rows.length} with city volume=${rows.filter((x) => x.localVolume !== null).length} org=${org.orgId.slice(0, 4)}`);
  });

  it("the seed row gets its national volume and CPC when only one Labs answer has them", async () => {
    const { run } = await mkRun({ dataSource: "fixture", city: null });
    const fx = fixtureKeywordTransport();
    const t: KeywordTransport = {
      ...fx,
      labs: async (kind, q) => {
        const r = await fx.labs(kind, q);
        const empty = { keyword: "plumber", keyword_info: { search_volume: null, cpc: null, competition: null, monthly_searches: null } };
        // Suggestions: the seed comes first with no numbers (seed_keyword_data); the numbers are only in the ideas answer.
        if (kind === "suggestions") return { ...r, items: [empty, ...r.items.filter((i) => i.keyword !== "plumber")] };
        // Ideas: the seed row carries the numbers.
        return { ...r, items: [{ keyword: "plumber", keyword_info: { search_volume: 1000, cpc: 2.5, competition: 0.4, monthly_searches: [] } }, ...r.items.filter((i) => i.keyword !== "plumber")] };
      },
    };
    await runKeywordResearch(db, run.id, { now: freshNow(), transport: t });
    const rows = (await reload(run.id)).rows as { keyword: string; searchVolume: number | null; cpc: number | null }[];
    expect(rows.find((r) => r.keyword === "plumber")).toMatchObject({ searchVolume: 1000, cpc: 2.5 });
    expect(rows.filter((r) => r.keyword === "plumber")).toHaveLength(1);
  });

  it("3. the Ads call fails: done, no city volume, a note, and the charge covers Labs only", async () => {
    const { run } = await mkRun({ dataSource: "live", withSpend: true, estimate: "5.0000" });
    await runKeywordResearch(db, run.id, { now: freshNow(), transport: costed({ sugg: 0.03, ideas: 0.02, ads: 0.09 }, { ads: true }) });
    const r = await reload(run.id);
    const rows = r.rows as { localVolume: number | null }[];
    expect(r.status).toBe("done");
    expect(r.localVolumeNote).toBe("local_volume_failed");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.localVolume === null)).toBe(true);
    expect(Number(r.providerCostUsd)).toBeCloseTo(0.05, 6);
  });

  it("4. both Labs calls fail: failed, charged 0, spend settled to the reported cost", async () => {
    const { run } = await mkRun({ dataSource: "live", withSpend: true });
    const alert = vi.fn(async () => undefined);
    expect(await runKeywordResearch(db, run.id, { now: freshNow(), alert, transport: costed({ sugg: 0.03, ideas: 0.02, ads: 0.09 }, { sugg: true, ideas: true }) })).toEqual({ outcome: "failed" });
    const r = await reload(run.id);
    expect(r.status).toBe("failed");
    expect(Number(r.chargedUsd)).toBe(0);
    expect(r.error).toBeTruthy();
    const [spend] = await db.select().from(platformDfsSpend).where(eq(platformDfsSpend.id, run.spendId!));
    expect(Number(spend!.costUsd)).toBe(0);
  });

  it("5. rate limit: a full minute defers the job, keeps it queued and re-enqueues it 60 s later", async () => {
    const { run } = await mkRun({ dataSource: "live" });
    const now = freshNow();
    await bumpCounter(db, "platform", ADS_COUNTER_KIND, now.toISOString().slice(0, 16), SEO_KEYWORDS.adsCallsPerMinute);
    const enqueue = vi.fn(async () => undefined);
    expect(await runKeywordResearch(db, run.id, { now, enqueue, transport: costed({ sugg: 0, ideas: 0, ads: 0 }) })).toEqual({ outcome: "deferred" });
    expect(enqueue).toHaveBeenCalledWith(run.id, 60);
    expect((await reload(run.id)).status).toBe("queued");
  });

  it("6. idempotent: a second call on a done run changes nothing", async () => {
    const { run } = await mkRun({ dataSource: "fixture", city: null });
    expect(await runKeywordResearch(db, run.id, { now: freshNow() })).toEqual({ outcome: "done" });
    const before = await reload(run.id);
    expect(await runKeywordResearch(db, run.id, { now: freshNow() })).toEqual({ outcome: "not_queued" });
    expect(await reload(run.id)).toEqual(before);
  });

  it("7. a run left running past the stale age is claimed again and settles once; a fresh running run is left alone", async () => {
    const { run } = await mkRun({ dataSource: "fixture", city: null });
    const t0 = freshNow();
    await db.update(seoKeywordResearchRuns).set({ status: "running", startedAt: t0 }).where(eq(seoKeywordResearchRuns.id, run.id));
    expect(await runKeywordResearch(db, run.id, { now: new Date(t0.getTime() + 60_000) })).toEqual({ outcome: "not_queued" });
    const later = new Date(t0.getTime() + K.staleRunningMs + 1000);
    expect(await runKeywordResearch(db, run.id, { now: later })).toEqual({ outcome: "done" });
    const r = await reload(run.id);
    expect(r.status).toBe("done");
    expect(r.startedAt?.getTime()).toBe(later.getTime());
    expect(await runKeywordResearch(db, run.id, { now: later })).toEqual({ outcome: "not_queued" });
  });

  it("8. the sweep fails stale queued and running runs with no charge, settles the spend row and frees the month", async () => {
    const { org, run } = await mkRun({ dataSource: "live", withSpend: true, estimate: "0.5000" });
    const running = await mkRun({ dataSource: "live", withSpend: true, estimate: "0.5000" });
    const fresh = await mkRun({ dataSource: "live", withSpend: true, estimate: "0.5000" });
    const now = freshNow();
    const old = new Date(now.getTime() - K.sweepQueuedAfterMs - 60_000);
    await db.update(seoKeywordResearchRuns).set({ createdAt: old }).where(eq(seoKeywordResearchRuns.id, run.id));
    await db.update(seoKeywordResearchRuns).set({ status: "running", createdAt: old, startedAt: new Date(now.getTime() - K.sweepRunningAfterMs - 60_000) }).where(eq(seoKeywordResearchRuns.id, running.run.id));
    await db.update(seoKeywordResearchRuns).set({ createdAt: now }).where(eq(seoKeywordResearchRuns.id, fresh.run.id));
    const before = await monthToDateUsd(db, org.orgId, old);
    expect(before).toBeCloseTo(0.5, 4);
    const out = await sweepStaleKeywordRuns(db, { now });
    expect(out.failed).toBeGreaterThanOrEqual(2);
    for (const id of [run.id, running.run.id]) {
      const r = await reload(id);
      expect(r).toMatchObject({ status: "failed", error: "stale" });
      expect(Number(r.chargedUsd)).toBe(0);
    }
    expect(await monthToDateUsd(db, org.orgId, old)).toBe(0);
    const [spend] = await db.select().from(platformDfsSpend).where(eq(platformDfsSpend.id, run.spendId!));
    expect(Number(spend!.costUsd)).toBe(0);
    expect((await reload(fresh.run.id)).status).toBe("queued");
  });

  it("9. zero Labs rows is a failed run with no charge", async () => {
    const { run } = await mkRun({ dataSource: "live", withSpend: true, estimate: "5.0000", city: null });
    const empty: KeywordTransport = { ...fixtureKeywordTransport(), fixture: false, labs: async () => ({ items: [], costUsd: 0.012 }) };
    expect(await runKeywordResearch(db, run.id, { now: freshNow(), transport: empty })).toEqual({ outcome: "failed" });
    const r = await reload(run.id);
    expect(r).toMatchObject({ status: "failed", error: "no_rows" });
    expect(Number(r.chargedUsd)).toBe(0);
  });

  it("10. an Ads task failure sets the note and does not charge the Ads cost; no Ads slot is spent when Labs failed", async () => {
    const { run } = await mkRun({ dataSource: "live", withSpend: true, estimate: "5.0000" });
    const key = new Date().toISOString().slice(0, 16);
    const used = () => readCounter(db, "platform", ADS_COUNTER_KIND, key);
    const t0 = await used();
    await runKeywordResearch(db, run.id, { now: freshNow(), transport: costed({ sugg: 0.03, ideas: 0.02, ads: 0.09 }, { ads: true }) });
    const r = await reload(run.id);
    expect(r.localVolumeNote).toBe("local_volume_failed");
    expect(Number(r.providerCostUsd)).toBeCloseTo(0.05, 6);
    expect(await used()).toBe(t0 + 1);
    const second = await mkRun({ dataSource: "live", withSpend: true, estimate: "5.0000" });
    await runKeywordResearch(db, second.run.id, { now: freshNow(), alert: async () => undefined, transport: costed({ sugg: 0, ideas: 0, ads: 0.09 }, { sugg: true, ideas: true }) });
    expect(await used()).toBe(t0 + 1);
  });

  it("11. the sweep fails a run while its job is still working: the job's late settle changes nothing", async () => {
    const { run } = await mkRun({ dataSource: "live", withSpend: true, estimate: "5.0000", city: null });
    const t0 = freshNow();
    const fx = costed({ sugg: 0.03, ideas: 0.02, ads: 0 });
    const transport: KeywordTransport = {
      ...fx,
      labs: async (kind, q) => {
        if (kind === "suggestions") await sweepStaleKeywordRuns(db, { now: new Date(t0.getTime() + K.sweepRunningAfterMs + 60_000) });
        return fx.labs(kind, q);
      },
    };
    expect(await runKeywordResearch(db, run.id, { now: t0, transport })).toEqual({ outcome: "not_queued" });
    const r = await reload(run.id);
    expect(r).toMatchObject({ status: "failed", error: "stale" });
    expect(Number(r.chargedUsd)).toBe(0);
    expect(r.rows).toEqual([]);
    const [spend] = await db.select().from(platformDfsSpend).where(eq(platformDfsSpend.id, run.spendId!));
    expect(Number(spend!.costUsd)).toBe(0);
  });
});
