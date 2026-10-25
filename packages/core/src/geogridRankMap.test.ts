import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  gridPoints,
  gridRuns,
  gridTasks,
  locations,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { createDriverRegistry } from "./geogrid/drivers";
import { GRID_COLLECT_QUEUE, GRID_RUN_QUEUE, processGridRun } from "./geogrid/run";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const drivers = createDriverRegistry();
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? `${e.code}:${e.message}` : `other:${String(e)}`;
  }
  return "no error";
}

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

async function makeOrg() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ orgId, workspaceId: ws!.id, name: `locations/${uniq()}`, title: "Acme Dental" })
    .returning();
  const mk = async (role: "owner" | "manager" | "client_viewer") => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db
      .insert(memberships)
      .values({ orgId, userId: id, role, workspaceId: role === "client_viewer" ? ws!.id : undefined });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
  return {
    orgId,
    loc: loc!.id,
    owner: await mk("owner"),
    manager: await mk("manager"),
    viewer: await mk("client_viewer"),
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

async function createConfig(o: Org, over: Record<string, unknown> = {}) {
  const r = (await run(o.manager, "geogrid.configs.create", {
    locationId: o.loc,
    keywords: ["dentist near me"],
    gridSize: 3,
    radiusM: 1000,
    centerLat: 27.5306,
    centerLng: -99.4803,
    ...over,
  })) as { config: { id: string } };
  return r.config.id;
}

type ConfigOut = { id: string; favoriteKeywords: string[]; nextRunAt: string | null };
const listConfigs = async (o: Org) =>
  ((await run(o.owner, "geogrid.configs.list")) as { configs: ConfigOut[] }).configs;

let o: Org;
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
  o = await makeOrg();
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("favorite keywords", () => {
  it("start empty, keep the keyword's own spelling, drop removed keywords, reject unknown ones", async () => {
    const id = await createConfig(o, { keywords: ["Pain clinic", "back pain"] });
    expect((await listConfigs(o)).find((c) => c.id === id)!.favoriteKeywords).toEqual([]);

    const up = (await run(o.manager, "geogrid.configs.update", {
      id,
      favoriteKeywords: ["pain CLINIC", "Pain clinic"],
    })) as { config: ConfigOut };
    expect(up.config.favoriteKeywords).toEqual(["Pain clinic"]);

    expect(
      await codeOf(run(o.manager, "geogrid.configs.update", { id, favoriteKeywords: ["dentist"] })),
    ).toMatch(/^INVALID_INPUT/);

    const kw = (await run(o.manager, "geogrid.configs.update", {
      id,
      keywords: ["back pain"],
    })) as { config: ConfigOut };
    expect(kw.config.favoriteKeywords).toEqual([]);

    expect(
      await codeOf(run(o.viewer, "geogrid.configs.update", { id, favoriteKeywords: [] })),
    ).toMatch(/^FORBIDDEN/);
  });
});

describe("nextRunAt", () => {
  it("is the next 05:00 UTC tick for an active scheduled tracker, null for manual or inactive", async () => {
    const weekly = await createConfig(o, { schedule: "weekly" });
    const manual = await createConfig(o);
    const inactive = await createConfig(o, { schedule: "daily" });
    await run(o.manager, "geogrid.configs.update", { id: inactive, active: false });
    const cs = await listConfigs(o);
    const next = cs.find((c) => c.id === weekly)!.nextRunAt;
    expect(next).toMatch(/T05:00:00\.000Z$/);
    expect(Date.parse(next!) - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(cs.find((c) => c.id === manual)!.nextRunAt).toBeNull();
    expect(cs.find((c) => c.id === inactive)!.nextRunAt).toBeNull();
  });
});

type Got = {
  points: { row: number; col: number; rank: number | null; pending: boolean }[];
  progress: { collected: number; total: number };
};

describe("geogrid.runs.get pending points", () => {
  it("returns the planned grid while queued, then marks settled points as collected", async () => {
    const id = await createConfig(o);
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string }[];
    };
    const runId = out.runs[0]!.runId;

    const queued = (await run(o.viewer, "geogrid.runs.get", { runId })) as Got;
    expect(queued.points).toHaveLength(9);
    expect(queued.points.every((p) => p.pending && p.rank === null)).toBe(true);
    expect(queued.progress).toEqual({ collected: 0, total: 9 });

    expect(
      await processGridRun(db, runId, { drivers, pingbackBaseUrl: "https://worker.test" }),
    ).toBe("running");
    // Settle one point by hand, as a collect would.
    await db
      .update(gridTasks)
      .set({ status: "done" })
      .where(and(eq(gridTasks.runId, runId), eq(gridTasks.row, 0), eq(gridTasks.col, 0)));
    await db
      .update(gridPoints)
      .set({ rank: 2, top3: true })
      .where(and(eq(gridPoints.runId, runId), eq(gridPoints.row, 0), eq(gridPoints.col, 0)));

    const running = (await run(o.viewer, "geogrid.runs.get", { runId })) as Got;
    expect(running.progress).toEqual({ collected: 1, total: 9 });
    expect(running.points.find((p) => p.row === 0 && p.col === 0)).toMatchObject({
      rank: 2,
      pending: false,
    });
    expect(running.points.filter((p) => p.pending)).toHaveLength(8);
  });
});

describe("geogrid.competitors includeTarget", () => {
  it("leaves the target out by default and puts it first with its address when asked", async () => {
    const id = await createConfig(o);
    const [r] = await db
      .insert(gridRuns)
      .values({
        orgId: o.orgId,
        configId: id,
        keyword: "dentist near me",
        driverId: "dataforseo_standard",
        status: "done",
        costEstimateUsd: "0.0000",
        finishedAt: new Date(),
      })
      .returning();
    const comp = (rank: number, title: string, placeId: string, isTarget: boolean) => ({
      rank,
      title,
      placeId,
      rating: 4.5,
      isTarget,
      address: `${rank} Main St`,
      reviewCount: 10 * rank,
    });
    await db.insert(gridPoints).values([
      {
        runId: r!.id,
        orgId: o.orgId,
        row: 0,
        col: 0,
        lat: 1,
        lng: 1,
        rank: 1,
        top3: true,
        competitors: [comp(1, "Acme Dental", "me", true), comp(2, "Alpha", "a", false)],
      },
    ]);
    type Rows = { competitors: { business: string; isTarget: boolean; address: string | null; reviewCount: number | null }[] };
    const plain = (await run(o.viewer, "geogrid.competitors", { runId: r!.id })) as Rows;
    expect(plain.competitors.map((c) => c.business)).toEqual(["Alpha"]);
    const withMe = (await run(o.viewer, "geogrid.competitors", {
      runId: r!.id,
      includeTarget: true,
    })) as Rows;
    expect(withMe.competitors[0]).toMatchObject({
      business: "Acme Dental",
      isTarget: true,
      address: "1 Main St",
      reviewCount: 10,
    });
  });
});
