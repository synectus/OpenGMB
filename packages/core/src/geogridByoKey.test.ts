import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  gridRuns,
  gridTasks,
  locations,
  memberships,
  orgDataforseoCredentials,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { decryptSecret } from "./crypto";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { runPreview } from "./proposals";
import { geogridByoKeySet } from "./actions/geogridByoKey";
import { setGeogridDriversForTests } from "./actions/geogrid";
import { fixtureByoTransport, fixtureDataForSeoTransport, createDriverRegistry, type DfsCredentials } from "./geogrid/drivers";
import { monthToDateUsd } from "./geogrid/cost";
import {
  acceptPingback,
  GRID_COLLECT_QUEUE,
  GRID_RUN_QUEUE,
  processGridCollect,
  processGridRun,
} from "./geogrid/run";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const LOGIN = "jane.doe@example.com";
const PASSWORD = `pw-${uniq()}-SECRET`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
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

// Live data source, offline transport: runs record real-looking costs and nothing leaves the process.
beforeAll(async () => {
  setGeogridDriversForTests(
    createDriverRegistry({
      source: () => "live",
      liveDataForSeo: () => fixtureDataForSeoTransport(),
      liveByoDataForSeo: (creds) => fixtureByoTransport(creds),
    }),
  );
  await boss.start();
  await boss.createQueue(GRID_RUN_QUEUE);
  await boss.createQueue(GRID_COLLECT_QUEUE);
});
afterAll(async () => {
  // Live-source runs count toward the platform's daily cap; a reused test database must not accumulate them.
  await db.delete(gridRuns).where(inArray(gridRuns.orgId, madeOrgs));
  setGeogridDriversForTests(null);
  await boss.stop();
  await sql.end();
});

describe("geogrid.byoKey", () => {
  it("stores an encrypted key, never returns or audits the password, round-trips the encryption", async () => {
    const o = await makeOrg();
    expect(await run(o.owner, "geogrid.byoKey.get")).toEqual({
      configured: false,
      login: null,
      lastVerifiedAt: null,
    });
    const set = await run(o.admin, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    expect(set).toEqual({ configured: true, login: "ja***@example.com", lastVerifiedAt: null });

    const [row] = await db
      .select()
      .from(orgDataforseoCredentials)
      .where(eq(orgDataforseoCredentials.orgId, o.orgId));
    expect(row!.passwordEnc).not.toContain(PASSWORD);
    expect(row!.passwordEnc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(row!.passwordEnc)).toBe(PASSWORD);

    const verify = await run(o.owner, "geogrid.byoKey.verify");
    expect(verify).toMatchObject({ ok: true });
    const got = await run(o.owner, "geogrid.byoKey.get");
    expect(got).toMatchObject({ configured: true, login: "ja***@example.com" });
    expect((got as { lastVerifiedAt: string | null }).lastVerifiedAt).not.toBeNull();

    // Replacing the key clears the verified time.
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: `${PASSWORD}2` });
    expect(await run(o.owner, "geogrid.byoKey.get")).toMatchObject({ lastVerifiedAt: null });

    // Nothing the actions returned or the audit log holds contains the password, its ciphertext, or the raw login.
    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, o.orgId));
    const dump = JSON.stringify([set, verify, got, rows]);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["geogrid.byo_key_set", "geogrid.byo_key_verified"]),
    );
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(row!.passwordEnc);
    expect(dump).not.toContain(LOGIN);

    await run(o.owner, "geogrid.byoKey.delete");
    expect(await run(o.owner, "geogrid.byoKey.get")).toMatchObject({ configured: false });
    expect(await codeOf(run(o.owner, "geogrid.byoKey.delete"))).toBe("NOT_FOUND");
    expect(await codeOf(run(o.owner, "geogrid.byoKey.verify"))).toBe("NOT_FOUND");
  });

  it("the dry-run preview never echoes the login or password", async () => {
    const o = await makeOrg();
    const p = await runPreview(db, o.owner, geogridByoKeySet, { login: LOGIN, password: PASSWORD });
    expect(JSON.stringify(p)).not.toContain(PASSWORD);
    expect(JSON.stringify(p)).not.toContain(LOGIN);
    expect(JSON.stringify(p)).not.toContain("jane");
  });

  it("verify reports failure for a bad key and does not mark it verified", async () => {
    const o = await makeOrg();
    await run(o.owner, "geogrid.byoKey.set", { login: "x@invalid.test", password: PASSWORD });
    const v = (await run(o.owner, "geogrid.byoKey.verify")) as { ok: boolean; message: string };
    expect(v.ok).toBe(false);
    expect(v.message).not.toContain(PASSWORD);
    expect(await run(o.owner, "geogrid.byoKey.get")).toMatchObject({ lastVerifiedAt: null });
  });

  it("is owner/admin only and tenant-scoped", async () => {
    const o = await makeOrg();
    const other = await makeOrg();
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    for (const actor of [o.manager, o.viewer]) {
      for (const [name, input] of [
        ["geogrid.byoKey.get", {}],
        ["geogrid.byoKey.set", { login: LOGIN, password: PASSWORD }],
        ["geogrid.byoKey.delete", {}],
        ["geogrid.byoKey.verify", {}],
      ] as const) {
        expect(await codeOf(run(actor, name, input))).toBe("FORBIDDEN");
      }
    }
    expect(await run(other.owner, "geogrid.byoKey.get")).toMatchObject({ configured: false });
  });
});

