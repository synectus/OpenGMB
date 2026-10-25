import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, gridConfigs, gridPoints, gridRuns, gridTasks } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { createDriverRegistry, fixtureDataForSeoTransport } from "./geogrid/drivers";
import { enqueueDueGridRuns, GRID_COLLECT_QUEUE, GRID_RUN_QUEUE, markReceivedAndCollect, processGridCollect, processGridRun, requestGridRuns } from "./geogrid/run";
import { codeOf, makeKit, type Org } from "./testkit";

// K4: keyword rank tracking on the K1 machinery, with fixture data (no network, no cost).
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

const fixtureReg = createDriverRegistry();
const liveReg = createDriverRegistry({ source: () => "live", liveDataForSeo: () => fixtureDataForSeoTransport() });
const PINGBACK = "https://worker.test";
const CENTRE = { centerLat: 29.4241, centerLng: -98.4936 };

type Listed = {
  trackers: {
    configId: string;
    keywords: {
      keyword: string;
      favorite: boolean;
      latest: { date: string; localPackRank: number | null; organicRank: number | null; organicUrl: string | null; dataSource: string } | null;
      previous: unknown;
      history: { date: string }[];
    }[];
  }[];
};

/** Request, submit and collect every keyword of a config with the fixture source; returns the finished run ids. */
async function runAll(configId: string, reg = fixtureReg): Promise<string[]> {
  const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
  const runs = await db.transaction((tx) =>
    requestGridRuns(tx, { config: config!, requestedBy: null, audit: async () => {}, drivers: reg }),
  );
  for (const r of runs) {
    expect(await processGridRun(db, r.runId, { drivers: reg, pingbackBaseUrl: PINGBACK })).toBe("running");
    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, r.runId));
    expect(tasks).toHaveLength(1);
    // The sweeper path: same as a pingback arriving.
    await db.transaction((tx) => markReceivedAndCollect(tx, tasks[0]!.id));
    expect(await processGridCollect(db, tasks[0]!.id, { drivers: reg })).toBe("done");
  }
  return runs.map((r) => r.runId);
}

async function trackedOrg(): Promise<{ org: Org; locationId: string; configId: string }> {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  const out = await kit.run<{ configId: string; trackerCreated: boolean; keywordAdded: boolean }>(
    org.manager,
    "rankings.track",
    { locationId: loc.row.id, keyword: "emergency dentist", targetDomain: "https://www.Acme-Dental.example/contact", ...CENTRE },
  );
  expect(out).toMatchObject({ trackerCreated: true, keywordAdded: true });
  return { org, locationId: loc.row.id, configId: out.configId };
}

describe("K4: tracking a keyword", () => {
  it("creates the location's tracker once, adds keywords to it, and ignores a repeat", async () => {
    const { org, locationId, configId } = await trackedOrg();
    const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
    expect(config).toMatchObject({
      kind: "keyword_rank",
      driverId: "dataforseo_serp",
      gridSize: 1,
      schedule: "daily",
      targetDomain: "acme-dental.example",
      locationId,
    });
    const again = await kit.run<{ configId: string; trackerCreated: boolean; keywordAdded: boolean }>(
      org.manager,
      "rankings.track",
      { locationId, keyword: "Emergency Dentist" },
    );
    expect(again).toEqual({ configId, keyword: "Emergency Dentist", trackerCreated: false, keywordAdded: false });
    const more = await kit.run<{ configId: string; trackerCreated: boolean; keywordAdded: boolean }>(
      org.manager,
      "rankings.track",
      { locationId, keyword: "teeth whitening" },
    );
    expect(more).toMatchObject({ configId, trackerCreated: false, keywordAdded: true });
    const [after] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
    expect(after!.keywords).toEqual(["emergency dentist", "teeth whitening"]);
    expect(await kit.auditRows(org.orgId, "rankings.tracker_created")).toHaveLength(1);
  });

  it("needs coordinates the first time, and is for people who manage trackers", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    expect(await codeOf(kit.run(org.manager, "rankings.track", { locationId: loc.row.id, keyword: "dentist" }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.viewerA, "rankings.track", { locationId: loc.row.id, keyword: "dentist", ...CENTRE }))).toBe("FORBIDDEN");
  });

  it("keeps keyword trackers out of the geo-grid list and refuses geo-grid edits to them", async () => {
    const { org, configId } = await trackedOrg();
    const listed = await kit.run<{ configs: { id: string }[] }>(org.manager, "geogrid.configs.list", {});
    expect(listed.configs.map((c) => c.id)).not.toContain(configId);
    expect(await codeOf(kit.run(org.manager, "geogrid.configs.update", { id: configId, active: false }))).toBe("INVALID_INPUT");
  });
});

