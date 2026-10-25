import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  auditLog,
  gridConfigs,
  notifications,
  gridRuns,
  gridTasks,
  locations,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { monthToDateUsd, PlatformCapExceededError, platformDayToDateUsd } from "./geogrid/cost";
import {
  createDriverRegistry,
  DfsAccountError,
  fixtureByoTransport,
  fixtureDataForSeoTransport,
  type DataForSeoTransport,
} from "./geogrid/drivers";
import { notifyBudgetExceeded, GEOGRID_BUDGET_EXCEEDED_KIND } from "./geogrid/budget-alert";
import { acceptPingback, enqueueDueGridRuns, GRID_COLLECT_QUEUE, GRID_RUN_QUEUE, finalizeRunIfSettled, processGridCollect, processGridRun, requestGridRuns } from "./geogrid/run";

// K1 Task 8: data source snapshot, platform daily cap, provider cost, partial submits, cost log.
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
// enqueueJob inserts into pg-boss queues, which must exist; do not rely on another test file having created them.
const boss = new PgBoss(url);
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  // Live-source runs count toward the platform's daily cap; a reused test database must not accumulate them.
  await db.delete(gridRuns).where(inArray(gridRuns.orgId, madeOrgs));
  await sql.end();
});
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const madeOrgs: string[] = [];
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
  const [loc] = await db
    .insert(locations)
    .values({ orgId, workspaceId: ws!.id, name: "locations/1", title: "Acme Dental" })
    .returning();
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
  return { orgId, owner, manager, config: config!, userId: owner.userId };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const noAudit = async () => {};
const request = (o: Org, drivers: ReturnType<typeof createDriverRegistry>, now: Date) =>
  db.transaction((tx) => requestGridRuns(tx, { config: o.config, requestedBy: null, audit: noAudit, drivers, now }));
const liveReg = (transport: DataForSeoTransport = fixtureDataForSeoTransport()) =>
  createDriverRegistry({ source: () => "live", liveDataForSeo: () => transport });

/** A run row in another org, to fill the platform's day. */
async function seedRun(
  o: Org,
  v: { createdAt: Date; dataSource?: "fixture" | "sandbox" | "live"; byo?: boolean; estimate?: string; cost?: string | null; status?: "queued" | "done" },
) {
  await db.insert(gridRuns).values({
    orgId: o.orgId,
    configId: o.config.id,
    keyword: "seed",
    driverId: "dataforseo_standard",
    status: v.status ?? "queued",
    byo: v.byo ?? false,
    dataSource: v.dataSource ?? "live",
    costEstimateUsd: "0",
    providerEstimateUsd: v.estimate ?? "0",
    providerCostUsd: v.cost ?? null,
    createdAt: v.createdAt,
  });
}
const clean = (o: Org) => db.delete(gridRuns).where(eq(gridRuns.orgId, o.orgId));

let seedOrg: Org;
beforeAll(async () => {
  seedOrg = await makeOrg();
});

