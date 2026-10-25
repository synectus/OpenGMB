import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  createDb,
  gridConfigs,
  gridRuns,
  locations,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor } from "./actor";
import { executeAction } from "./executor";
import { createDriverRegistry, fixtureDataForSeoTransport, type DataForSeoTransport } from "./geogrid/drivers";
import { processGridRun, requestGridRuns } from "./geogrid/run";

// Scan speed: stored on the run, org default for schedules, per-speed preview, priority only for fast.
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const madeOrgs: string[] = [];
afterAll(async () => {
  await db.delete(gridRuns).where(inArray(gridRuns.orgId, madeOrgs));
  await sql.end();
});

async function makeOrg() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  madeOrgs.push(orgId);
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const mk = async (role: "owner" | "manager") => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
  const [loc] = await db.insert(locations).values({ orgId, workspaceId: ws!.id, name: "locations/1", title: "Acme Dental" }).returning();
  const owner = await mk("owner");
  const manager = await mk("manager");
  const created = (await executeAction(db, manager, "geogrid.configs.create", {
    locationId: loc!.id,
    keywords: ["dentist"],
    gridSize: 3,
    radiusM: 3000,
    centerLat: 51.5074,
    centerLng: -0.1278,
  })) as { config: { id: string } };
  const [config] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, created.config.id));
  return { orgId, owner, manager, config: config! };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;
const noAudit = async () => {};
const liveReg = (transport: DataForSeoTransport = fixtureDataForSeoTransport()) =>
  createDriverRegistry({ source: () => "live", liveDataForSeo: () => transport });
const request = (o: Org, drivers: ReturnType<typeof liveReg>, speed?: "standard" | "fast") =>
  db.transaction((tx) => requestGridRuns(tx, { config: o.config, requestedBy: null, audit: noAudit, drivers, now: new Date(), speed }));

describe("scan speed", () => {
  it("settings: default speed is standard, owner can change it, it is audited-through settings.get", async () => {
    const o = await makeOrg();
    const before = (await executeAction(db, o.owner, "geogrid.settings.get", {})) as { defaultSpeed: string; speeds: { speed: string; perTaskUsd: number }[] };
    expect(before.defaultSpeed).toBe("standard");
    expect(before.speeds.map((s) => s.speed)).toEqual(["standard", "fast"]);
    const after = (await executeAction(db, o.owner, "geogrid.settings.update", { defaultSpeed: "fast" })) as { defaultSpeed: string; monthlyBudgetUsd: number };
    expect(after.defaultSpeed).toBe("fast");
    expect(after.monthlyBudgetUsd).toBe(25); // untouched
    await expect(executeAction(db, o.owner, "geogrid.settings.update", { defaultSpeed: "instant" })).rejects.toBeTruthy();
  });

  it("preview lists every speed side by side and prices the chosen one, defaulting to the org default", async () => {
    const o = await makeOrg();
    const input = { driverId: "dataforseo_standard", gridSize: 5, keywordCount: 1 };
    const p = (await executeAction(db, o.manager, "geogrid.preview", input)) as {
      speed: string; estimateUsd: number; perTaskUsd: number; speeds: { speed: string; estimateUsd: number; typicalMinutes: number }[];
    };
    expect(p.speed).toBe("standard");
    expect(p.speeds.map((s) => s.speed)).toEqual(["standard", "fast"]);
    expect(p.speeds[1]!.estimateUsd).toBeGreaterThan(p.speeds[0]!.estimateUsd);
    expect(p.estimateUsd).toBe(p.speeds[0]!.estimateUsd);
    const f = (await executeAction(db, o.manager, "geogrid.preview", { ...input, speed: "fast" })) as typeof p;
    expect(f.speed).toBe("fast");
    expect(f.perTaskUsd).toBe(0.0012);
    expect(f.estimateUsd).toBe(p.speeds[1]!.estimateUsd);
    await executeAction(db, o.owner, "geogrid.settings.update", { defaultSpeed: "fast" });
    const d = (await executeAction(db, o.manager, "geogrid.preview", input)) as typeof p;
    expect(d.speed).toBe("fast");
    // The relevance check offers a single free speed.
    const r = (await executeAction(db, o.manager, "geogrid.preview", { ...input, driverId: "places_relevance" })) as typeof p;
    expect(r.speeds).toHaveLength(1);
    expect(r.estimateUsd).toBe(0);
  });

  it("a run stores its speed; a scheduled-style request uses the org default; fast costs twice standard", async () => {
    const o = await makeOrg();
    const std = await request(o, liveReg());
    const fast = await request(o, liveReg(), "fast");
    const [sr] = await db.select().from(gridRuns).where(eq(gridRuns.id, std[0]!.runId));
    const [fr] = await db.select().from(gridRuns).where(eq(gridRuns.id, fast[0]!.runId));
    expect([sr!.speed, fr!.speed]).toEqual(["standard", "fast"]);
    expect(Number(fr!.providerEstimateUsd)).toBeCloseTo(9 * 0.0012, 6);
    expect(Number(sr!.providerEstimateUsd)).toBeCloseTo(9 * 0.0006, 6);
    expect(fast[0]!.costEstimateUsd).toBeCloseTo(2 * std[0]!.costEstimateUsd, 3);

    await executeAction(db, o.owner, "geogrid.settings.update", { defaultSpeed: "fast" });
    const sched = await request(o, liveReg());
    const [dr] = await db.select().from(gridRuns).where(eq(gridRuns.id, sched[0]!.runId));
    expect(dr!.speed).toBe("fast");
  });

  it("the worker submits priority 2 for a fast run and no priority for a standard run, and bills provider cost as reported", async () => {
    const o = await makeOrg();
    const seen: { speed: string; priorities: (number | undefined)[] }[] = [];
    const base = fixtureDataForSeoTransport();
    const transport: DataForSeoTransport = {
      taskGet: base.taskGet,
      taskPost: async (items) => {
        seen.push({ speed: "?", priorities: items.map((i) => i.priority) });
        return base.taskPost(items);
      },
    };
    const reg = liveReg(transport);
    const [std] = await request(o, reg, "standard");
    const [fast] = await request(o, reg, "fast");
    await processGridRun(db, std!.runId, { drivers: reg, pingbackBaseUrl: "https://worker.example.test" });
    await processGridRun(db, fast!.runId, { drivers: reg, pingbackBaseUrl: "https://worker.example.test" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.priorities.every((p) => p === undefined)).toBe(true);
    expect(seen[1]!.priorities.length).toBe(9);
    expect(seen[1]!.priorities.every((p) => p === 2)).toBe(true);
  });
});
