import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  gridConfigs,
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
import { verifyAuditChain } from "./audit";
import { GEOGRID_DEFAULTS } from "./config/geogrid";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { setGeogridDriversForTests } from "./actions/geogrid";
import { createDriverRegistry, fixtureDataForSeoTransport, type DriverDeps } from "./geogrid/drivers";
import {
  acceptPingback,
  enqueueDueGridRuns,
  GRID_COLLECT_QUEUE,
  GRID_RUN_QUEUE,
  processGridCollect,
  processGridRun,
} from "./geogrid/run";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
/** A registry whose data source is "live" but whose transport is the offline fixture: runs record real-looking costs, nothing leaves the process. */
const liveFixture = (deps: DriverDeps = {}) =>
  createDriverRegistry({
    source: () => "live",
    liveDataForSeo: () => deps.dataForSeo ?? fixtureDataForSeoTransport(),
    ...deps,
  });
const drivers = liveFixture();
const PINGBACK = "https://worker.test";

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? `${e.code}:${e.message}` : `other:${String(e)}`;
  }
  return "no error";
}

const madeOrgs: string[] = [];
async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  madeOrgs.push(orgId);
  const mkUser = async (
    role: "owner" | "admin" | "manager" | "client_viewer",
    workspaceId?: string,
  ) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const [locA] = await db
    .insert(locations)
    .values({ orgId, workspaceId: a!.id, name: "locations/1", title: "Acme Dental" })
    .returning();
  const [locB] = await db
    .insert(locations)
    .values({ orgId, workspaceId: b!.id, name: "locations/2", title: "Other Co" })
    .returning();
  return {
    orgId,
    wsA: a!.id,
    wsB: b!.id,
    locA: locA!.id,
    locB: locB!.id,
    owner: await mkUser("owner"),
    admin: await mkUser("admin"),
    manager: await mkUser("manager"),
    viewerA: await mkUser("client_viewer", a!.id),
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

const baseConfig = (org: Org, over: Record<string, unknown> = {}) => ({
  locationId: org.locA,
  keywords: ["dentist near me"],
  gridSize: 3,
  radiusM: 3000,
  centerLat: 51.5074,
  centerLng: -0.1278,
  ...over,
});

async function createConfig(org: Org, over: Record<string, unknown> = {}) {
  const r = (await run(org.manager, "geogrid.configs.create", baseConfig(org, over))) as {
    config: { id: string };
  };
  return r.config.id;
}

async function jobCount(queue: string, key: string, value: string) {
  const rows = await sql<{ id: string }[]>`
    select id from pgboss.job where name = ${queue} and data->>${key} = ${value}`;
  return rows.length;
}

async function auditActions(orgId: string) {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId));
  return rows.map((r) => r.action);
}

let org: Org;
let other: Org;

beforeAll(async () => {
  setGeogridDriversForTests(drivers);
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
  org = await makeOrg();
  other = await makeOrg();
});
afterAll(async () => {
  // Live-source runs count toward the platform's daily cap; a reused test database must not accumulate them.
  await db.delete(gridRuns).where(inArray(gridRuns.orgId, madeOrgs));
  setGeogridDriversForTests(null);
  await boss.stop();
  await sql.end();
});

