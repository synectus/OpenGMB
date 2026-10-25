import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql as dsql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  competitorProfileTasks,
  competitorProfiles,
  createDb,
  gridConfigs,
  gridPoints,
  gridRuns,
  gridTasks,
  orgGridSettings,
  platformDfsSpend,
} from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { createDriverRegistry } from "./geogrid/drivers";
import { GRID_COLLECT_QUEUE, GRID_RUN_QUEUE, markReceivedAndCollect, processGridCollect, processGridRun, requestGridRuns } from "./geogrid/run";
import { monthToDateUsd } from "./geogrid/cost";
import { collectCompetitorProfiles, refreshCompetitorProfiles } from "./competitors/refresh";
import { getCompetitorCategories } from "./competitors/categories";
import { fixtureProfileTransport, type ProfileTransport } from "./competitors/profiles";
import { codeOf, makeKit } from "./testkit";

// K2 part 2: competitor profiles are refreshed on their own schedule, charged like rank scans, and read back for K3 / L7.
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

async function runAll(configId: string): Promise<string[]> {
  const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
  const runs = await db.transaction((tx) => requestGridRuns(tx, { config: config!, requestedBy: null, audit: async () => {}, drivers: reg }));
  for (const r of runs) {
    await processGridRun(db, r.runId, { drivers: reg, pingbackBaseUrl: "https://worker.test" });
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
    competitorRefresh: "weekly",
  });
  await runAll(created.config.id);
  return { org, locationId: loc.row.id, google: loc.google, configId: created.config.id };
}

const spendRows = () => db.select().from(platformDfsSpend).where(eq(platformDfsSpend.kind, "competitor_profile")).then((r) => r.length);
const profilesOf = (orgId: string) => db.select().from(competitorProfiles).where(eq(competitorProfiles.orgId, orgId));
const tasksOf = (orgId: string) => db.select().from(competitorProfileTasks).where(eq(competitorProfileTasks.orgId, orgId));

describe("K2 part 2: profile refresh (fixture)", () => {
  it("stores categories, photos, rating and recent posts for the top 10, labelled fixture, and is not due again", async () => {
    const { org, configId } = await tracker();
    const spendBefore = await spendRows();
    const out = await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    expect(out).toMatchObject({ outcome: "submitted", skippedNoPlaceId: 0, chargedUsd: 0 });
    const rows = await profilesOf(org.orgId);
    // Denominator: something must have been fetched, capped at 10.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.every((r) => r.dataSource === "fixture" && r.categories.primary && r.totalPhotos !== null && r.postsCount !== null && r.rating !== null)).toBe(true);
    const tasks = await tasksOf(org.orgId);
    expect(tasks).toHaveLength(rows.length * 2);
    expect(tasks.every((t) => t.status === "done" && Number(t.chargedUsd) === 0)).toBe(true);
    // Fixture work spends nothing on our key.
    expect(await spendRows()).toBe(spendBefore);
    const [cfg] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
    expect(cfg!.competitorRefreshedAt).not.toBeNull();
    expect(await refreshCompetitorProfiles(db, configId, { source: "fixture" })).toEqual({ outcome: "not_due" });
  });

  it("does not fetch the same business twice in a day, even when the schedule is due again", async () => {
    const { org, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const n = (await tasksOf(org.orgId)).length;
    await db.update(gridConfigs).set({ competitorRefreshedAt: null }).where(eq(gridConfigs.id, configId));
    expect(await refreshCompetitorProfiles(db, configId, { source: "fixture" })).toMatchObject({ outcome: "nothing_to_fetch" });
    expect(await tasksOf(org.orgId)).toHaveLength(n);
  });

  it("a manual schedule turns the refresh off; a tracker with no scan from this source waits", async () => {
    const { configId } = await tracker();
    await db.update(gridConfigs).set({ competitorRefresh: "manual" }).where(eq(gridConfigs.id, configId));
    expect(await refreshCompetitorProfiles(db, configId, { source: "fixture" })).toEqual({ outcome: "not_due" });
    await db.update(gridConfigs).set({ competitorRefresh: "weekly" }).where(eq(gridConfigs.id, configId));
    // No live scan exists for this tracker.
    expect(await refreshCompetitorProfiles(db, configId, { source: "live", transport: fixtureProfileTransport() })).toEqual({ outcome: "no_scan_data" });
  });

  it("skips and counts top competitors that have no place id", async () => {
    const { org, configId } = await tracker();
    const [run] = await db.select().from(gridRuns).where(eq(gridRuns.configId, configId));
    const pts = await db.select().from(gridPoints).where(eq(gridPoints.runId, run!.id));
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      const comps = p.competitors as { rank: number; title: string | null; placeId: string | null; rating: number | null; isTarget: boolean }[];
      await db
        .update(gridPoints)
        .set({ competitors: [...comps, { rank: 1, title: "Nameless Dental", placeId: null, rating: 4, isTarget: false }] })
        .where(and(eq(gridPoints.runId, p.runId), eq(gridPoints.row, p.row), eq(gridPoints.col, p.col)));
    }
    const out = await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    // 9 points x 1 appearance each puts it in the top 10 whatever else is there.
    expect(out).toMatchObject({ outcome: "submitted", skippedNoPlaceId: 1 });
    const [cfg] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
    expect(cfg!.competitorSkippedNoPlaceId).toBe(1);
    expect((await profilesOf(org.orgId)).every((r) => r.title !== "Nameless Dental")).toBe(true);
  });
});

