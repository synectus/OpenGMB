import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  gridConfigs,
  locations,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { GRID_COLLECT_QUEUE, GRID_RUN_QUEUE } from "./geogrid/run";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
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
  const [ws] = await db.insert(workspaces).values({ orgId, name: "Prospects" }).returning();
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
    ws: ws!.id,
    loc: loc!.id,
    owner: await mk("owner"),
    manager: await mk("manager"),
    viewer: await mk("client_viewer"),
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const PLACE = "ChIJ_prospectA_0123456789";
const scanInput = (o: Org, over: Record<string, unknown> = {}) => ({
  workspaceId: o.ws,
  businessName: "[PROSPECT A] Chiropractic",
  placeId: PLACE,
  keyword: "chiropractor rivermoor",
  gridSize: 3,
  radiusM: 2000,
  centerLat: 27.5306,
  centerLng: -99.4803,
  ...over,
});

type Scan = {
  scan: { id: string; kind: string; locationId: string | null; schedule: string; keywords: string[]; targetPlaceId: string };
  runs: { runId: string; keyword: string; costEstimateUsd: number }[];
};
const listIds = async (o: Org, input: unknown = {}) =>
  ((await run(o.owner, "geogrid.configs.list", input)) as { configs: { id: string; kind: string }[] }).configs;
const runIds = async (o: Org, input: unknown = {}) =>
  ((await run(o.owner, "geogrid.runs.list", input)) as { runs: { id: string; configId: string }[] }).runs;

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

describe("geogrid.quickScans.create", () => {
  it("creates a manual, location-less scan with one queued run", async () => {
    const out = (await run(o.manager, "geogrid.quickScans.create", scanInput(o))) as Scan;
    expect(out.scan).toMatchObject({
      kind: "quick_scan",
      locationId: null,
      schedule: "manual",
      keywords: ["chiropractor rivermoor"],
      targetPlaceId: PLACE,
    });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]!.costEstimateUsd).toBeGreaterThan(0);
  });

  it("is hidden from the tracker lists and shown with kind=quick_scan (trackers unchanged)", async () => {
    const tracker = (await run(o.manager, "geogrid.configs.create", {
      locationId: o.loc,
      keywords: ["dentist"],
      gridSize: 3,
      radiusM: 1000,
      centerLat: 27.5,
      centerLng: -99.5,
    })) as { config: { id: string; kind: string } };
    expect(tracker.config.kind).toBe("tracker");
    const scan = (await run(o.manager, "geogrid.quickScans.create", scanInput(o))) as Scan;

    const trackers = await listIds(o);
    expect(trackers.some((c) => c.id === tracker.config.id)).toBe(true);
    expect(trackers.some((c) => c.id === scan.scan.id)).toBe(false);
    const scans = await listIds(o, { kind: "quick_scan" });
    expect(scans.some((c) => c.id === scan.scan.id)).toBe(true);
    expect(scans.every((c) => c.kind === "quick_scan")).toBe(true);

    expect((await runIds(o)).some((r) => r.configId === scan.scan.id)).toBe(false);
    expect((await runIds(o, { kind: "quick_scan" })).some((r) => r.configId === scan.scan.id)).toBe(true);
  });

  it("validates the place id, the grid, the role and the workspace", async () => {
    const bad = (over: Record<string, unknown>, actor: Actor = o.manager) =>
      codeOf(run(actor, "geogrid.quickScans.create", scanInput(o, over)));
    expect(await bad({ placeId: "not a place id" })).toMatch(/^INVALID_INPUT:.*place id/);
    expect(await bad({ gridSize: 4 })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ radiusM: 10 })).toMatch(/^INVALID_INPUT/);
    expect(await bad({}, o.viewer)).toMatch(/^FORBIDDEN/);
    const other = await makeOrg();
    expect(await bad({ workspaceId: other.ws })).toMatch(/^NOT_FOUND/);
  });

  it("is refused as a whole when the budget does not cover it (no scan left behind)", async () => {
    const p = await makeOrg();
    await run(p.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0.001 });
    const before = (await listIds(p, { kind: "quick_scan" })).length;
    expect(await codeOf(run(p.manager, "geogrid.quickScans.create", scanInput(p)))).toMatch(
      /^FORBIDDEN:BUDGET_EXCEEDED/,
    );
    expect((await listIds(p, { kind: "quick_scan" })).length).toBe(before);
  });

  it("re-runs with geogrid.run, stays manual, and is removed with geogrid.configs.delete", async () => {
    const { scan } = (await run(o.manager, "geogrid.quickScans.create", scanInput(o))) as Scan;
    await run(o.manager, "geogrid.run", { configId: scan.id });
    expect((await runIds(o, { kind: "quick_scan", configId: scan.id })).length).toBe(2);
    expect(
      await codeOf(run(o.manager, "geogrid.configs.update", { id: scan.id, schedule: "weekly" })),
    ).toMatch(/^INVALID_INPUT/);
    await run(o.manager, "geogrid.configs.delete", { id: scan.id });
    expect((await listIds(o, { kind: "quick_scan" })).some((c) => c.id === scan.id)).toBe(false);
  });

  it("the database refuses a scan with a location or a schedule, and a tracker without a location", async () => {
    const base = {
      orgId: o.orgId,
      workspaceId: o.ws,
      keywords: ["k"],
      gridSize: 3,
      radiusM: 1000,
      centerLat: 1,
      centerLng: 1,
      targetName: "x",
      driverId: "dataforseo_standard" as const,
      createdBy: o.manager.userId,
    };
    const ins = (v: Record<string, unknown>) =>
      db.insert(gridConfigs).values({ ...base, ...v } as typeof gridConfigs.$inferInsert);
    // drizzle wraps the driver error ("Failed query"); the constraint name is on `cause`.
    const refused = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return String((e as { cause?: { message?: string } }).cause?.message ?? e);
      }
      return "no error";
    };
    expect(await refused(ins({ kind: "quick_scan", locationId: o.loc }))).toMatch(/grid_configs_kind_location_check/);
    expect(await refused(ins({ kind: "quick_scan", locationId: null, schedule: "daily" }))).toMatch(
      /grid_configs_quick_scan_manual_check/,
    );
    expect(await refused(ins({ kind: "tracker", locationId: null }))).toMatch(/grid_configs_kind_location_check/);
    expect(await db.select().from(gridConfigs).where(eq(gridConfigs.targetName, "x"))).toHaveLength(0);
  });

  it("a viewer of the workspace reads scans and their runs (board card 8)", async () => {
    const { runs } = (await run(o.manager, "geogrid.quickScans.create", scanInput(o))) as Scan;
    expect(await codeOf(run(o.viewer, "geogrid.runs.get", { runId: runs[0]!.runId }))).toBe("no error");
    expect(await codeOf(run(o.viewer, "geogrid.configs.list", { kind: "quick_scan" }))).toBe("no error");
  });
});