describe("geogrid.configs", () => {
  it("creates, lists, updates and deletes with audit rows", async () => {
    const id = await createConfig(org, { keywords: ["a", "b"], schedule: "weekly" });
    const list = (await run(org.owner, "geogrid.configs.list")) as {
      configs: { id: string; targetName: string; pointCount: number; isMapsRank: boolean }[];
    };
    const c = list.configs.find((x) => x.id === id)!;
    expect(c).toMatchObject({ targetName: "Acme Dental", pointCount: 9, isMapsRank: true });

    const upd = (await run(org.manager, "geogrid.configs.update", {
      id,
      gridSize: 5,
      active: false,
    })) as { config: { gridSize: number; active: boolean } };
    expect(upd.config).toMatchObject({ gridSize: 5, active: false });
    expect(await codeOf(run(org.manager, "geogrid.configs.update", { id, gridSize: 4 }))).toMatch(
      /^INVALID_INPUT|^other/,
    );

    await run(org.manager, "geogrid.configs.delete", { id });
    const after = (await run(org.owner, "geogrid.configs.list")) as { configs: { id: string }[] };
    expect(after.configs.find((x) => x.id === id)).toBeUndefined();

    const acts = await auditActions(org.orgId);
    for (const a of [
      "geogrid.config_created",
      "geogrid.config_updated",
      "geogrid.config_deleted",
    ]) {
      expect(acts).toContain(a);
    }
    expect((await verifyAuditChain(db, org.orgId)).ok).toBe(true);
  });

  it("validates size, radius, keywords and the places place-id rule", async () => {
    const bad = async (over: Record<string, unknown>) =>
      codeOf(run(org.manager, "geogrid.configs.create", baseConfig(org, over)));
    expect(await bad({ gridSize: 4 })).toMatch(/INVALID_INPUT/);
    expect(await bad({ gridSize: 15 })).toMatch(/INVALID_INPUT/);
    expect(await bad({ radiusM: 10 })).toMatch(/INVALID_INPUT/);
    expect(await bad({ keywords: [] })).toMatch(/INVALID_INPUT/);
    expect(await bad({ keywords: ["x", "X"] })).toMatch(/INVALID_INPUT/);
    expect(await bad({ driverId: "places_relevance" })).toMatch(/place id/);
  });

  it("labels the Places driver as not Maps rank in the API output", async () => {
    const id = await createConfig(org, { driverId: "places_relevance", targetPlaceId: "ChIJme" });
    const list = (await run(org.owner, "geogrid.configs.list")) as {
      configs: { id: string; driverLabel: string; isMapsRank: boolean }[];
    };
    const c = list.configs.find((x) => x.id === id)!;
    expect(c.driverLabel).toBe("Relevance check (not Maps rank)");
    expect(c.isMapsRank).toBe(false);
  });

  it("enforces roles and tenancy", async () => {
    const id = await createConfig(org);
    // viewer: read only, in own workspace only
    expect(await codeOf(run(org.viewerA, "geogrid.configs.create", baseConfig(org)))).toMatch(
      /^FORBIDDEN/,
    );
    expect(await codeOf(run(org.viewerA, "geogrid.run", { configId: id }))).toMatch(/^FORBIDDEN/);
    const v = (await run(org.viewerA, "geogrid.configs.list")) as {
      configs: { workspaceId: string }[];
    };
    expect(v.configs.length).toBeGreaterThan(0);
    expect(v.configs.every((c) => c.workspaceId === org.wsA)).toBe(true);
    const idB = await createConfig(org, { locationId: org.locB });
    expect(await codeOf(run(org.viewerA, "geogrid.runs.list", { configId: idB }))).toBe("no error");
    const vb = (await run(org.viewerA, "geogrid.runs.list", { configId: idB })) as {
      runs: unknown[];
    };
    expect(vb.runs).toEqual([]);
    // other org cannot see or touch
    expect(await codeOf(run(other.owner, "geogrid.configs.update", { id, active: false }))).toMatch(
      /^NOT_FOUND/,
    );
    expect(await codeOf(run(other.owner, "geogrid.run", { configId: id }))).toMatch(/^NOT_FOUND/);
    expect(await codeOf(run(other.owner, "geogrid.configs.create", baseConfig(org)))).toMatch(
      /^NOT_FOUND/,
    );
    const o = (await run(other.owner, "geogrid.configs.list")) as { configs: unknown[] };
    expect(o.configs).toEqual([]);
  });

  it("settings.update is owner/admin only; manager cannot", async () => {
    expect(
      await codeOf(run(org.manager, "geogrid.settings.update", { monthlyBudgetUsd: 1000 })),
    ).toMatch(/^FORBIDDEN/);
    // billing numbers are for agency roles only (U7); a client viewer is refused
    expect(await codeOf(run(org.viewerA, "geogrid.settings.get"))).toMatch(/^FORBIDDEN/);
    expect(await codeOf(run(org.manager, "geogrid.settings.get"))).toBe("no error");
  });
});