describe("BYO runs", () => {
  it("charge no markup, ignore the resold budget cap, and use the decrypted customer key", async () => {
    const o = await makeOrg();
    const id = await createConfig(o);
    // Resold: a $0 budget blocks the run.
    await run(o.owner, "geogrid.settings.update", { monthlyBudgetUsd: 0 });
    expect(await codeOf(run(o.manager, "geogrid.run", { configId: id }))).toBe("FORBIDDEN");
    const resoldPreview = (await run(o.owner, "geogrid.preview", {
      driverId: "dataforseo_standard",
      gridSize: 3,
      keywordCount: 1,
    })) as { byoKey: boolean; wouldExceed: boolean; markupPercent: number };
    expect(resoldPreview).toMatchObject({ byoKey: false, wouldExceed: true, markupPercent: 28 });

    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const preview = (await run(o.owner, "geogrid.preview", {
      driverId: "dataforseo_standard",
      gridSize: 3,
      keywordCount: 1,
    })) as { byoKey: boolean; wouldExceed: boolean; markupPercent: number; estimateUsd: number };
    expect(preview).toMatchObject({ byoKey: true, wouldExceed: false, markupPercent: 0 });
    expect(preview.estimateUsd).toBeCloseTo(9 * 0.0006, 4);

    const out = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string; costEstimateUsd: number }[];
    };
    const runId = out.runs[0]!.runId;
    expect(out.runs[0]!.costEstimateUsd).toBeCloseTo(9 * 0.0006, 4);
    const [queued] = await db.select().from(gridRuns).where(eq(gridRuns.id, runId));
    expect(queued!.byo).toBe(true);

    const seen: DfsCredentials[] = [];
    const urls = new Map<string, string>();
    const drivers = createDriverRegistry({
      source: () => "live",
      liveByoDataForSeo: (creds) => {
        seen.push(creds);
        const base = fixtureByoTransport(creds);
        return {
          ...base,
          taskPost: async (items) => {
            const res = await base.taskPost(items);
            res.tasks.forEach((t, i) => urls.set(t.id, items[i]!.pingback_url!));
            return res;
          },
        };
      },
    });
    expect(
      await processGridRun(db, runId, { drivers, pingbackBaseUrl: "https://worker.test" }),
    ).toBe("running");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c.login === LOGIN && c.password === PASSWORD)).toBe(true);

    const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, runId));
    for (const t of tasks) {
      const token = new URL(urls.get(t.taskRef!)!).searchParams.get("token")!;
      expect(await acceptPingback(db, { taskRef: t.taskRef!, token })).toBe("accepted");
      expect(await processGridCollect(db, t.id, { drivers })).toBe("done");
    }
    const [done] = await db.select().from(gridRuns).where(eq(gridRuns.id, runId));
    expect(done!.status).toBe("done");
    expect(Number(done!.costChargedUsd)).toBeCloseTo(9 * 0.0006, 4);

    // Not resold spend: the meter's budget side stays at zero, the usage meter still shows it.
    expect(await monthToDateUsd(db, o.orgId, new Date())).toBe(0);
    const now = new Date().toISOString().slice(0, 10);
    const usage = (await run(o.manager, "geogrid.usage", { from: now, to: now })) as {
      months: {
        month: string;
        byo: {
          runs: number;
          points: number;
          tasks: number;
          costAtDataforseoUsd: number;
          chargedUsd: number;
        };
        resold: { runs: number };
        total: { runs: number };
      }[];
    };
    expect(usage.months).toHaveLength(1);
    expect(usage.months[0]!.byo).toMatchObject({ runs: 1, points: 9, tasks: 9 });
    expect(usage.months[0]!.byo.costAtDataforseoUsd).toBeCloseTo(9 * 0.0006, 4);
    expect(usage.months[0]!.byo.chargedUsd).toBeCloseTo(9 * 0.0006, 4);
    expect(usage.months[0]!.resold.runs).toBe(0);
  });

  it("a run requested with the customer key fails (charging nothing) once the key is deleted", async () => {
    const o = await makeOrg();
    const id = await createConfig(o);
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const out = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string }[];
    };
    await run(o.owner, "geogrid.byoKey.delete");
    const r = await processGridRun(db, out.runs[0]!.runId, {
      drivers: createDriverRegistry({ source: () => "live" }),
      pingbackBaseUrl: "https://worker.test",
    });
    expect(r).toBe("failed");
    const [failed] = await db.select().from(gridRuns).where(eq(gridRuns.id, out.runs[0]!.runId));
    expect(failed).toMatchObject({ status: "failed", costChargedUsd: "0.0000" });
    expect(failed!.error).toContain("byo_key_missing");
  });
});

