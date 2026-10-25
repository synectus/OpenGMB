import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, gridConfigs, gridTasks } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { createDriverRegistry } from "./geogrid/drivers";
import { GRID_COLLECT_QUEUE, GRID_RUN_QUEUE, markReceivedAndCollect, processGridCollect, processGridRun, requestGridRuns } from "./geogrid/run";
import { refreshCompetitorProfiles } from "./competitors/refresh";
import { codeOf, makeKit } from "./testkit";

// K3: category suggestions from competitor data; adding one records a change set that waits for approval.
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

async function scan(configId: string) {
  const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, configId));
  const runs = await db.transaction((tx) => requestGridRuns(tx, { config: config!, requestedBy: null, audit: async () => {}, drivers: reg }));
  for (const r of runs) {
    await processGridRun(db, r.runId, { drivers: reg, pingbackBaseUrl: "https://worker.test" });
    for (const t of await db.select().from(gridTasks).where(eq(gridTasks.runId, r.runId))) {
      await db.transaction((tx) => markReceivedAndCollect(tx, t.id));
      expect(await processGridCollect(db, t.id, { drivers: reg })).toBe("done");
    }
  }
}

async function tracker(opts: { scan?: boolean } = {}) {
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
  if (opts.scan !== false) await scan(created.config.id);
  return { org, loc, configId: created.config.id };
}

type Suggestions = {
  status: string;
  dataSource: string | null;
  competitorCount: number;
  ownCategories: string[];
  display: { regionCode: string; languageCode: string };
  suggestions: { name: string; competitors: number; asPrimary: number; evidence: { placeId: string; title: string; rank: number; appearances: number; isPrimary: boolean }[] }[];
};

describe("K3: profile.categories.suggestions", () => {
  it("says no_competitor_data before any scan, with the location's own categories", async () => {
    const { org, loc } = await tracker({ scan: false });
    const out = await kit.run<Suggestions>(org.manager, "profile.categories.suggestions", { locationId: loc.row.id });
    expect(out).toMatchObject({ status: "no_competitor_data", competitorCount: 0, suggestions: [] });
    expect(out.ownCategories).toEqual(["Dentist"]);
  });

  it("suggests from scan categories alone, with no competitor refresh (K2c)", async () => {
    const { org, loc } = await tracker();
    const out = await kit.run<Suggestions>(org.manager, "profile.categories.suggestions", { locationId: loc.row.id });
    expect(out.status).toBe("ok");
    expect(out.competitorCount).toBeGreaterThan(0);
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  it("lists categories competitors use and the location lacks, each with competitor evidence", async () => {
    const { org, loc, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const out = await kit.run<Suggestions>(org.manager, "profile.categories.suggestions", { locationId: loc.row.id });
    expect(out.status).toBe("ok");
    expect(out.dataSource).toBe("fixture");
    // Denominator: something was inspected.
    expect(out.competitorCount).toBeGreaterThan(0);
    expect(out.suggestions.length).toBeGreaterThan(0);
    expect(out.suggestions.length).toBeLessThanOrEqual(10);
    for (const s of out.suggestions) {
      expect(s.name.toLowerCase()).not.toBe("dentist");
      expect(s.competitors).toBe(s.evidence.length);
      expect(s.competitors).toBeGreaterThan(0);
      expect(s.evidence.every((e) => e.title && e.rank >= 1 && e.rank <= out.competitorCount)).toBe(true);
    }
    const counts = out.suggestions.map((s) => s.competitors);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("is NOT_FOUND for a location of another org", async () => {
    const { loc } = await tracker();
    const other = await kit.makeOrg();
    expect(await codeOf(kit.run(other.owner, "profile.categories.suggestions", { locationId: loc.row.id }))).toBe("NOT_FOUND");
  });

  it("adding a suggestion creates a pending change set and writes nothing to Google", async () => {
    const { org, loc, configId } = await tracker();
    await refreshCompetitorProfiles(db, configId, { source: "fixture" });
    const out = await kit.run<Suggestions>(org.manager, "profile.categories.suggestions", { locationId: loc.row.id });
    const pick = out.suggestions[0]!;
    const found = await kit.run<{ categories: { name: string; displayName: string }[] }>(org.manager, "profile.categories.search", {
      locationId: loc.row.id,
      ...out.display,
      query: pick.name,
    });
    const match = found.categories.find((c) => c.displayName.toLowerCase() === pick.name.toLowerCase());
    expect(match).toBeDefined();
    const preview = await kit.run<{ locations: { current: unknown; noChange: boolean; changes: unknown[] }[] }>(org.manager, "profile.preview", {
      locationIds: [loc.row.id],
      fields: {},
      addCategories: [{ name: match!.name }],
    });
    expect(preview.locations[0]!.noChange).toBe(false);
    const writesBefore = mock.calls.filter((c) => c.method === "patchLocation").length;
    const proposed = await kit.run<{ changeSet: { id: string; status: string } }>(org.manager, "profile.propose", {
      workspaceId: org.a,
      locationIds: [loc.row.id],
      fields: {},
      addCategories: [{ name: match!.name }],
      snapshots: [{ locationId: loc.row.id, current: preview.locations[0]!.current }],
    });
    expect(proposed.changeSet.status).toBe("pending_approval");
    expect(mock.calls.filter((c) => c.method === "patchLocation").length).toBe(writesBefore);
  });
});