describe("K1: data source snapshot", () => {
  it("(a) live stores data_source and the provider estimate; fixture stores both as fixture and 0", async () => {
    const o = await makeOrg();
    const live = await request(o, liveReg(), new Date());
    const [lr] = await db.select().from(gridRuns).where(eq(gridRuns.id, live[0]!.runId));
    expect(lr).toMatchObject({ dataSource: "live", byo: false });
    expect(Number(lr!.providerEstimateUsd)).toBeCloseTo(9 * 0.0006, 6);
    expect(Number(lr!.costEstimateUsd)).toBeGreaterThan(0);

    const fx = await request(o, createDriverRegistry(), new Date());
    const [fr] = await db.select().from(gridRuns).where(eq(gridRuns.id, fx[0]!.runId));
    expect(fr).toMatchObject({ dataSource: "fixture" });
    expect(Number(fr!.costEstimateUsd)).toBe(0);
    expect(Number(fr!.providerEstimateUsd)).toBe(0);
    // The caller still sees what a live run would cost.
    expect(fx[0]!.costEstimateUsd).toBeGreaterThan(0);

    const sb = await request(o, createDriverRegistry({ source: () => "sandbox", liveDataForSeo: () => fixtureDataForSeoTransport() }), new Date());
    const [sr] = await db.select().from(gridRuns).where(eq(gridRuns.id, sb[0]!.runId));
    expect(sr).toMatchObject({ dataSource: "sandbox" });
    expect(Number(sr!.costEstimateUsd)).toBe(0);
  });

  it("(a) BYO stores the source too, at cost, and spends none of the platform cap", async () => {
    const o = await makeOrg();
    await executeAction(db, o.owner, "geogrid.byoKey.set", { login: "me@example.test", password: "pw-secret" });
    const reg = createDriverRegistry({ source: () => "live", liveDataForSeo: () => fixtureDataForSeoTransport(), liveByoDataForSeo: fixtureByoTransport });
    const r = await request(o, reg, new Date());
    const [row] = await db.select().from(gridRuns).where(eq(gridRuns.id, r[0]!.runId));
    expect(row).toMatchObject({ byo: true, dataSource: "live" });
    expect(Number(row!.providerEstimateUsd)).toBe(0);
    expect(Number(row!.costEstimateUsd)).toBeCloseTo(9 * 0.0006, 6);
  });
});

describe("K1: platform daily cap", () => {
  const day = (d: number) => new Date(Date.UTC(2031, 2, d, 12));

  it("(b) refuses a request that would pass $5.00 and writes nothing", async () => {
    const o = await makeOrg();
    const now = day(4);
    await seedRun(seedOrg, { createdAt: now, estimate: "4.9960" });
    const err = await request(o, liveReg(), now).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformCapExceededError);
    expect((err as CoreError).code).toBe("FORBIDDEN");
    expect((err as Error).message.startsWith("PLATFORM_CAP_EXCEEDED:")).toBe(true);
    expect(await db.select().from(gridRuns).where(eq(gridRuns.configId, o.config.id))).toHaveLength(0);
    await clean(seedOrg);
  });

  it("(b) boundary: landing exactly on $5.00 is allowed", async () => {
    const o = await makeOrg();
    const now = day(5);
    await seedRun(seedOrg, { createdAt: now, estimate: "4.9946" });
    expect(await request(o, liveReg(), now)).toHaveLength(1);
    await clean(seedOrg);
  });

  it("(b) BYO, fixture, sandbox and yesterday do not count; a settled run counts its cost, not its estimate", async () => {
    const now = day(6);
    await seedRun(seedOrg, { createdAt: now, estimate: "9", byo: true });
    await seedRun(seedOrg, { createdAt: now, estimate: "9", dataSource: "fixture" });
    await seedRun(seedOrg, { createdAt: now, estimate: "9", dataSource: "sandbox" });
    await seedRun(seedOrg, { createdAt: day(5), estimate: "9" });
    expect(await platformDayToDateUsd(db, now)).toBe(0);
    await seedRun(seedOrg, { createdAt: now, estimate: "4.9000", cost: "0.1000", status: "done" });
    expect(await platformDayToDateUsd(db, now)).toBeCloseTo(0.1, 6);
    await clean(seedOrg);
  });

  it("(c) the cap does not apply to fixture or sandbox requests, nor to BYO", async () => {
    const o = await makeOrg();
    const now = day(7);
    await seedRun(seedOrg, { createdAt: now, estimate: "4.9990" });
    expect(await request(o, createDriverRegistry(), now)).toHaveLength(1);
    expect(await request(o, createDriverRegistry({ source: () => "sandbox", liveDataForSeo: () => fixtureDataForSeoTransport() }), now)).toHaveLength(1);
    await executeAction(db, o.owner, "geogrid.byoKey.set", { login: "me@example.test", password: "pw-secret" });
    const byoReg = createDriverRegistry({ source: () => "live", liveDataForSeo: () => fixtureDataForSeoTransport(), liveByoDataForSeo: fixtureByoTransport });
    expect(await request(o, byoReg, now)).toHaveLength(1);
    await clean(seedOrg);
  });

  it("(c2) fixture runs cost nothing anywhere: $30 of them this month do not touch the $25 budget", async () => {
    const o = await makeOrg();
    const now = new Date();
    await db.insert(gridRuns).values({
      orgId: o.orgId, configId: o.config.id, keyword: "seed", driverId: "dataforseo_standard", status: "done",
      dataSource: "fixture", costEstimateUsd: "30", costChargedUsd: "30",
    });
    expect(await monthToDateUsd(db, o.orgId, now)).toBe(0);
    expect(await request(o, liveReg(), now)).toHaveLength(1);
  });
});

