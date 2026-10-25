import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql as dsql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  performanceDaily,
  performanceSnapshots,
  searchKeywordsMonthly,
} from "@opengmb/db";
import { verifyAuditChain } from "./audit";
import { PERFORMANCE_CONFIG } from "./config/performance";
import { executeAction } from "./executor";
import { DAILY_METRICS } from "./google/client";
import { MockGoogleClient } from "./google/mock-client";
import { subtractMonths } from "./performance/dates";
import {
  enqueueNightlySnapshots,
  PERFORMANCE_SNAPSHOT_QUEUE,
  processPerformanceSnapshot,
} from "./performance/snapshot";
import type { Actor } from "./actor";
import { codeOf, db, makeOrg, putDaily, putKeywords, sql, type Org } from "./performance-fixture";

const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T10:00:00Z");
const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

let org: Org;
let other: Org;

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(PERFORMANCE_SNAPSHOT_QUEUE);
  org = await makeOrg();
  other = await makeOrg();
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

const count = async (table: typeof performanceDaily | typeof searchKeywordsMonthly, id: string) => {
  const [r] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.locationId, id));
  return r!.n;
};

describe("snapshots (PR1)", () => {
  it("first run backfills the configured retention window; later runs fetch only recent days", async () => {
    const client = new MockGoogleClient();
    const loc = org.locA1;
    const first = await processPerformanceSnapshot(
      db,
      { locationId: loc.id },
      { client, now: NOW },
    );
    const from = subtractMonths("2026-10-11", PERFORMANCE_CONFIG.retentionMonths.value);
    expect(from).toBe("2025-04-11");
    expect(first).toMatchObject({ status: "done", backfill: true, from, to: "2026-10-11" });
    const daily = client.calls.find((c) => c.method === "fetchDailyMetrics")!;
    expect(daily.args).toEqual([loc.googleLocationId, DAILY_METRICS, from, "2026-10-11"]);
    const days = 365 + 184; // 2025-04-11..2026-10-11 inclusive
    expect(await count(performanceDaily, loc.id)).toBe(days * DAILY_METRICS.length);
    const kwCalls = client.calls.filter((c) => c.method === "listMonthlySearchKeywords");
    expect(new Set(kwCalls.map((c) => (c.args as string[])[1])).size).toBe(18);
    expect((await count(searchKeywordsMonthly, loc.id)) > 18).toBe(true);

    const client2 = new MockGoogleClient();
    const second = await processPerformanceSnapshot(
      db,
      { locationId: loc.id },
      { client: client2, now: new Date("2026-10-13T03:00:00Z") },
    );
    expect(second).toMatchObject({ status: "done", backfill: false });
    const d2 = client2.calls.find((c) => c.method === "fetchDailyMetrics")!;
    expect((d2.args as string[]).slice(2)).toEqual(["2026-10-10", "2026-10-12"]);
    expect(PERFORMANCE_CONFIG.refreshDays).toBe(3);
    const kw2 = client2.calls.filter((c) => c.method === "listMonthlySearchKeywords");
    expect(kw2).toHaveLength(1);
    expect((kw2[0]!.args as string[])[1]).toBe("2026-09");
  });

  it("is idempotent (re-running changes no row counts) and overwrites with Google's current values", async () => {
    const loc = org.locA2;
    const client = new MockGoogleClient();
    await processPerformanceSnapshot(db, { locationId: loc.id }, { client, now: NOW });
    const before = [
      await count(performanceDaily, loc.id),
      await count(searchKeywordsMonthly, loc.id),
    ];
    await processPerformanceSnapshot(db, { locationId: loc.id }, { client, now: NOW });
    await processPerformanceSnapshot(
      db,
      { locationId: loc.id, backfill: true },
      { client, now: NOW },
    );
    expect([
      await count(performanceDaily, loc.id),
      await count(searchKeywordsMonthly, loc.id),
    ]).toEqual(before);

    // Google revises a recent day: the stored value follows.
    await db
      .update(performanceDaily)
      .set({ value: 99999 })
      .where(and(eq(performanceDaily.locationId, loc.id), eq(performanceDaily.date, "2026-10-11")));
    await processPerformanceSnapshot(db, { locationId: loc.id }, { client, now: NOW });
    const [r] = await db
      .select({ v: performanceDaily.value })
      .from(performanceDaily)
      .where(and(eq(performanceDaily.locationId, loc.id), eq(performanceDaily.date, "2026-10-11")));
    expect(r!.v).not.toBe(99999);
  });

  it("skips inactive locations without calling Google, and keeps old rows when a location goes inactive", async () => {
    const client = new MockGoogleClient();
    const r = await processPerformanceSnapshot(
      db,
      { locationId: org.locAOff.id },
      { client, now: NOW },
    );
    expect(r).toEqual({ status: "skipped", reason: "location_inactive" });
    expect(client.callCount).toBe(0);
    expect(await count(performanceDaily, org.locAOff.id)).toBe(0);

    await enqueueNightlySnapshots(db, { orgIds: [org.orgId] });
    const jobs = await sql<{ id: string }[]>`
      select id from pgboss.job where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' = ${org.locAOff.id}`;
    expect(jobs).toHaveLength(0);
  });

  it("nightly fan-out queues one job per active linked location and audits counts only", async () => {
    const fresh = await makeOrg();
    const res = await enqueueNightlySnapshots(db, { orgIds: [fresh.orgId] });
    expect(res.enqueued).toBe(3);
    const ids = [fresh.locA1.id, fresh.locA2.id, fresh.locB.id];
    for (const id of ids) {
      const jobs = await sql<{ id: string }[]>`
        select id from pgboss.job where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' = ${id}`;
      expect(jobs).toHaveLength(1);
    }
    await processPerformanceSnapshot(
      db,
      { locationId: fresh.locB.id },
      { client: new MockGoogleClient(), now: NOW },
    );
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, fresh.orgId), eq(auditLog.action, "performance.snapshot_completed")),
      );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!.after as object).sort()).toEqual(
      ["backfill", "dailyRows", "from", "keywordRows", "to"].sort(),
    );
    expect(rows[0]).toMatchObject({ actorType: "system", surface: "worker" });
    const [snap] = await db
      .select()
      .from(performanceSnapshots)
      .where(eq(performanceSnapshots.locationId, fresh.locB.id));
    expect(snap!.lastSnapshotDate).toBe("2026-10-11");
    expect((await verifyAuditChain(db, fresh.orgId)).ok).toBe(true);
  }, 30_000);

  it("performance.backfill queues a backfill job, audited, manage-only and in scope", async () => {
    const r = (await run(org.manager, "performance.backfill", { locationId: org.locA1.id })) as {
      jobId: string;
    };
    const jobs = await sql<{ id: string; data: { backfill?: boolean } }[]>`
      select id, data from pgboss.job where id = ${r.jobId}`;
    expect(jobs[0]!.data.backfill).toBe(true);
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.orgId, org.orgId));
    expect(audits.map((a) => a.action)).toContain("performance.backfill_requested");
    expect(
      await codeOf(run(org.viewerA, "performance.backfill", { locationId: org.locA1.id })),
    ).toMatch(/^FORBIDDEN/);
    expect(
      await codeOf(run(org.manager, "performance.backfill", { locationId: org.locAOff.id })),
    ).toMatch(/^CONFLICT/);
    expect(
      await codeOf(run(other.manager, "performance.backfill", { locationId: org.locA1.id })),
    ).toMatch(/^NOT_FOUND/);
  });
});

