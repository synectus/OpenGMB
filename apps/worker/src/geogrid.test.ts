import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  GRID_COLLECT_QUEUE,
  GRID_RUN_QUEUE,
  createDriverRegistry,
  fixtureDataForSeoTransport,
  processGridCollect,
  processGridRun,
} from "@opengmb/core";
import {
  createDb,
  gridConfigs,
  gridPoints,
  gridRuns,
  gridTasks,
  locations,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

const pingbackUrls = new Map<string, string>();
const base0 = fixtureDataForSeoTransport();
const drivers = createDriverRegistry({
  dataForSeo: {
    taskGet: base0.taskGet,
    taskPost: async (items) => {
      const res = await base0.taskPost(items);
      res.tasks.forEach((t, i) => pingbackUrls.set(t.id, items[i]!.pingback_url!));
      return res;
    },
  },
});

const jobsFor = async (taskId: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from pgboss.job where name = ${GRID_COLLECT_QUEUE} and data->>'taskId' = ${taskId}`
  ).length;

beforeAll(async () => {
  boss.on("error", (e) => console.error(e));
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
  server = await startServer(0, { db, boss, pubsub: null });
  base = `http://localhost:${server.port}`;
});
afterAll(async () => {
  await server.close();
  await boss.stop();
  await sql.end();
});

describe("/webhooks/dataforseo", () => {
  it("authenticates by per-task token, ignores duplicates, and the collect job finishes the run", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `org-${uniq()}` })
      .returning();
    const orgId = org!.id;
    const userId = `u-${uniq()}`;
    await db.insert(users).values({ id: userId, name: "T", email: `${userId}@example.test` });
    const [ws] = await db.insert(workspaces).values({ orgId, name: "ws" }).returning();
    const [loc] = await db
      .insert(locations)
      .values({ orgId, workspaceId: ws!.id, name: "Loc", title: "Acme Dental" })
      .returning();
    const [config] = await db
      .insert(gridConfigs)
      .values({
        orgId,
        workspaceId: ws!.id,
        locationId: loc!.id,
        keywords: ["dentist"],
        gridSize: 3,
        radiusM: 2000,
        centerLat: 40.7128,
        centerLng: -74.006,
        targetName: "Acme Dental",
        driverId: "dataforseo_standard",
        createdBy: userId,
      })
      .returning();
    const [runRow] = await db
      .insert(gridRuns)
      .values({
        orgId,
        configId: config!.id,
        keyword: "dentist",
        driverId: "dataforseo_standard",
        costEstimateUsd: "0.0070",
      })
      .returning();
    const runId = runRow!.id;
    expect(await processGridRun(db, runId, { drivers, pingbackBaseUrl: base })).toBe("running");

    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, runId));
    expect(tasks).toHaveLength(9);
    const t0 = tasks[0]!;
    // The URL DataForSEO was given points at this worker; "$id" is DataForSEO's substitution.
    const given = pingbackUrls.get(t0.taskRef!)!;
    expect(given.startsWith(`${base}/webhooks/dataforseo?id=$id&token=`)).toBe(true);
    const good = (t: typeof t0) =>
      pingbackUrls.get(t.taskRef!)!.replace("$id", encodeURIComponent(t.taskRef!));

    // Missing params, wrong token, unknown task: all 401, and nothing is enqueued.
    expect((await fetch(`${base}/webhooks/dataforseo`)).status).toBe(401);
    expect((await fetch(`${base}/webhooks/dataforseo?id=${t0.taskRef}`)).status).toBe(401);
    expect(
      (await fetch(`${base}/webhooks/dataforseo?id=${encodeURIComponent(t0.taskRef!)}&token=nope`))
        .status,
    ).toBe(401);
    expect((await fetch(`${base}/webhooks/dataforseo?id=fx-unknown&token=nope`)).status).toBe(401);
    expect(await jobsFor(t0.id)).toBe(0);
    expect((await fetch(`${base}/webhooks/dataforseo`, { method: "PUT" })).status).toBe(405);

    // Valid GET: accepted once; repeat (GET or POST) is a 200 no-op.
    const first = await fetch(good(t0));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    const again = await fetch(good(t0));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    const viaPost = await fetch(good(t0), { method: "POST", body: "{}" });
    expect(await viaPost.json()).toEqual({ ok: true, duplicate: true });
    expect(await jobsFor(t0.id)).toBe(1);

    // Another task's token does not work for this task id.
    const t1 = tasks[1]!;
    const crossed = `${base}/webhooks/dataforseo?id=${encodeURIComponent(t1.taskRef!)}&token=${new URL(good(t0)).searchParams.get("token")}`;
    expect((await fetch(crossed)).status).toBe(401);

    // Deliver the rest and run the collect jobs.
    for (const t of tasks.slice(1)) expect((await fetch(good(t))).status).toBe(200);
    for (const t of tasks) {
      expect(await processGridCollect(db, t.id, { drivers })).toBe("done");
    }
    const [done] = await db.select().from(gridRuns).where(eq(gridRuns.id, runId));
    expect(done!.status).toBe("done");
    expect(Number(done!.costChargedUsd)).toBeCloseTo(0.007, 4);
    const pts = await db.select().from(gridPoints).where(eq(gridPoints.runId, runId));
    expect(pts).toHaveLength(9);
    expect(pts.every((p) => (p.competitors as unknown[]).length === 20)).toBe(true);
  });
});
