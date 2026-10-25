import { afterAll, describe, expect, it } from "vitest";
import { createDb, gridRuns, locations, memberships, organizations, users, workspaces } from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { PERMISSIONS, ROLE_PERMISSIONS, type Role } from "./permissions";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

async function makeOrg() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const mkUser = async (role: Role, workspaceId?: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
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
    approver: await mkUser("client_approver", ws!.id),
    viewer: await mkUser("client_viewer", ws!.id),
  };
}

const run = <T = never>(actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input) as Promise<T>;

describe("U7: agency cost settings are not for client roles", () => {
  it("every role that can manage trackers can also see their cost, and no client role can", () => {
    const withCost = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes("geogrid:cost"));
    expect(withCost.sort()).toEqual(["admin", "manager", "owner"]);
    for (const r of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      if (ROLE_PERMISSIONS[r].includes("geogrid:manage")) expect(ROLE_PERMISSIONS[r]).toContain("geogrid:cost");
    }
    expect(PERMISSIONS).toContain("geogrid:cost");
  });

  it("settings.get, preview and usage are FORBIDDEN for client roles and work for agency roles", async () => {
    const o = await makeOrg();
    const preview = { driverId: "dataforseo_standard", gridSize: 3, keywordCount: 1 };
    const usage = { from: "2026-01-01", to: "2026-01-31" };
    for (const who of [o.viewer, o.approver]) {
      expect(await codeOf(run(who, "geogrid.settings.get"))).toBe("FORBIDDEN");
      expect(await codeOf(run(who, "geogrid.preview", preview))).toBe("FORBIDDEN");
      expect(await codeOf(run(who, "geogrid.usage", usage))).toBe("FORBIDDEN");
    }
    for (const who of [o.owner, o.admin, o.manager]) {
      expect(await run(who, "geogrid.settings.get")).toMatchObject({ markupPercent: expect.any(Number) });
      expect(await run(who, "geogrid.preview", preview)).toMatchObject({ markupPercent: expect.any(Number) });
      expect(await codeOf(run(who, "geogrid.usage", usage))).toBe("no error");
    }
  });

  it("runs.list and runs.get hide cost fields from a client viewer and show them to a manager", async () => {
    const o = await makeOrg();
    const { config } = await run<{ config: { id: string } }>(o.manager, "geogrid.configs.create", {
      locationId: o.loc,
      keywords: ["dentist"],
      gridSize: 3,
      radiusM: 3000,
      centerLat: 51.5,
      centerLng: -0.12,
    });
    const [r] = await db
      .insert(gridRuns)
      .values({ orgId: o.orgId, configId: config.id, keyword: "dentist", driverId: "dataforseo_standard", status: "done", costEstimateUsd: "1.2500", costChargedUsd: "1.2500" })
      .returning();
    type Runs = { runs: { costEstimateUsd: number | null; costChargedUsd: number | null }[] };
    const mine = await run<Runs>(o.manager, "geogrid.runs.list", { configId: config.id });
    expect(mine.runs[0]).toMatchObject({ costEstimateUsd: 1.25, costChargedUsd: 1.25 });
    const theirs = await run<Runs>(o.viewer, "geogrid.runs.list", { configId: config.id });
    expect(theirs.runs).toHaveLength(1);
    expect(theirs.runs[0]).toMatchObject({ costEstimateUsd: null, costChargedUsd: null });
    const got = await run<{ run: { costEstimateUsd: number | null; costChargedUsd: number | null } }>(o.viewer, "geogrid.runs.get", { runId: r!.id });
    expect(got.run).toMatchObject({ costEstimateUsd: null, costChargedUsd: null });
    const gotMgr = await run<{ run: { costChargedUsd: number | null } }>(o.manager, "geogrid.runs.get", { runId: r!.id });
    expect(gotMgr.run.costChargedUsd).toBe(1.25);
  });

  it("K1: runs.get returns dataSource to everyone and providerCostUsd only with geogrid:cost", async () => {
    const o = await makeOrg();
    const { config } = await run<{ config: { id: string } }>(o.manager, "geogrid.configs.create", {
      locationId: o.loc, keywords: ["dentist"], gridSize: 3, radiusM: 3000, centerLat: 51.5, centerLng: -0.12,
    });
    const [live] = await db
      .insert(gridRuns)
      .values({ orgId: o.orgId, configId: config.id, keyword: "dentist", driverId: "dataforseo_standard", status: "done", dataSource: "live", costEstimateUsd: "0.0070", costChargedUsd: "0.0070", providerCostUsd: "0.0054" })
      .returning();
    const [fixture] = await db
      .insert(gridRuns)
      .values({ orgId: o.orgId, configId: config.id, keyword: "dentist", driverId: "dataforseo_standard", status: "done", costEstimateUsd: "0", costChargedUsd: "0" })
      .returning();
    type Got = { run: { dataSource: string; providerCostUsd: number | null } };
    expect((await run<Got>(o.manager, "geogrid.runs.get", { runId: live!.id })).run).toMatchObject({ dataSource: "live", providerCostUsd: 0.0054 });
    expect((await run<Got>(o.viewer, "geogrid.runs.get", { runId: live!.id })).run).toMatchObject({ dataSource: "live", providerCostUsd: null });
    expect((await run<Got>(o.manager, "geogrid.runs.get", { runId: fixture!.id })).run).toMatchObject({ dataSource: "fixture", providerCostUsd: null });
    const list = await run<{ runs: { id: string; dataSource: string }[] }>(o.viewer, "geogrid.runs.list", { configId: config.id });
    expect(list.runs.map((r) => r.dataSource).sort()).toEqual(["fixture", "live"]);
  });
});
