import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  gridRuns,
  locations,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { executeAction } from "./executor";
import { setGeogridDriversForTests } from "./actions/geogrid";
import { createLiveDriverRegistry } from "./geogrid/drivers/live";
import { GRID_COLLECT_QUEUE, GRID_RUN_QUEUE } from "./geogrid/run";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const LOGIN = "jane.doe@example.com";
const PASSWORD = `pw-${uniq()}-SECRET`;

const madeOrgs: string[] = [];
async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  madeOrgs.push(orgId);
  const mkUser = async (role: "owner" | "admin" | "manager" | "client_viewer", ws?: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId: ws });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ orgId, workspaceId: ws!.id, name: "locations/1", title: "Acme Dental" })
    .returning();
  return {
    orgId,
    loc: loc!.id,
    owner: await mkUser("owner"),
    admin: await mkUser("admin"),
    manager: await mkUser("manager"),
    viewer: await mkUser("client_viewer", ws!.id),
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

async function createConfig(o: Org) {
  const r = (await run(o.manager, "geogrid.configs.create", {
    locationId: o.loc,
    keywords: ["dentist"],
    gridSize: 3,
    radiusM: 3000,
    centerLat: 51.5074,
    centerLng: -0.1278,
  })) as { config: { id: string } };
  return r.config.id;
}


// A community self-hoster has no DATAFORSEO_* in the environment and saves a key in the app instead.
// The production registry is used on purpose: its source decision is what is under test.
const saved = { login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD, base: process.env.DATAFORSEO_API_BASE };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
beforeEach(() => {
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  delete process.env.DATAFORSEO_API_BASE;
});
afterEach(() => {
  restore("DATAFORSEO_LOGIN", saved.login);
  restore("DATAFORSEO_PASSWORD", saved.password);
  restore("DATAFORSEO_API_BASE", saved.base);
  vi.unstubAllGlobals();
});
beforeAll(async () => {
  setGeogridDriversForTests(createLiveDriverRegistry());
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
});
afterAll(async () => {
  await db.delete(gridRuns).where(inArray(gridRuns.orgId, madeOrgs));
  setGeogridDriversForTests(null);
  await boss.stop();
  await sql.end();
});

const runRow = async (id: string) => (await db.select().from(gridRuns).where(eq(gridRuns.id, id)))[0]!;

describe("an organization key on a server with no DataForSEO keys in the environment", () => {
  it("a rank run is live with the org's key, at cost, and counts against neither the platform cap nor a credit balance", async () => {
    const o = await makeOrg();
    const id = await createConfig(o);
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as { runs: { runId: string; costEstimateUsd: number }[] };
    const row = await runRow(out.runs[0]!.runId);
    expect(row).toMatchObject({ byo: true, dataSource: "live" });
    expect(Number(row.costEstimateUsd)).toBeCloseTo(9 * 0.0006, 4);
    expect(Number(row.providerEstimateUsd)).toBe(0);
  });

  it("a quick scan is live with the org's key", async () => {
    const o = await makeOrg();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.orgId, o.orgId));
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const out = (await run(o.manager, "geogrid.quickScans.create", {
      workspaceId: ws!.id, businessName: "Prospect", placeId: "ChIJ-prospect-place-id", keyword: "dentist", gridSize: 3, radiusM: 3000, centerLat: 51.5, centerLng: -0.12,
    })) as { runs: { runId: string }[] };
    expect(await runRow(out.runs[0]!.runId)).toMatchObject({ byo: true, dataSource: "live" });
  });

  it("an org without a key still gets sample data on that server", async () => {
    const o = await makeOrg();
    const id = await createConfig(o);
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as { runs: { runId: string }[] };
    expect(await runRow(out.runs[0]!.runId)).toMatchObject({ byo: false, dataSource: "fixture" });
  });

  it("the sandbox host in the environment still means sandbox for an org key", async () => {
    process.env.DATAFORSEO_API_BASE = "https://sandbox.dataforseo.com";
    const o = await makeOrg();
    const id = await createConfig(o);
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as { runs: { runId: string }[] };
    expect(await runRow(out.runs[0]!.runId)).toMatchObject({ byo: true, dataSource: "sandbox" });
  });

  it("verify really calls DataForSEO with the org's login", async () => {
    const o = await makeOrg();
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ money: { balance: 5 } }] }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const v = (await run(o.owner, "geogrid.byoKey.verify")) as { ok: boolean };
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toContain("dataforseo.com");
    expect(JSON.stringify(init.headers)).toContain(Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64"));
    expect(v.ok).toBe(true);
  });
});