describe("cost preview and budget", () => {
  it("previews with defaults, then with a changed markup and budget", async () => {
    const p1 = (await run(other.owner, "geogrid.preview", {
      driverId: "dataforseo_standard",
      gridSize: 13,
      keywordCount: 5,
    })) as Record<string, number | boolean | string>;
    expect(p1).toMatchObject({
      points: 169,
      keywordCount: 5,
      markupPercent: GEOGRID_DEFAULTS.markupPercent,
      monthlyBudgetUsd: GEOGRID_DEFAULTS.monthlyBudgetUsd,
      monthToDateUsd: 0,
      wouldExceed: false,
    });
    expect(p1.estimateUsd).toBeCloseTo(169 * 5 * 0.0006 * 1.28, 3);

    await run(other.admin, "geogrid.settings.update", {
      markupPercent: 100,
      monthlyBudgetUsd: 0.2,
    });
    const p2 = (await run(other.owner, "geogrid.preview", {
      driverId: "dataforseo_standard",
      gridSize: 13,
      keywordCount: 5,
    })) as { estimateUsd: number; remainingUsd: number; wouldExceed: boolean };
    expect(p2.estimateUsd).toBeCloseTo(169 * 5 * 0.0006 * 2, 3);
    expect(p2.wouldExceed).toBe(true);
    expect(p2.remainingUsd).toBeCloseTo(0.2, 6);
    const free = (await run(other.owner, "geogrid.preview", {
      driverId: "places_relevance",
      gridSize: 13,
      keywordCount: 5,
    })) as { estimateUsd: number; isMapsRank: boolean; wouldExceed: boolean };
    expect(free).toMatchObject({ estimateUsd: 0, isMapsRank: false, wouldExceed: false });
    const acts = await auditActions(other.orgId);
    expect(acts).toContain("geogrid.settings_updated");
  });

  it("refuses a run that would exceed the monthly budget with a typed FORBIDDEN, writing nothing", async () => {
    const id = await createConfig(other, {
      gridSize: 13,
      keywords: ["a", "b", "c", "d", "e"],
      locationId: other.locA,
    });
    const code = await codeOf(run(other.manager, "geogrid.run", { configId: id }));
    expect(code).toMatch(/^FORBIDDEN:BUDGET_EXCEEDED/);
    const runs = await db.select().from(gridRuns).where(eq(gridRuns.configId, id));
    expect(runs).toHaveLength(0);
  });

  it("reserves queued estimates and counts charged cost toward the month", async () => {
    const o = await makeOrg();
    await run(o.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0.1, markupPercent: 0 });
    // 3x3 = 9 points x $0.0006 = $0.0054 per keyword
    const id = await createConfig(o, { keywords: ["a"] });
    for (let i = 0; i < 18; i++) await run(o.manager, "geogrid.run", { configId: id });
    // 18 x 0.0054 = 0.0972 reserved; the 19th (0.1026) must not fit
    expect(await codeOf(run(o.manager, "geogrid.run", { configId: id }))).toMatch(
      /BUDGET_EXCEEDED/,
    );
    const p = (await run(o.owner, "geogrid.preview", {
      driverId: "dataforseo_standard",
      gridSize: 3,
      keywordCount: 1,
    })) as { monthToDateUsd: number };
    expect(p.monthToDateUsd).toBeCloseTo(0.0972, 4);
  });
});