/** Make the tracker's stored scan count as a live one, and a transport that records its calls and reports a cost. */
async function liveTracker() {
  const t = await tracker();
  await db.update(gridRuns).set({ dataSource: "live" }).where(eq(gridRuns.configId, t.configId));
  const posts: { kind: string; ids: string[]; code: number }[] = [];
  const fx = fixtureProfileTransport();
  const transport: ProfileTransport = {
    async post(kind, ids, code) {
      posts.push({ kind, ids: [...ids], code });
      return ids.map((placeId) => ({ placeId, ref: `fixture:${kind}:${placeId}`, costUsd: kind === "info" ? 0.0015 : 0.00225 }));
    },
    get: fx.get,
  };
  return { ...t, posts, transport };
}

describe("K2 part 2: charging (live)", () => {
  it("charges cost + the org markup per accepted task, counts it in the monthly spend and on the platform ledger", async () => {
    const t = await liveTracker();
    const out = await refreshCompetitorProfiles(db, t.configId, { source: "live", transport: t.transport });
    expect(out.outcome).toBe("submitted");
    const tasks = await tasksOf(t.org.orgId);
    const n = tasks.length / 2;
    expect(n).toBeGreaterThan(0);
    expect(tasks.every((x) => x.dataSource === "live")).toBe(true);
    const providerTotal = tasks.reduce((s, x) => s + Number(x.providerCostUsd), 0);
    expect(providerTotal).toBeCloseTo(n * 0.00375, 6);
    const chargedTotal = tasks.reduce((s, x) => s + Number(x.chargedUsd), 0);
    // Default markup is 28%: 0.0015 x 1.28 = 0.00192, 0.00225 x 1.28 = 0.00288 (rounded up to 4 decimals each).
    expect(chargedTotal).toBeCloseTo(n * (0.0020 + 0.0029), 6);
    expect(await monthToDateUsd(db, t.org.orgId, new Date())).toBeCloseTo(chargedTotal, 6);
    // Our key's daily ledger carries the provider cost only.
    const spend = await db.select().from(platformDfsSpend).where(eq(platformDfsSpend.kind, "competitor_profile"));
    expect(spend.length).toBeGreaterThanOrEqual(n);
    // The audit row names what was done.
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, t.org.orgId), eq(auditLog.action, "geogrid.competitor_refresh")));
    expect(audit).toHaveLength(1);
    // The answers arrive later, from the sweep.
    expect(await profilesOf(t.org.orgId)).toHaveLength(0);
    const collected = await collectCompetitorProfiles(db, { transport: t.transport, orgIds: [t.org.orgId] });
    expect(collected).toMatchObject({ stored: tasks.length, failed: 0, pending: 0 });
    const rows = await profilesOf(t.org.orgId);
    expect(rows).toHaveLength(n);
    expect(rows.every((r) => r.dataSource === "live" && r.postsCount !== null && r.categories.primary)).toBe(true);
  });

  it("asks DataForSEO for the location of the tracked business's country (India 2356; no address falls back to the US 2840)", async () => {
    const t = await liveTracker();
    await refreshCompetitorProfiles(db, t.configId, { source: "live", transport: t.transport });
    expect(t.posts.map((p) => p.code)).toEqual([2840, 2840]); // the mock location has no address: fallback
    const india = await liveTracker();
    const g = (mock as unknown as { locations: { name: string; storefrontAddress?: unknown }[] }).locations.find((l) => l.name === india.google)!;
    g.storefrontAddress = { regionCode: "IN", locality: "Ahmedabad", addressLines: ["1 Ring Rd"] };
    await refreshCompetitorProfiles(db, india.configId, { source: "live", transport: india.transport });
    expect(india.posts.map((p) => p.code)).toEqual([2356, 2356]);
  });

  it("an org over its monthly budget makes no call, is audited, and retries next period", async () => {
    const t = await liveTracker();
    await db.insert(orgGridSettings).values({ orgId: t.org.orgId, monthlyBudgetUsd: "0.00", markupPercent: "28" });
    const out = await refreshCompetitorProfiles(db, t.configId, { source: "live", transport: t.transport, alert: async () => {} });
    expect(out).toEqual({ outcome: "skipped_limit" });
    expect(t.posts).toHaveLength(0);
    expect(await tasksOf(t.org.orgId)).toHaveLength(0);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, t.org.orgId), eq(auditLog.action, "geogrid.competitor_refresh_skipped")));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).toContain("budget_exceeded");
    const [cfg] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, t.configId));
    expect(cfg!.competitorRefreshedAt).not.toBeNull();
  });

  it("the platform daily cap stops the refresh before any call", async () => {
    const t = await liveTracker();
    await db.insert(platformDfsSpend).values({ kind: "test_fill", costUsd: "5.0000" });
    try {
      const out = await refreshCompetitorProfiles(db, t.configId, { source: "live", transport: t.transport, alert: async () => {} });
      expect(out).toEqual({ outcome: "skipped_limit" });
      expect(t.posts).toHaveLength(0);
    } finally {
      await db.delete(platformDfsSpend).where(eq(platformDfsSpend.kind, "test_fill"));
    }
  });
});

