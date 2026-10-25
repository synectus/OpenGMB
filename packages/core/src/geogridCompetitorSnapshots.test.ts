import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, gridCompetitorSnapshots, gridConfigs, gridTasks } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { createDriverRegistry } from "./geogrid/drivers";
import { GRID_COLLECT_QUEUE, GRID_RUN_QUEUE, markReceivedAndCollect, processGridCollect, processGridRun, requestGridRuns } from "./geogrid/run";
import { codeOf, makeKit } from "./testkit";

// K2 part 1: competitors of a finished tracker run are stored per day and diffed against the day before (fixture data).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const boss = new PgBoss(url);
beforeAll(async () => {
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  setSharedMockGoogleClient(null);
  await kit.deactivateAll();
  await sql.end();
});

const reg = createDriverRegistry();
const PINGBACK = "https://worker.test";

type Changes = {
  keywords: {
    keyword: string;
    currentDate: string;
    previousDate: string | null;
    dataSource: string;
    competitors: { placeId: string; title: string; status: string; rankChange: number | null; reviewsAdded: number | null }[];
  }[];
};

/** Request, submit and collect every point of a config's runs with the fixture source. */
async function runAll(configId: string): Promise<string[]> {
  const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
  const runs = await db.transaction((tx) =>
    requestGridRuns(tx, { config: config!, requestedBy: null, audit: async () => {}, drivers: reg }),
  );
  for (const r of runs) {
    expect(await processGridRun(db, r.runId, { drivers: reg, pingbackBaseUrl: PINGBACK })).toBe("running");
    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, r.runId));
    for (const t of tasks) {
      await db.transaction((tx) => markReceivedAndCollect(tx, t.id));
      expect(await processGridCollect(db, t.id, { drivers: reg })).toBe("done");
    }
  }
  return runs.map((r) => r.runId);
}

async function tracker() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  const created = await kit.run<{ config: { id: string } }>(org.manager, "geogrid.configs.create", {
    locationId: loc.row.id,
    keywords: ["emergency dentist"],
    gridSize: 3,
    radiusM: 3000,
    centerLat: 29.4241,
    centerLng: -98.4936,
  });
  return { org, configId: created.config.id };
}

describe("K2: competitor snapshots", () => {
  it("stores the competitors of a finished run, and a same-day rerun replaces them", async () => {
    const { org, configId } = await tracker();
    const [runId] = await runAll(configId);
    const rows = await db.select().from(gridCompetitorSnapshots).where(eq(gridCompetitorSnapshots.configId, configId));
    // Denominator: the fixture must produce competitors, or this test would pass on nothing.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.runId === runId && r.orgId === org.orgId && r.keyword === "emergency dentist")).toBe(true);
    expect(new Set(rows.map((r) => r.placeId)).size).toBe(rows.length);
    await runAll(configId);
    const again = await db.select().from(gridCompetitorSnapshots).where(eq(gridCompetitorSnapshots.configId, configId));
    expect(again).toHaveLength(rows.length);
    expect(again.every((r) => r.runId !== runId)).toBe(true);
  });

  it("K2c: stores the categories Google returned with each competitor", async () => {
    const { configId } = await tracker();
    await runAll(configId);
    const rows = await db.select().from(gridCompetitorSnapshots).where(eq(gridCompetitorSnapshots.configId, configId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.category && r.additionalCategories !== null && (r.categoryIds ?? []).length > 0)).toBe(true);
  });

  it("changes: first day shows no new businesses; with a previous day it shows rank, reviews and new/dropped", async () => {
    const { org, configId } = await tracker();
    await runAll(configId);
    const first = await kit.run<Changes>(org.manager, "geogrid.competitors.changes", { configId });
    expect(first.keywords).toHaveLength(1);
    expect(first.keywords[0]).toMatchObject({ keyword: "emergency dentist", previousDate: null });
    expect(first.keywords[0]!.competitors.length).toBeGreaterThan(0);
    expect(first.keywords[0]!.competitors.every((c) => c.status === "continuing")).toBe(true);

    // Make today's snapshot "yesterday": older numbers for one business, plus one that is no longer there.
    const snap = await db.select().from(gridCompetitorSnapshots).where(eq(gridCompetitorSnapshots.configId, configId));
    const keep = snap[0]!;
    await db
      .update(gridCompetitorSnapshots)
      .set({ snapshotDate: "2020-01-01" })
      .where(eq(gridCompetitorSnapshots.configId, configId));
    await db
      .update(gridCompetitorSnapshots)
      .set({ avgRank: (Number(keep.avgRank) + 2).toFixed(2), reviewCount: (keep.reviewCount ?? 10) - 7 })
      .where(and(eq(gridCompetitorSnapshots.configId, configId), eq(gridCompetitorSnapshots.id, keep.id)));
    await db.insert(gridCompetitorSnapshots).values({
      orgId: org.orgId,
      configId,
      locationId: keep.locationId,
      keyword: "emergency dentist",
      placeId: "ghost-place",
      title: "Ghost Dental",
      snapshotDate: "2020-01-01",
      dataSource: "fixture",
      appearances: 2,
      avgRank: "4.00",
      bestRank: 3,
    });
    await runAll(configId);

    const out = await kit.run<Changes>(org.manager, "geogrid.competitors.changes", { configId, keyword: "emergency dentist" });
    const k = out.keywords[0]!;
    expect(k.previousDate).toBe("2020-01-01");
    const byId = new Map(k.competitors.map((c) => [c.placeId, c]));
    expect(byId.get("ghost-place")).toMatchObject({ status: "dropped", rankChange: null });
    expect(byId.get(keep.placeId)).toMatchObject({ status: "continuing", rankChange: 2 });
    if (keep.reviewCount !== null) expect(byId.get(keep.placeId)!.reviewsAdded).toBe(7);
    expect(k.competitors.some((c) => c.status === "new")).toBe(false);
  });

  it("never compares across data sources: an older fixture snapshot is not the baseline for a live one", async () => {
    const { org, configId } = await tracker();
    await runAll(configId);
    const snap = await db.select().from(gridCompetitorSnapshots).where(eq(gridCompetitorSnapshots.configId, configId));
    expect(snap.every((r) => r.dataSource === "fixture")).toBe(true);
    // Yesterday was fixture data; today is a live run with different businesses.
    await db.update(gridCompetitorSnapshots).set({ snapshotDate: "2020-01-01" }).where(eq(gridCompetitorSnapshots.configId, configId));
    await db.insert(gridCompetitorSnapshots).values({
      orgId: org.orgId,
      configId,
      locationId: snap[0]!.locationId,
      keyword: "emergency dentist",
      placeId: "live-place",
      title: "Real Dental",
      snapshotDate: "2020-01-02",
      dataSource: "live",
      appearances: 4,
      avgRank: "2.00",
      bestRank: 1,
    });
    const out = await kit.run<Changes>(org.manager, "geogrid.competitors.changes", { configId });
    const k = out.keywords[0]!;
    expect(k).toMatchObject({ dataSource: "live", currentDate: "2020-01-02", previousDate: null });
    expect(k.competitors.map((c) => [c.placeId, c.status])).toEqual([["live-place", "continuing"]]);
  });

  it("is tenant-scoped", async () => {
    const a = await tracker();
    const b = await kit.makeOrg();
    await runAll(a.configId);
    expect(await codeOf(kit.run(b.manager, "geogrid.competitors.changes", { configId: a.configId }))).toBe("NOT_FOUND");
  });
});