describe("run flow", () => {
  it("dataforseo: run -> job -> submit -> pingback (auth, duplicate) -> collect -> done", async () => {
    const o = await makeOrg();
    const id = await createConfig(o, {
      keywords: ["dentist", "implants"],
      gridSize: 5,
      radiusM: 4000,
    });
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string; keyword: string; costEstimateUsd: number }[];
    };
    expect(out.runs).toHaveLength(2);
    const runId = out.runs[0]!.runId;
    expect(await jobCount(GRID_RUN_QUEUE, "runId", runId)).toBe(1);
    expect(out.runs[0]!.costEstimateUsd).toBeCloseTo(25 * 0.0006 * 1.28, 3);

    // Missing public URL fails the run cleanly and charges nothing.
    const failing = await processGridRun(db, out.runs[1]!.runId, {
      drivers,
      pingbackBaseUrl: undefined,
    });
    expect(failing).toBe("failed");
    const [failedRun] = await db.select().from(gridRuns).where(eq(gridRuns.id, out.runs[1]!.runId));
    expect(failedRun).toMatchObject({ status: "failed", costChargedUsd: "0.0000" });

    // Capture the pingback URLs the driver is given.
    const urls = new Map<string, string>();
    const capturing = liveFixture({
      dataForSeo: await (async () => {
        const { fixtureDataForSeoTransport } = await import("./geogrid/drivers");
        const base = fixtureDataForSeoTransport();
        return {
          taskGet: base.taskGet,
          taskPost: async (items) => {
            const res = await base.taskPost(items);
            res.tasks.forEach((t, i) => urls.set(t.id, items[i]!.pingback_url!));
            return res;
          },
        };
      })(),
    });
    expect(await processGridRun(db, runId, { drivers: capturing, pingbackBaseUrl: PINGBACK })).toBe(
      "running",
    );
    expect(await processGridRun(db, runId, { drivers: capturing, pingbackBaseUrl: PINGBACK })).toBe(
      "skipped",
    );
    expect(urls.size).toBe(25);

    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, runId));
    expect(tasks.every((t) => t.status === "submitted" && t.taskRef)).toBe(true);
    // The secret is not stored; only its hash.
    const [first] = tasks;
    const pingUrl = new URL(urls.get(first!.taskRef!)!.replace("$id", first!.taskRef!));
    const token = pingUrl.searchParams.get("token")!;
    expect(pingUrl.pathname).toBe("/webhooks/dataforseo");
    expect(token).toHaveLength(64);
    expect(first!.tokenHash).not.toBe(token);

    // Auth.
    expect(await acceptPingback(db, { taskRef: first!.taskRef!, token: "wrong" })).toBe(
      "unauthorized",
    );
    expect(await acceptPingback(db, { taskRef: "fx-unknown", token })).toBe("unauthorized");
    const other0 = tasks[1]!;
    const otherToken = new URL(urls.get(other0.taskRef!)!).searchParams.get("token")!;
    expect(await acceptPingback(db, { taskRef: first!.taskRef!, token: otherToken })).toBe(
      "unauthorized",
    );

    // First valid delivery enqueues exactly one collect job; a repeat is a no-op.
    expect(await acceptPingback(db, { taskRef: first!.taskRef!, token })).toBe("accepted");
    expect(await acceptPingback(db, { taskRef: first!.taskRef!, token })).toBe("duplicate");
    expect(await jobCount(GRID_COLLECT_QUEUE, "taskId", first!.id)).toBe(1);

    // Deliver and collect every point.
    for (const t of tasks) {
      const tok = new URL(urls.get(t.taskRef!)!).searchParams.get("token")!;
      const o1 = await acceptPingback(db, { taskRef: t.taskRef!, token: tok });
      expect(o1).toBe(t.id === first!.id ? "duplicate" : "accepted");
      const r = await processGridCollect(db, t.id, { drivers: capturing });
      expect(r).toBe("done");
      expect(await processGridCollect(db, t.id, { drivers: capturing })).toBe("skipped");
    }

    const [done] = await db.select().from(gridRuns).where(eq(gridRuns.id, runId));
    expect(done!.status).toBe("done");
    expect(Number(done!.costChargedUsd)).toBeCloseTo(Number(done!.costEstimateUsd), 4);
    expect(done!.finishedAt).not.toBeNull();

    const pts = await db.select().from(gridPoints).where(eq(gridPoints.runId, runId));
    expect(pts).toHaveLength(25);
    for (const p of pts) {
      expect(p.top3).toBe(p.rank !== null && p.rank <= 3);
      expect((p.competitors as unknown[]).length).toBe(20);
    }
    // The target is ~250 m north of the centre in the fixture: found at most points, best near it.
    expect(pts.filter((p) => p.rank !== null).length).toBeGreaterThan(5);

    const got = (await run(o.viewerA, "geogrid.runs.get", { runId })) as {
      run: {
        status: string;
        isMapsRank: boolean;
        summary: { points: number; averageRank: number };
      };
      points: unknown[];
      notice: string | null;
    };
    expect(got.run).toMatchObject({ status: "done", isMapsRank: true });
    expect(got.run.summary.points).toBe(25);
    expect(got.notice).toBeNull();

    const comp = (await run(o.viewerA, "geogrid.competitors", { configId: id })) as {
      runId: string;
      competitors: { business: string; appearances: number }[];
    };
    expect(comp.runId).toBe(runId);
    expect(comp.competitors.length).toBeGreaterThan(5);
    expect(comp.competitors.some((c) => c.business === "Acme Dental")).toBe(false);

    const acts = await auditActions(o.orgId);
    expect(acts.filter((a) => a === "geogrid.run_requested")).toHaveLength(2);
    expect(acts.filter((a) => a === "geogrid.run_finished")).toHaveLength(2);
    expect((await verifyAuditChain(db, o.orgId)).ok).toBe(true);

    const hist = (await run(o.owner, "geogrid.runs.list", { configId: id })) as {
      runs: { id: string; status: string }[];
    };
    expect(hist.runs.map((r) => r.status).sort()).toEqual(["done", "failed"]);
  });

  it("places relevance: collects immediately, free, labelled not Maps rank", async () => {
    const o = await makeOrg();
    const id = await createConfig(o, {
      driverId: "places_relevance",
      targetPlaceId: "ChIJtargetplace",
    });
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string; costEstimateUsd: number }[];
    };
    expect(out.runs[0]!.costEstimateUsd).toBe(0);
    const runId = out.runs[0]!.runId;
    expect(await processGridRun(db, runId, { drivers, pingbackBaseUrl: undefined })).toBe("done");
    const got = (await run(o.owner, "geogrid.runs.get", { runId })) as {
      run: { status: string; isMapsRank: boolean; driverLabel: string; costChargedUsd: number };
      points: { rank: number | null }[];
      notice: string;
    };
    expect(got.run).toMatchObject({
      status: "done",
      isMapsRank: false,
      driverLabel: "Relevance check (not Maps rank)",
      costChargedUsd: 0,
    });
    expect(got.notice).toContain("NOT Google Maps rank");
    expect(got.points).toHaveLength(9);
    const list = (await run(o.owner, "geogrid.runs.list", {})) as {
      runs: { isMapsRank: boolean; driverLabel: string }[];
    };
    expect(list.runs.every((r) => !r.isMapsRank && r.driverLabel.includes("not Maps rank"))).toBe(
      true,
    );
    const comp = (await run(o.owner, "geogrid.competitors", { runId })) as {
      isMapsRank: boolean;
      driverLabel: string;
    };
    expect(comp).toMatchObject({
      isMapsRank: false,
      driverLabel: "Relevance check (not Maps rank)",
    });
  });

  it("a collect failure on the final attempt fails the point; the run settles", async () => {
    const o = await makeOrg();
    const id = await createConfig(o, { gridSize: 3 });
    const { runs } = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string }[];
    };
    const urls = new Map<string, string>();
    const base = (await import("./geogrid/drivers")).fixtureDataForSeoTransport();
    let broken = true;
    const flaky = liveFixture({
      dataForSeo: {
        taskPost: async (items) => {
          const r = await base.taskPost(items);
          r.tasks.forEach((t, i) => urls.set(t.id, items[i]!.pingback_url!));
          return r;
        },
        taskGet: async (tid) => {
          if (broken) throw new Error("boom");
          return base.taskGet(tid);
        },
      },
    });
    await processGridRun(db, runs[0]!.runId, { drivers: flaky, pingbackBaseUrl: PINGBACK });
    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, runs[0]!.runId));
    for (const t of tasks) {
      const tok = new URL(urls.get(t.taskRef!)!).searchParams.get("token")!;
      await acceptPingback(db, { taskRef: t.taskRef!, token: tok });
    }
    await expect(processGridCollect(db, tasks[0]!.id, { drivers: flaky })).rejects.toThrow("boom");
    expect(
      await processGridCollect(db, tasks[0]!.id, { drivers: flaky, isFinalAttempt: true }),
    ).toBe("failed");
    broken = false;
    for (const t of tasks.slice(1)) {
      expect(await processGridCollect(db, t.id, { drivers: flaky })).toBe("done");
    }
    const [r] = await db.select().from(gridRuns).where(eq(gridRuns.id, runs[0]!.runId));
    expect(r!.status).toBe("done");
    // 8 of 9 points collected: charged 8/9 of the estimate.
    expect(Number(r!.costChargedUsd)).toBeLessThan(Number(r!.costEstimateUsd));
    expect(Number(r!.costChargedUsd)).toBeGreaterThan(0);
  });
});