describe("K2 part 2: collect", () => {
  it("leaves a task that is not ready, stores it when ready, and fails one that never answers", async () => {
    const t = await liveTracker();
    await refreshCompetitorProfiles(db, t.configId, { source: "live", transport: t.transport });
    const notReady: ProfileTransport = { post: t.transport.post, get: async () => ({ state: "not_ready" }) };
    const tasks = await tasksOf(t.org.orgId);
    const first = await collectCompetitorProfiles(db, { transport: notReady, orgIds: [t.org.orgId] });
    expect(first).toMatchObject({ checked: tasks.length, stored: 0, failed: 0, pending: tasks.length });
    const late = new Date(Date.now() + 7 * 3_600_000);
    const gaveUp = await collectCompetitorProfiles(db, { transport: notReady, orgIds: [t.org.orgId], now: late });
    expect(gaveUp).toMatchObject({ stored: 0, failed: tasks.length });
    expect((await tasksOf(t.org.orgId)).every((x) => x.status === "failed" && x.error?.startsWith("no_result"))).toBe(true);
  });

  it("fails a task for a place DataForSEO does not know", async () => {
    const t = await liveTracker();
    await refreshCompetitorProfiles(db, t.configId, { source: "live", transport: t.transport });
    const empty: ProfileTransport = { post: t.transport.post, get: async () => ({ state: "ready", result: { items: [] } }) };
    const out = await collectCompetitorProfiles(db, { transport: empty, orgIds: [t.org.orgId] });
    expect(out.stored).toBeGreaterThan(0); // updates tasks store (0 posts)
    expect((await tasksOf(t.org.orgId)).filter((x) => x.kind === "info").every((x) => x.status === "failed" && x.error?.startsWith("not_found"))).toBe(true);
  });
});