describe("K1: submit outcomes", () => {
  const PINGBACK = "https://worker.test";

  it("(d) a partial submit keeps the created tasks, fails the rest, records the provider cost, and settles pro rata", async () => {
    const o = await makeOrg();
    const base = fixtureDataForSeoTransport();
    const urls = new Map<string, string>();
    const transport: DataForSeoTransport = {
      taskGet: base.taskGet,
      taskPost: async (items) => {
        const r = await base.taskPost(items);
        r.tasks.forEach((t, i) => urls.set(t.id, items[i]!.pingback_url!));
        for (const i of [1, 3, 5, 7]) r.tasks[i] = { id: "", status_code: 40501, status_message: "Invalid Field: 'tag'.", cost: 0, result: null };
        return { ...r, cost: 0.003 };
      },
    };
    const reg = liveReg(transport);
    const [req] = await request(o, reg, new Date());
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await processGridRun(db, req!.runId, { drivers: reg, pingbackBaseUrl: PINGBACK })).toBe("running");
    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, req!.runId));
    const submitted = tasks.filter((t) => t.status === "submitted");
    expect(submitted).toHaveLength(5);
    expect(submitted.every((t) => t.submittedAt !== null && t.taskRef)).toBe(true);
    const failed = tasks.filter((t) => t.status === "failed");
    expect(failed).toHaveLength(4);
    expect(failed[0]!.error).toContain("40501");
    const [run] = await db.select().from(gridRuns).where(eq(gridRuns.id, req!.runId));
    expect(run).toMatchObject({ status: "running" });
    expect(Number(run!.providerCostUsd)).toBeCloseTo(0.003, 6);
    // (f) the cost line on submit: ids and numbers only.
    const submitLine = logs.mock.calls.map((c) => String(c[0])).find((l) => l.includes("submitted source=live"))!;
    expect(submitLine).toBe(
      `[geogrid] run ${req!.runId} submitted source=live points=9 tasks_created=5 provider_cost_usd=0.0030 estimate_usd=${Number(run!.costEstimateUsd).toFixed(4)}`,
    );

    for (const t of submitted) {
      const token = new URL(urls.get(t.taskRef!)!).searchParams.get("token")!;
      expect(await acceptPingback(db, { taskRef: t.taskRef!, token })).toBe("accepted");
      expect(await processGridCollect(db, t.id, { drivers: reg })).toBe("done");
    }
    const [done] = await db.select().from(gridRuns).where(eq(gridRuns.id, req!.runId));
    expect(done!.status).toBe("done");
    expect(Number(done!.costChargedUsd)).toBeCloseTo((Number(done!.costEstimateUsd) * 5) / 9, 3);
    const finishLine = logs.mock.calls.map((c) => String(c[0])).find((l) => l.includes("finished status=done"))!;
    expect(finishLine).toBe(
      `[geogrid] run ${req!.runId} finished status=done collected=5/9 provider_cost_usd=0.0030 charged_usd=${Number(done!.costChargedUsd).toFixed(4)}`,
    );
    expect(logs.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("dentist");
    logs.mockRestore();
  });

  it("(e) an account error on submit fails the run, charges nothing, and alerts exactly once", async () => {
    const o = await makeOrg();
    const reg = liveReg({
      taskGet: fixtureDataForSeoTransport().taskGet,
      taskPost: async () => {
        throw new DfsAccountError(40210, "Insufficient funds");
      },
    });
    const [req] = await request(o, reg, new Date());
    const alert = vi.fn(async () => ({}));
    expect(await processGridRun(db, req!.runId, { drivers: reg, pingbackBaseUrl: PINGBACK, alert })).toBe("failed");
    const [run] = await db.select().from(gridRuns).where(eq(gridRuns.id, req!.runId));
    expect(run).toMatchObject({ status: "failed", costChargedUsd: "0.0000" });
    expect(run!.error).toMatch(/^submit_failed: DataForSEO 40210/);
    expect(Number(run!.providerCostUsd)).toBe(0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(alert.mock.calls)).not.toContain("pw-");
    // Failed with nothing bought: it no longer counts toward the cap.
    expect(await platformDayToDateUsd(db, new Date(Date.UTC(2031, 2, 20)))).toBe(0);
  });

  it("every point refused: the run fails and nothing is charged", async () => {
    const o = await makeOrg();
    const base = fixtureDataForSeoTransport();
    const reg = liveReg({
      taskGet: base.taskGet,
      taskPost: async (items) => ({
        ...(await base.taskPost(items)),
        tasks: items.map(() => ({ id: "", status_code: 40501, status_message: "bad", cost: 0, result: null })),
      }),
    });
    const [req] = await request(o, reg, new Date());
    expect(await processGridRun(db, req!.runId, { drivers: reg, pingbackBaseUrl: PINGBACK })).toBe("failed");
    const [run] = await db.select().from(gridRuns).where(eq(gridRuns.id, req!.runId));
    expect(run).toMatchObject({ status: "failed", costChargedUsd: "0.0000" });
    expect(run!.error).toContain("40501");
  });

  it("collect uses the run's own data source: a fixture run is collected from the fixture even when the source is now live", async () => {
    const o = await makeOrg();
    const fixtureReg = createDriverRegistry();
    const [req] = await request(o, fixtureReg, new Date());
    const nowLive = createDriverRegistry({ source: () => "live", liveDataForSeo: () => { throw new Error("must not be used"); } });
    // Submit through the fixture (as it was requested), collect through a registry whose current source is live.
    const urls = new Map<string, string>();
    const base = fixtureDataForSeoTransport();
    const capturing = createDriverRegistry({
      dataForSeo: { taskGet: base.taskGet, taskPost: async (i) => { const r = await base.taskPost(i); r.tasks.forEach((t, k) => urls.set(t.id, i[k]!.pingback_url!)); return r; } },
    });
    expect(await processGridRun(db, req!.runId, { drivers: capturing, pingbackBaseUrl: PINGBACK })).toBe("running");
    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, req!.runId));
    for (const t of tasks) {
      const token = new URL(urls.get(t.taskRef!)!).searchParams.get("token")!;
      await acceptPingback(db, { taskRef: t.taskRef!, token });
      expect(await processGridCollect(db, t.id, { drivers: nowLive })).toBe("done");
    }
    expect(await db.transaction((tx) => finalizeRunIfSettled(tx, req!.runId))).toBe(false); // already finalised by the last collect
  });
});