type Summary = {
  hasData: boolean;
  locationCount: number;
  previousFrom: string;
  previousTo: string;
  kpis: {
    key: string;
    total: number;
    previousTotal: number;
    delta: number;
    deltaPct: number | null;
  }[];
  metrics: { metric: string; total: number }[];
  series: { key: string; points: { date: string; value: number }[] }[];
};

describe("performance.summary / performance.keywords (PR2)", () => {
  let o: Org;
  beforeAll(async () => {
    o = await makeOrg();
    await putDaily(o.orgId, o.locA1.id, [
      ["2026-09-08", "CALL_CLICKS", 10],
      ["2026-09-10", "CALL_CLICKS", 5],
      ["2026-09-02", "CALL_CLICKS", 5],
      ["2026-09-09", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 100],
      ["2026-09-09", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", 50],
      ["2026-09-12", "WEBSITE_CLICKS", 4],
      ["2026-09-03", "BUSINESS_DIRECTION_REQUESTS", 8],
    ]);
    await putDaily(o.orgId, o.locA2.id, [["2026-09-08", "CALL_CLICKS", 5]]);
    await putDaily(o.orgId, o.locB.id, [["2026-09-08", "CALL_CLICKS", 1000]]);
  });
  const kpi = (s: Summary, key: string) => s.kpis.find((k) => k.key === key)!;
  const input = { from: "2026-09-08", to: "2026-09-14" };

  it("sums per workspace, compares with the previous equal-length period, zero-fills the series", async () => {
    const s = (await run(o.owner, "performance.summary", {
      workspaceId: o.wsA,
      ...input,
    })) as Summary;
    expect(s).toMatchObject({
      hasData: true,
      locationCount: 3,
      previousFrom: "2026-09-01",
      previousTo: "2026-09-07",
    });
    expect(kpi(s, "calls")).toMatchObject({ total: 20, previousTotal: 5, delta: 15, deltaPct: 3 });
    expect(kpi(s, "impressionsMaps").total).toBe(100);
    expect(kpi(s, "impressionsSearch").total).toBe(50);
    expect(kpi(s, "impressionsTotal").total).toBe(150);
    expect(kpi(s, "websiteClicks")).toMatchObject({
      total: 4,
      previousTotal: 0,
      delta: 4,
      deltaPct: null,
    });
    expect(kpi(s, "directions")).toMatchObject({
      total: 0,
      previousTotal: 8,
      delta: -8,
      deltaPct: -1,
    });
    expect(s.metrics).toHaveLength(DAILY_METRICS.length);
    const calls = s.series.find((x) => x.key === "calls")!.points;
    expect(calls).toHaveLength(7);
    expect(calls.map((p) => p.value)).toEqual([15, 0, 5, 0, 0, 0, 0]);
  });

  it("accepts locationIds, includes inactive locations' history, reports hasData=false when empty", async () => {
    const s = (await run(o.owner, "performance.summary", {
      locationIds: [o.locA1.id],
      ...input,
    })) as Summary;
    expect(kpi(s, "calls").total).toBe(15);
    const empty = (await run(o.owner, "performance.summary", {
      locationIds: [o.locAOff.id],
      ...input,
    })) as Summary;
    expect(empty.hasData).toBe(false);
    expect(kpi(empty, "calls")).toMatchObject({ total: 0, deltaPct: null });
  });

  it("validates input and enforces roles and tenancy", async () => {
    expect(await codeOf(run(o.owner, "performance.summary", { ...input }))).toMatch(
      /^INVALID_INPUT/,
    );
    expect(
      await codeOf(
        run(o.owner, "performance.summary", {
          workspaceId: o.wsA,
          locationIds: [o.locA1.id],
          ...input,
        }),
      ),
    ).toMatch(/^INVALID_INPUT/);
    expect(
      await codeOf(
        run(o.owner, "performance.summary", {
          workspaceId: o.wsA,
          from: "2026-09-14",
          to: "2026-09-08",
        }),
      ),
    ).toMatch(/^INVALID_INPUT/);
    expect(
      await codeOf(
        run(o.owner, "performance.summary", {
          workspaceId: o.wsA,
          from: "2024-01-01",
          to: "2026-09-08",
        }),
      ),
    ).toMatch(/^INVALID_INPUT/);
    expect(
      await codeOf(
        run(o.owner, "performance.summary", {
          workspaceId: o.wsA,
          from: "2026-13-01",
          to: "2026-09-08",
        }),
      ),
    ).toMatch(/^INVALID_INPUT/);
    // viewers can read their own workspace only
    expect(
      await codeOf(run(o.viewerA, "performance.summary", { workspaceId: o.wsA, ...input })),
    ).toBe("no error");
    expect(
      await codeOf(run(o.viewerA, "performance.summary", { workspaceId: o.wsB, ...input })),
    ).toMatch(/^FORBIDDEN/);
    expect(
      await codeOf(run(o.viewerA, "performance.summary", { locationIds: [o.locB.id], ...input })),
    ).toMatch(/^NOT_FOUND/);
    // another org never sees these ids
    expect(
      await codeOf(run(other.owner, "performance.summary", { workspaceId: o.wsA, ...input })),
    ).toMatch(/^NOT_FOUND/);
    expect(
      await codeOf(
        run(other.owner, "performance.summary", { locationIds: [o.locA1.id], ...input }),
      ),
    ).toMatch(/^NOT_FOUND/);
  });

  it("keywords: sums known values, marks months Google hid as a lower bound", async () => {
    await putKeywords(o.orgId, o.locA1.id, [
      ["2026-08-01", "dentist", 40, null],
      ["2026-09-01", "dentist", 60, null],
      ["2026-09-01", "rare term", null, 15],
      ["2026-08-01", "mixed", 20, null],
      ["2026-09-01", "mixed", null, 15],
      ["2026-07-01", "old", 500, null],
    ]);
    await putKeywords(o.orgId, o.locA2.id, [["2026-09-01", "dentist", 10, null]]);
    const r = (await run(o.owner, "performance.keywords", {
      workspaceId: o.wsA,
      months: 2,
      endMonth: "2026-09",
    })) as {
      months: string[];
      keywords: { keyword: string; value: number; isLowerBound: boolean; hiddenBelow: number }[];
    };
    expect(r.months).toEqual(["2026-08", "2026-09"]);
    expect(r.keywords.map((k) => k.keyword)).toEqual(["dentist", "mixed", "rare term"]);
    expect(r.keywords[0]).toEqual({
      keyword: "dentist",
      value: 110,
      isLowerBound: false,
      hiddenBelow: 0,
    });
    expect(r.keywords[1]).toEqual({
      keyword: "mixed",
      value: 20,
      isLowerBound: true,
      hiddenBelow: 15,
    });
    expect(r.keywords[2]).toEqual({
      keyword: "rare term",
      value: 0,
      isLowerBound: true,
      hiddenBelow: 15,
    });
    expect(await codeOf(run(other.owner, "performance.keywords", { workspaceId: o.wsA }))).toMatch(
      /^NOT_FOUND/,
    );
    expect(await codeOf(run(o.viewerB, "performance.keywords", { workspaceId: o.wsA }))).toMatch(
      /^FORBIDDEN/,
    );
  });

  it("the database refuses a keyword row with both or neither of value and threshold", async () => {
    await expect(
      putKeywords(o.orgId, o.locA1.id, [["2026-09-01", "both", 1, 15]]),
    ).rejects.toThrow();
    await expect(
      putKeywords(o.orgId, o.locA1.id, [["2026-09-01", "neither", null, null]]),
    ).rejects.toThrow();
  });
});