describe("geogrid.usage", () => {
  it("splits byo from resold per month and validates the range", async () => {
    const o = await makeOrg();
    const id = await createConfig(o);
    // One resold run (markup 28%), one BYO run.
    const resold = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string }[];
    };
    await run(o.owner, "geogrid.byoKey.set", { login: LOGIN, password: PASSWORD });
    const byo = (await run(o.manager, "geogrid.run", { configId: id })) as {
      runs: { runId: string }[];
    };
    // Settle both without the pingback dance: 4 of 9 tasks done each.
    for (const r of [resold.runs[0]!, byo.runs[0]!]) {
      await processGridRun(db, r.runId, {
        drivers: createDriverRegistry({ source: () => "live" }),
        pingbackBaseUrl: "https://worker.test",
      });
      const tasks = await db.select().from(gridTasks).where(eq(gridTasks.runId, r.runId));
      for (const [i, t] of tasks.entries()) {
        await db
          .update(gridTasks)
          .set({ status: i < 4 ? "done" : "failed" })
          .where(eq(gridTasks.id, t.id));
      }
      await sql`update grid_runs set status = 'done', cost_charged_usd = cost_estimate_usd * 4 / 9 where id = ${r.runId}`;
    }
    const today = new Date().toISOString().slice(0, 10);
    const u = (await run(o.owner, "geogrid.usage", { from: today, to: today })) as {
      months: {
        byo: {
          runs: number;
          tasks: number;
          points: number;
          costAtDataforseoUsd: number;
          chargedUsd: number;
        };
        resold: { runs: number; tasks: number; costAtDataforseoUsd: number; chargedUsd: number };
        total: { runs: number; chargedUsd: number };
      }[];
    };
    const m = u.months[0]!;
    expect(m.total.runs).toBe(2);
    expect(m.byo).toMatchObject({ runs: 1, tasks: 4, points: 9 });
    expect(m.resold).toMatchObject({ runs: 1, tasks: 4 });
    expect(m.byo.costAtDataforseoUsd).toBeCloseTo(4 * 0.0006, 4);
    expect(m.resold.costAtDataforseoUsd).toBeCloseTo(4 * 0.0006, 4);
    // Resold carries the 28% markup, BYO is at cost.
    expect(m.byo.chargedUsd).toBeCloseTo(4 * 0.0006, 3);
    expect(m.resold.chargedUsd).toBeCloseTo(4 * 0.0006 * 1.28, 3);

    expect(await codeOf(run(o.owner, "geogrid.usage", { from: today, to: "2000-01-01" }))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(run(o.owner, "geogrid.usage", { from: "2020-01-01", to: today }))).toBe(
      "INVALID_INPUT",
    );
    const other = await makeOrg();
    expect(
      (
        (await run(other.owner, "geogrid.usage", { from: today, to: today })) as {
          months: unknown[];
        }
      ).months,
    ).toEqual([]);
  });
});