describe("K1 Task 9: sweeper and not-ready", () => {
  const PINGBACK = "https://worker.test";
  const minutes = (n: number) => n * 60_000;

  async function submittedRun(o: Org, transport: DataForSeoTransport) {
    const reg = liveReg(transport);
    const [req] = await request(o, reg, new Date());
    await processGridRun(db, req!.runId, { drivers: reg, pingbackBaseUrl: PINGBACK });
    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, req!.runId));
    return { reg, runId: req!.runId, tasks };
  }

  it("(a) a not-ready collect puts the task back to submitted and does not throw", async () => {
    const o = await makeOrg();
    const base = fixtureDataForSeoTransport();
    const { reg, tasks } = await submittedRun(o, {
      taskPost: base.taskPost,
      taskGet: async (id) => ({ ...(await base.taskGet(id)), tasks: [{ id, status_code: 40602, status_message: "Task In Queue.", cost: 0, result: null }] }),
    });
    const t = tasks[0]!;
    await db.transaction((tx) => import("./geogrid/run").then((m) => m.markReceivedAndCollect(tx, t.id)));
    expect(await processGridCollect(db, t.id, { drivers: reg })).toBe("not_ready");
    const [after] = await db.select().from(gridTasks).where(eq(gridTasks.id, t.id));
    expect(after!.status).toBe("submitted");
  });

  it("(b) the sweeper collects stale tasks, leaves fresh ones, and gives up after the limit", async () => {
    const { sweepStaleGridTasks } = await import("./geogrid/sweep");
    const o = await makeOrg();
    const { runId, tasks } = await submittedRun(o, fixtureDataForSeoTransport());
    const [stale, old, ...fresh] = tasks;
    const now = new Date();
    await db.update(gridTasks).set({ submittedAt: new Date(now.getTime() - minutes(20)) }).where(eq(gridTasks.id, stale!.id));
    await db.update(gridTasks).set({ submittedAt: new Date(now.getTime() - minutes(200)) }).where(eq(gridTasks.id, old!.id));
    // Everything else was submitted just now: untouched.
    const r = await sweepStaleGridTasks(db, { now, orgIds: [o.orgId] });
    expect(r).toMatchObject({ checked: 2, enqueued: 1, failed: 1 });
    const rows = await db.select().from(gridTasks).where(eq(gridTasks.runId, runId));
    const by = new Map(rows.map((t) => [t.id, t]));
    expect(by.get(stale!.id)!.status).toBe("received");
    expect(by.get(old!.id)).toMatchObject({ status: "failed" });
    expect(by.get(old!.id)!.error).toBe("no_result: DataForSEO returned nothing within 3h");
    expect(fresh.every((t) => by.get(t.id)!.status === "submitted")).toBe(true);
    const jobs = await sql<{ id: string }[]>`select id from pgboss.job where name = 'geogrid.collect' and data->>'taskId' = ${stale!.id}`;
    expect(jobs).toHaveLength(1);
    // Running the sweeper again does nothing to what it already handled.
    expect(await sweepStaleGridTasks(db, { now, orgIds: [o.orgId] })).toMatchObject({ enqueued: 0, failed: 0 });
  });

  it("when the sweeper fails the last open task the run settles", async () => {
    const { sweepStaleGridTasks } = await import("./geogrid/sweep");
    const o = await makeOrg();
    const { runId, tasks } = await submittedRun(o, fixtureDataForSeoTransport());
    const now = new Date();
    // Eight points failed already; the last is stale beyond the limit.
    await db.update(gridTasks).set({ status: "failed", error: "x" }).where(eq(gridTasks.runId, runId));
    await db.update(gridTasks).set({ status: "submitted", error: null, submittedAt: new Date(now.getTime() - minutes(200)) }).where(eq(gridTasks.id, tasks[0]!.id));
    await sweepStaleGridTasks(db, { now, orgIds: [o.orgId] });
    const [run] = await db.select().from(gridRuns).where(eq(gridRuns.id, runId));
    expect(run).toMatchObject({ status: "failed", error: "No point could be collected" });
  });
});