describe("K2 part 2: getCompetitorCategories", () => {
  it("lists the categories the top competitors use, from one data source, scoped to the org", async () => {
    const { org, locationId, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const out = await getCompetitorCategories(db, org.orgId, locationId);
    expect(out.dataSource).toBe("fixture");
    expect(out.competitors.length).toBeGreaterThan(0);
    expect(out.categories.length).toBeGreaterThan(0);
    expect(out.categories[0]!.competitors).toBeGreaterThanOrEqual(out.categories.at(-1)!.competitors);
    const other = await kit.makeOrg();
    expect(await getCompetitorCategories(db, other.orgId, locationId)).toEqual({ dataSource: null, competitors: [], categories: [] });
  });

  it("K2c: a competitor with no paid profile still counts, with the categories from its scan", async () => {
    const { org, locationId } = await tracker(); // scans only: competitorRefresh never ran
    expect(await db.select().from(competitorProfiles).where(eq(competitorProfiles.orgId, org.orgId))).toHaveLength(0);
    const out = await getCompetitorCategories(db, org.orgId, locationId);
    expect(out.dataSource).toBe("fixture");
    expect(out.competitors.length).toBeGreaterThan(0); // denominator
    expect(out.competitors.every((c) => c.primary && c.ids.length > 0)).toBe(true);
    expect(out.categories.map((c) => c.name)).toContain("Dentist");
  });

  it("K2c: a paid profile wins over the scan categories for that competitor", async () => {
    const { org, locationId, configId } = await tracker();
    const before = await getCompetitorCategories(db, org.orgId, locationId);
    const first = before.competitors[0]!;
    await db.insert(competitorProfiles).values({
      orgId: org.orgId,
      placeId: first.placeId,
      fetchedOn: "2999-01-01",
      dataSource: "fixture",
      categories: { primary: "Profile Category", additional: [], ids: ["profile_category"] },
    });
    const out = await getCompetitorCategories(db, org.orgId, locationId);
    expect(out.competitors).toHaveLength(before.competitors.length);
    expect(out.competitors.find((c) => c.placeId === first.placeId)).toMatchObject({ primary: "Profile Category", additional: [] });
    expect(out.competitors.filter((c) => c.primary === "Profile Category")).toHaveLength(1);
    expect(configId).toBeTruthy();
  });

  it("K2c: scan categories of sample data are not mixed into a live result", async () => {
    const { org, locationId, configId } = await tracker(); // fixture scans carry categories
    const first = (await getCompetitorCategories(db, org.orgId, locationId)).competitors[0]!;
    // One live snapshot, newer, with no categories and no profile: nothing live to report, and no sample categories leak.
    await db.execute(dsql`insert into grid_competitor_snapshots (org_id, config_id, location_id, keyword, place_id, title, snapshot_date, data_source, appearances, avg_rank, best_rank)
      select ${org.orgId}::uuid, ${configId}::uuid, location_id, keyword, ${first.placeId}, ${first.title}, '2999-01-01', 'live', 4, 2.00, 1 from grid_competitor_snapshots where config_id = ${configId}::uuid limit 1`);
    const out = await getCompetitorCategories(db, org.orgId, locationId);
    expect(out.dataSource).toBe("live");
    expect(out.competitors).toEqual([]);
    expect(out.categories).toEqual([]);
  });

  it("never returns sample categories once a live snapshot is newer", async () => {
    const { org, locationId, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const fixtureOut = await getCompetitorCategories(db, org.orgId, locationId);
    const first = fixtureOut.competitors[0]!;
    // A live snapshot on a later day for one business, with its own profile.
    await db.execute(dsql`insert into grid_competitor_snapshots (org_id, config_id, location_id, keyword, place_id, title, snapshot_date, data_source, appearances, avg_rank, best_rank)
      select ${org.orgId}::uuid, ${configId}::uuid, location_id, keyword, ${first.placeId}, ${first.title}, '2999-01-01', 'live', 4, 2.00, 1 from grid_competitor_snapshots where config_id = ${configId}::uuid limit 1`);
    await db.insert(competitorProfiles).values({
      orgId: org.orgId,
      placeId: first.placeId,
      fetchedOn: "2999-01-01",
      dataSource: "live",
      categories: { primary: "Live Only Category", additional: [], ids: [] },
    });
    const out = await getCompetitorCategories(db, org.orgId, locationId);
    expect(out.dataSource).toBe("live");
    expect(out.categories.map((c) => c.name)).toEqual(["Live Only Category"]);
  });
});

type Profiles = {
  dataSource: string | null;
  refresh: { schedule: string; refreshedAt: string | null; skippedNoPlaceId: number; estimatedRefreshUsd: number | null };
  profiles: {
    placeId: string;
    primaryCategory: string | null;
    previousDate: string | null;
    recentPostsCount: number | null;
    totalPhotos: number | null;
    change: { photosAdded: number | null; categoriesAdded: string[]; categoriesRemoved: string[] } | null;
  }[];
};

describe("K2 part 2: geogrid.competitors.profiles", () => {
  it("lists the stored profiles; a second day of the same source gives photo and category changes", async () => {
    const { org, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const first = await kit.run<Profiles>(org.manager, "geogrid.competitors.profiles", { configId });
    expect(first.dataSource).toBe("fixture");
    expect(first.profiles.length).toBeGreaterThan(0);
    expect(first.profiles.every((p) => p.change === null && p.previousDate === null && p.primaryCategory)).toBe(true);
    expect(first.refresh).toMatchObject({ schedule: "weekly", skippedNoPlaceId: 0 });
    expect(first.refresh.refreshedAt).not.toBeNull();

    // Make that fetch "an older one" for one business (fewer photos, another category), then refresh again.
    const rows = await profilesOf(org.orgId);
    const keep = rows[0]!;
    await db.update(competitorProfiles).set({ fetchedOn: "2020-01-01", totalPhotos: (keep.totalPhotos ?? 0) - 9, categories: { primary: "Old Category", additional: [], ids: [] } }).where(eq(competitorProfiles.id, keep.id));
    await db.update(competitorProfileTasks).set({ submittedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(competitorProfileTasks.orgId, org.orgId));
    await db.update(gridConfigs).set({ competitorRefreshedAt: null }).where(eq(gridConfigs.id, configId));
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const second = await kit.run<Profiles>(org.manager, "geogrid.competitors.profiles", { configId });
    const p = second.profiles.find((x) => x.placeId === keep.placeId)!;
    expect(p.previousDate).toBe("2020-01-01");
    expect(p.change).toMatchObject({ photosAdded: 9, categoriesRemoved: ["Old Category"] });
    expect(p.change!.categoriesAdded).toContain(keep.categories.primary);
  });

  it("never shows or compares a profile of another data source", async () => {
    const { org, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    await db.update(competitorProfiles).set({ dataSource: "live" }).where(eq(competitorProfiles.orgId, org.orgId));
    const out = await kit.run<Profiles>(org.manager, "geogrid.competitors.profiles", { configId });
    expect(out.dataSource).toBe("fixture");
    expect(out.profiles).toEqual([]);
  });

  it("hides the refresh price from client roles but shows it to a manager; update changes the schedule", async () => {
    const { org, configId } = await tracker();
    const mgr = await kit.run<Profiles>(org.manager, "geogrid.competitors.profiles", { configId });
    expect(mgr.refresh.estimatedRefreshUsd).toBe(0.048);
    const viewer = await kit.run<Profiles>(org.viewerA, "geogrid.competitors.profiles", { configId });
    expect(viewer.refresh.estimatedRefreshUsd).toBeNull();
    const upd = await kit.run<{ config: { competitorRefresh: string; competitorRefreshEstimateUsd: number | null } }>(org.manager, "geogrid.configs.update", { id: configId, competitorRefresh: "manual" });
    expect(upd.config).toMatchObject({ competitorRefresh: "manual", competitorRefreshEstimateUsd: 0.048 });
    const list = await kit.run<{ configs: { competitorRefresh: string }[] }>(org.manager, "geogrid.configs.list", {});
    expect(list.configs.find((c) => c)!.competitorRefresh).toBe("manual");
    expect(await codeOf(kit.run(org.viewerA, "geogrid.configs.update", { id: configId, competitorRefresh: "daily" }))).not.toBe("no error");
  });
});

describe("K2 part 2: tenant scope of stored rows", () => {
  it("one org's profile refresh does not touch another org's tables", async () => {
    const a = await tracker();
    const b = await kit.makeOrg();
    await refreshCompetitorProfiles(db, a.configId, { source: "fixture" });
    expect(await profilesOf(b.orgId)).toHaveLength(0);
    expect(await tasksOf(b.orgId)).toHaveLength(0);
    expect(await codeOf(kit.run(b.manager, "geogrid.competitors.profiles", { configId: a.configId }))).toBe("NOT_FOUND");
  });
});

describe("K2: per-account default for the competitor refresh", () => {
  const body = (locationId: string) => ({ locationId, keywords: ["emergency dentist"], gridSize: 3, radiusM: 3000, centerLat: 29.4241, centerLng: -98.4936 });
  type Created = { config: { id: string; competitorRefresh: string } };
  type Settings = { defaultCompetitorRefresh: string; weeklyRefreshEstimateUsd: number };
  const defaultOf = async (table: string, column: string) => {
    const rows = (await db.execute(dsql`select column_default from information_schema.columns where table_name = ${table} and column_name = ${column}`)) as unknown as { column_default: string }[];
    return String(rows[0]!.column_default);
  };

  it("a new tracker is off when the account never chose, and both column defaults are off", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const s = await kit.run<Settings>(org.manager, "geogrid.settings.get", {});
    expect(s.defaultCompetitorRefresh).toBe("manual");
    expect(s.weeklyRefreshEstimateUsd).toBe(0.048);
    const made = await kit.run<Created>(org.manager, "geogrid.configs.create", body(loc.row.id));
    expect(made.config.competitorRefresh).toBe("manual");
    expect(await defaultOf("grid_configs", "competitor_refresh")).toContain("manual");
    expect(await defaultOf("org_grid_settings", "default_competitor_refresh")).toContain("manual");
  });

  it("a new tracker takes the weekly default, an explicit choice wins, and the setter is owner/admin only", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    expect(await codeOf(kit.run(org.manager, "geogrid.settings.update", { defaultCompetitorRefresh: "weekly" }))).not.toBe("no error");
    const set = await kit.run<Settings>(org.owner, "geogrid.settings.update", { defaultCompetitorRefresh: "weekly" });
    expect(set.defaultCompetitorRefresh).toBe("weekly");
    const inherited = await kit.run<Created>(org.manager, "geogrid.configs.create", body(loc.row.id));
    expect(inherited.config.competitorRefresh).toBe("weekly");
    const explicitOff = await kit.run<Created>(org.manager, "geogrid.configs.create", { ...body(loc.row.id), competitorRefresh: "manual" });
    expect(explicitOff.config.competitorRefresh).toBe("manual");
    await kit.run(org.owner, "geogrid.settings.update", { defaultCompetitorRefresh: "manual" });
    const explicitWeekly = await kit.run<Created>(org.manager, "geogrid.configs.create", { ...body(loc.row.id), competitorRefresh: "weekly" });
    expect(explicitWeekly.config.competitorRefresh).toBe("weekly");
  });

  it("changing the default leaves existing trackers as they were; client roles cannot read the settings", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const before = await kit.run<Created>(org.manager, "geogrid.configs.create", body(loc.row.id));
    await kit.run(org.owner, "geogrid.settings.update", { defaultCompetitorRefresh: "weekly" });
    const [row] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, before.config.id));
    expect(row!.competitorRefresh).toBe("manual");
    const [settings] = await db.select().from(orgGridSettings).where(eq(orgGridSettings.orgId, org.orgId));
    expect(settings!.defaultCompetitorRefresh).toBe("weekly");
    expect(await codeOf(kit.run(org.viewerA, "geogrid.settings.get", {}))).not.toBe("no error");
  });
});