describe("K4: daily positions", () => {
  it("a fixture run stores the local pack and organic positions and the list shows them", async () => {
    const { org, configId } = await trackedOrg();
    await kit.run(org.manager, "rankings.track", { locationId: (await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId)))[0]!.locationId!, keyword: "zzz no such thing" });
    const runIds = await runAll(configId);
    expect(runIds).toHaveLength(2);
    // A fixture run is free and labelled as sample data.
    const runs = await db.select().from(gridRuns).where(eq(gridRuns.configId, configId));
    expect(runs.every((r) => r.dataSource === "fixture" && Number(r.costEstimateUsd) === 0 && r.status === "done")).toBe(true);
    const points = await db.select().from(gridPoints).where(eq(gridPoints.orgId, org.orgId));
    expect(points).toHaveLength(2);

    const listed = await kit.run<Listed>(org.manager, "rankings.list", {});
    const t = listed.trackers.find((x) => x.configId === configId)!;
    const hit = t.keywords.find((k) => k.keyword === "emergency dentist")!;
    expect(hit.latest).toMatchObject({ dataSource: "fixture" });
    expect(hit.latest!.localPackRank).toBeGreaterThanOrEqual(1);
    expect(hit.latest!.localPackRank).toBeLessThanOrEqual(3);
    expect(hit.latest!.organicRank).toBeGreaterThanOrEqual(1);
    expect(hit.latest!.organicUrl).toMatch(/^https:\/\/acme-dental\.example\//);
    const miss = t.keywords.find((k) => k.keyword === "zzz no such thing")!;
    expect(miss.latest).toMatchObject({ localPackRank: null, organicRank: null });
  });

  it("keeps one reading per day, oldest first, with the previous one alongside", async () => {
    const { org, configId } = await trackedOrg();
    const [first] = await runAll(configId);
    // Yesterday's check, then today's.
    await db.update(gridRuns).set({ createdAt: new Date(Date.now() - 86_400_000) }).where(eq(gridRuns.id, first!));
    await runAll(configId);
    await runAll(configId); // a second check today replaces the first of the day
    const listed = await kit.run<Listed>(org.manager, "rankings.list", {});
    const k = listed.trackers.find((x) => x.configId === configId)!.keywords[0]!;
    expect(k.history).toHaveLength(2);
    expect(k.history[0]!.date < k.history[1]!.date).toBe(true);
    expect(k.previous).toEqual(k.history[0]);
    expect(k.latest).toEqual(k.history[1]);
    const short = await kit.run<Listed>(org.manager, "rankings.list", { days: 1 });
    expect(short.trackers.find((x) => x.configId === configId)!.keywords[0]!.history).toHaveLength(1);
  });

  it("the daily schedule queues a check for every keyword, once per day", async () => {
    const { org, configId } = await trackedOrg();
    await kit.run(org.manager, "rankings.track", { locationId: (await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId)))[0]!.locationId!, keyword: "dental implants" });
    const now = new Date();
    const first = await enqueueDueGridRuns(db, { drivers: fixtureReg, now, orgIds: [org.orgId] });
    expect(first).toMatchObject({ enqueued: 1, skippedBudget: 0 });
    expect(await db.select().from(gridRuns).where(eq(gridRuns.configId, configId))).toHaveLength(2);
    const second = await enqueueDueGridRuns(db, { drivers: fixtureReg, now: new Date(now.getTime() + 3_600_000), orgIds: [org.orgId] });
    expect(second.enqueued).toBe(0);
  });

  it("a live-source run is priced as one Google search at cost plus the markup", async () => {
    const { configId } = await trackedOrg();
    const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
    const runs = await db.transaction((tx) =>
      requestGridRuns(tx, { config: config!, requestedBy: null, audit: async () => {}, drivers: liveReg }),
    );
    const [run] = await db.select().from(gridRuns).where(eq(gridRuns.id, runs[0]!.runId));
    // 2 SERP pages x $0.0006 = $0.0012 from DataForSEO; x 1.28 rounded up to 4 decimals.
    expect(Number(run!.providerEstimateUsd)).toBeCloseTo(0.0012, 6);
    expect(Number(run!.costEstimateUsd)).toBeCloseTo(0.0016, 6);
    expect(run).toMatchObject({ dataSource: "live", driverId: "dataforseo_serp" });
  });
});

describe("K4: favourites and removal", () => {
  it("stars a keyword (listed first) and removes keywords; the last removal deletes the tracker", async () => {
    const { org, locationId, configId } = await trackedOrg();
    await kit.run(org.manager, "rankings.track", { locationId, keyword: "teeth whitening" });
    await kit.run(org.manager, "rankings.setFavorite", { configId, keyword: "Teeth Whitening", favorite: true });
    let listed = await kit.run<Listed>(org.manager, "rankings.list", { locationId });
    expect(listed.trackers[0]!.keywords.map((k) => [k.keyword, k.favorite])).toEqual([
      ["teeth whitening", true],
      ["emergency dentist", false],
    ]);
    expect(await codeOf(kit.run(org.manager, "rankings.setFavorite", { configId, keyword: "nope", favorite: true }))).toBe("INVALID_INPUT");

    await kit.run(org.manager, "rankings.untrack", { configId, keyword: "teeth whitening" });
    const [kept] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
    expect(kept).toMatchObject({ keywords: ["emergency dentist"], favoriteKeywords: [] });
    await kit.run(org.manager, "rankings.untrack", { configId, keyword: "emergency dentist" });
    expect(await db.select().from(gridConfigs).where(and(eq(gridConfigs.id, configId)))).toHaveLength(0);
    listed = await kit.run<Listed>(org.manager, "rankings.list", { locationId });
    expect(listed.trackers).toHaveLength(0);
  });

  it("clients can read positions but not change what is tracked", async () => {
    const { org, configId } = await trackedOrg();
    expect((await kit.run<Listed>(org.viewerA, "rankings.list", {})).trackers.length).toBeGreaterThanOrEqual(0);
    expect(await codeOf(kit.run(org.viewerA, "rankings.untrack", { configId, keyword: "emergency dentist" }))).toBe("FORBIDDEN");
  });
});