describe("K1 Task 10: owner alert when a cap stops scans", () => {
  const jan = new Date(Date.UTC(2031, 0, 15, 12));
  const notes = (orgId: string) => db.select().from(notifications).where(eq(notifications.orgId, orgId));

  it("(a)(b) one notification per owner and admin, deduplicated for the month", async () => {
    const o = await makeOrg();
    const alert = vi.fn(async () => ({}));
    const r1 = await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: o.orgId, scope: "org", now: jan, alert }));
    expect(r1.notified).toBe(1); // the one owner; the manager is not told
    const rows = await notes(o.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: GEOGRID_BUDGET_EXCEEDED_KIND,
      title: "Rank tracking budget reached for January. Scans are paused until next month or a higher budget",
      link: "/geogrid?view=usage",
      sourceType: "geogrid_budget",
      sourceId: `${o.orgId}:2031-01`,
    });
    const r2 = await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: o.orgId, scope: "org", now: jan, alert }));
    expect(r2.notified).toBe(0);
    expect(await notes(o.orgId)).toHaveLength(1);
    const feb = new Date(Date.UTC(2031, 1, 2));
    expect((await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: o.orgId, scope: "org", now: feb, alert }))).notified).toBe(1);
    expect(alert).not.toHaveBeenCalled(); // org budget: no platform alert
    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    expect(audits.filter((a) => a.action === "notification.create").length).toBe(2);
    expect(JSON.stringify(audits)).not.toContain("Rank tracking budget");
  });

  it("(c) the platform cap names the service, and raises one platform alert per day", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    // The once-a-day check looks across all orgs; clear what an earlier run of this test left on the same dates.
    await sql`delete from notifications where source_type = 'geogrid_budget' and source_id like '%:platform:2031-%'`;
    const alert = vi.fn(async () => ({}));
    const day = new Date(Date.UTC(2031, 5, 9, 8));
    await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: a.orgId, scope: "platform", now: day, alert }));
    await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: b.orgId, scope: "platform", now: day, alert }));
    await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: a.orgId, scope: "platform", now: day, alert }));
    expect(alert).toHaveBeenCalledTimes(1);
    const rows = await notes(a.orgId);
    expect(rows[0]).toMatchObject({ title: "Rank scans are paused for today across the service", sourceId: `${a.orgId}:platform:2031-06-09` });
    expect(await notes(b.orgId)).toHaveLength(1);
    const next = new Date(Date.UTC(2031, 5, 10, 8));
    await db.transaction((tx) => notifyBudgetExceeded(tx, { orgId: a.orgId, scope: "platform", now: next, alert }));
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("(d) the scheduled path over budget notifies", async () => {
    const o = await makeOrg();
    await executeAction(db, o.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0 });
    await db.update(gridConfigs).set({ schedule: "daily", active: true }).where(eq(gridConfigs.id, o.config.id));
    const r = await enqueueDueGridRuns(db, { drivers: liveReg(), orgIds: [o.orgId], now: new Date() });
    expect(r.skippedBudget).toBe(1);
    const rows = await notes(o.orgId);
    expect(rows.map((n) => n.kind)).toEqual([GEOGRID_BUDGET_EXCEEDED_KIND]);
  });

  it("a refused manual geogrid.run leaves the notification behind even though the action rolls back", async () => {
    const o = await makeOrg();
    await executeAction(db, o.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0 });
    // The action layer must see a live source or a $0 budget would not matter (fixture runs cost nothing).
    const { setGeogridDriversForTests } = await import("./actions/geogrid");
    setGeogridDriversForTests(liveReg());
    try {
      await expect(executeAction(db, o.manager, "geogrid.run", { configId: o.config.id })).rejects.toThrow(/BUDGET_EXCEEDED/);
    } finally {
      setGeogridDriversForTests(null);
    }
    expect(await db.select().from(gridRuns).where(eq(gridRuns.configId, o.config.id))).toHaveLength(0);
    expect((await notes(o.orgId)).map((n) => n.kind)).toEqual([GEOGRID_BUDGET_EXCEEDED_KIND]);
  });
});