describe("schedules", () => {
  it("enqueues runs for due configs only, once per period, and skips over-budget orgs", async () => {
    const o = await makeOrg();
    const daily = await createConfig(o, { schedule: "daily" });
    const manual = await createConfig(o, { schedule: "manual" });
    const weekly = await createConfig(o, { schedule: "weekly" });
    const inactive = await createConfig(o, { schedule: "daily" });
    await run(o.manager, "geogrid.configs.update", { id: inactive, active: false });
    const now = new Date();
    await db
      .update(gridConfigs)
      .set({ lastScheduledAt: new Date(now.getTime() - 2 * 24 * 3600_000) })
      .where(eq(gridConfigs.id, weekly)); // 2 days ago: weekly not due

    const mine = async (id: string) =>
      (await db.select().from(gridRuns).where(eq(gridRuns.configId, id))).length;

    const r1 = await enqueueDueGridRuns(db, { drivers, now, orgIds: [o.orgId] });
    expect(r1.enqueued).toBe(1);
    expect(await mine(daily)).toBe(1);
    expect(await mine(manual)).toBe(0);
    expect(await mine(weekly)).toBe(0);
    expect(await mine(inactive)).toBe(0);
    const [runRow] = await db.select().from(gridRuns).where(eq(gridRuns.configId, daily));
    expect(runRow).toMatchObject({ status: "queued", requestedBy: null });
    expect(await jobCount(GRID_RUN_QUEUE, "runId", runRow!.id)).toBe(1);

    await enqueueDueGridRuns(db, { drivers, now, orgIds: [o.orgId] }); // same period: nothing new
    expect(await mine(daily)).toBe(1);

    // Over budget: skipped, audited, still marked scheduled.
    const o2 = await makeOrg();
    await run(o2.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0 });
    const c2 = await createConfig(o2, { schedule: "daily" });
    const r2 = await enqueueDueGridRuns(db, { drivers, now, orgIds: [o2.orgId] });
    expect(r2.skippedBudget).toBe(1);
    expect(await mine(c2)).toBe(0);
    expect(await auditActions(o2.orgId)).toContain("geogrid.schedule_skipped");
    const [cfg] = await db.select().from(gridConfigs).where(eq(gridConfigs.id, c2));
    expect(cfg!.lastScheduledAt).not.toBeNull();
    expect(
      (
        await db
          .select()
          .from(gridRuns)
          .where(and(eq(gridRuns.orgId, o2.orgId)))
      ).length,
    ).toBe(0);
  });
});