// K1 Done-when: one run end to end through the REAL live transport against a loopback fake DataForSEO server.
describe("K1 Done-when: a live run inside its cap, then a refusal that alerts the owner", () => {
  it("runs 3x3 live, records the provider cost and the cost line, then refuses over budget and notifies", async () => {
    const { createServer } = await import("node:http");
    const { liveDataForSeoTransport, platformDataForSeoCredentials, rankSource } = await import("./geogrid/drivers");
    const base = fixtureDataForSeoTransport();
    const seen: { method: string; url: string; auth: string | undefined; items: number }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const json = body ? JSON.parse(body) : null;
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, items: Array.isArray(json) ? json.length : 0 });
        let out: unknown;
        if (req.method === "POST") {
          const r = await base.taskPost(json);
          out = { ...r, cost: 0.0006 * json.length, tasks: r.tasks.map((t) => ({ ...t, cost: 0.0006 })) };
        } else {
          out = await base.taskGet(decodeURIComponent((req.url ?? "").split("/").pop()!));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    vi.stubEnv("DATAFORSEO_LOGIN", "owner@example.test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "pw-from-keys");
    try {
      expect(rankSource()).toBe("live");
      // Production accepts only the two DataForSEO hosts; the test injects the loopback base.
      const reg = createDriverRegistry({
        source: () => rankSource(),
        liveDataForSeo: () => liveDataForSeoTransport({ baseUrl, credentials: platformDataForSeoCredentials }),
      });
      const o = await makeOrg();
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      const [req] = await request(o, reg, new Date());
      const [queued] = await db.select().from(gridRuns).where(eq(gridRuns.id, req!.runId));
      expect(queued!.dataSource).toBe("live");

      // The worker's job: one POST with 9 items.
      expect(await processGridRun(db, req!.runId, { drivers: reg, pingbackBaseUrl: "https://worker.test" })).toBe("running");
      const posts = seen.filter((s) => s.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ url: "/v3/serp/google/maps/task_post", items: 9 });
      expect(posts[0]!.auth).toBe(`Basic ${Buffer.from("owner@example.test:pw-from-keys").toString("base64")}`);

      // Results: the pingback path (token check, duplicates) is covered in geogrid.test.ts. Here the
      // stale-task sweeper stands in for the pingback, as it does for a lost one.
      const sent = await db.select().from(gridTasks).where(eq(gridTasks.runId, req!.runId));
      expect(sent).toHaveLength(9);
      const { sweepStaleGridTasks } = await import("./geogrid/sweep");
      await db.update(gridTasks).set({ submittedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(gridTasks.runId, req!.runId));
      expect(await sweepStaleGridTasks(db, { orgIds: [o.orgId] })).toMatchObject({ checked: 9, enqueued: 9, failed: 0 });
      for (const t of sent) expect(await processGridCollect(db, t.id, { drivers: reg })).toBe("done");

      const [done] = await db.select().from(gridRuns).where(eq(gridRuns.id, req!.runId));
      expect(done).toMatchObject({ status: "done", dataSource: "live" });
      expect(Number(done!.providerCostUsd)).toBeCloseTo(0.0054, 6);
      const lines = logs.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith(`[geogrid] run ${req!.runId} submitted source=live points=9 tasks_created=9 provider_cost_usd=0.0054`))).toBe(true);
      expect(lines.some((l) => l.startsWith(`[geogrid] run ${req!.runId} finished status=done collected=9/9 provider_cost_usd=0.0054`))).toBe(true);
      expect(lines.join("\n")).not.toContain("pw-from-keys");
      logs.mockRestore();

      // Over the org's budget: refused, nothing written, the owner is told.
      await executeAction(db, o.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0.001 });
      const { setGeogridDriversForTests } = await import("./actions/geogrid");
      setGeogridDriversForTests(reg);
      try {
        await expect(executeAction(db, o.manager, "geogrid.run", { configId: o.config.id })).rejects.toThrow(/BUDGET_EXCEEDED/);
      } finally {
        setGeogridDriversForTests(null);
      }
      expect(await db.select().from(gridRuns).where(eq(gridRuns.configId, o.config.id))).toHaveLength(1);
      const alerts = (await db.select().from(notifications).where(eq(notifications.orgId, o.orgId))).filter((n) => n.kind === GEOGRID_BUDGET_EXCEEDED_KIND);
      expect(alerts).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
