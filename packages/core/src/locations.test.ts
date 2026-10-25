import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import {
  auditLog,
  createDb,
  googleConnections,
  locationImports,
  locations,
  memberships,
  organizations,
  reviewSyncs,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { verifyAuditChain } from "./audit";
import { GOOGLE_LIMITS } from "./config/google-limits";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { MockGoogleClient } from "./google/mock-client";
import { MOCK_GOOGLE_EMAIL, seedMockGoogleConnection } from "./google/dev-seed";
import { fetchAllLocations } from "./locations/google";
import { LOCATION_IMPORT_QUEUE, processLocationImport } from "./locations/import";
import { LOCATION_CENTER_QUEUE } from "./locations/center";
import { REVIEW_SYNC_QUEUE } from "./reviews/sync";
import { PERFORMANCE_SNAPSHOT_QUEUE } from "./performance/snapshot";
import { PROJECT_LIMIT, LOCATION_EDIT_LIMIT } from "./google/throttler";
import { defineAction } from "./registry";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const L1 = "locations/200000000000000001";
const L2 = "locations/200000000000000002";
const L3 = "locations/200000000000000003";
const A1 = "accounts/100000000000000000001";
const A2 = "accounts/100000000000000000002";
const FIXTURE_IDS = [L1, L2, L3];

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const mkUser = async (role: "owner" | "manager" | "client_viewer", workspaceId?: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email: `${id}@example.test` };
  };
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const owner = await mkUser("owner");
  const manager = await mkUser("manager");
  const viewer = await mkUser("client_viewer", a!.id);
  const actor = (u: { id: string }, surface: Actor["surface"] = "ui") =>
    loadActor(db, { userId: u.id, surface, actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    connectionId,
    owner: await actor(owner),
    ownerUser: owner,
    manager: await actor(manager),
    viewer: await actor(viewer),
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

/** Request an import through the action, then run the worker side with the mock client. */
async function importAs(
  org: Org,
  workspaceId: string,
  items: { accountName: string; locationName: string }[],
) {
  const out = (await run(org.owner, "locations.import", {
    connectionId: org.connectionId,
    workspaceId,
    locations: items,
  })) as { importId: string; jobId: string; queued: boolean };
  const results = await processLocationImport(db, out.importId);
  return { ...out, results: results! };
}
const loc = (name: string, account: string) => ({ accountName: account, locationName: name });

/**
 * Deletes rows of `table` matching `where`, children first, following every foreign key in the
 * catalog. A plain `delete from locations` fails when an earlier e2e run (which imports these same
 * mock fixture locations) left performance, snapshot or profile rows behind that do not cascade.
 */
async function purge(table: string, where: string, path: string[] = []): Promise<void> {
  const fks = await sql<{ child: string; ccol: string; pcol: string }[]>`
    select c.conrelid::regclass::text as child, ca.attname as ccol, pa.attname as pcol
    from pg_constraint c
    join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
    where c.contype = 'f' and c.confrelid = ${table}::regclass and array_length(c.conkey, 1) = 1`;
  for (const fk of fks) {
    if (fk.child === table || path.includes(fk.child)) continue;
    await purge(fk.child, `${fk.ccol} in (select ${fk.pcol} from ${table} where ${where})`, [
      ...path,
      table,
    ]);
  }
  await sql.unsafe(`delete from ${table} where ${where}`);
}

let org1: Org;
let org2: Org;

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  await boss.start();
  await boss.createQueue(LOCATION_IMPORT_QUEUE);
  await boss.createQueue(REVIEW_SYNC_QUEUE);
  await boss.createQueue(PERFORMANCE_SNAPSHOT_QUEUE);
  await boss.createQueue(LOCATION_CENTER_QUEUE);
  // The mock fixture ids are global and the test DB persists between runs: start clean.
  await purge("locations", `google_location_id in (${FIXTURE_IDS.map((i) => `'${i}'`).join(", ")})`);
  org1 = await makeOrg();
  org2 = await makeOrg();
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("locations.listAvailable", () => {
  it("lists mock accounts and locations, none imported yet", async () => {
    const r = (await run(org1.owner, "locations.listAvailable", {
      connectionId: org1.connectionId,
    })) as {
      accounts: {
        accountName: string;
        locations: { locationName: string; alreadyImported: boolean }[];
      }[];
    };
    expect(r.accounts.map((a) => a.accountName)).toEqual([A1, A2]);
    const all = r.accounts.flatMap((a) => a.locations);
    // The fourth fixture (G6) is only for the self-serve e2e; no other test imports it.
    expect(all.map((l) => l.locationName).sort()).toEqual([...FIXTURE_IDS, "locations/200000000000000004"]);
    expect(all.every((l) => !l.alreadyImported)).toBe(true);
  });

  it("is a read action that runs outside any transaction", async () => {
    const { locationsListAvailable } = await import("./actions/locations");
    expect(locationsListAvailable.kind).toBe("read");
    expect(locationsListAvailable.outsideTransaction).toBe(true);
    const probe = defineAction({
      name: "probe.outside",
      description: "x",
      input: z.object({}),
      output: z.object({ inTx: z.boolean() }),
      permission: "location:manage",
      kind: "read",
      outsideTransaction: true,
      async handler(ctx) {
        let inTx = true;
        try {
          void ctx.tx;
        } catch {
          inTx = false;
        }
        return { inTx };
      },
    });
    expect(await executeAction(db, org1.owner, "probe.outside", {}, [probe])).toEqual({
      inTx: false,
    });
  });

  it("rejects roles without location:manage and foreign connections", async () => {
    expect(
      await codeOf(
        run(org1.viewer, "locations.listAvailable", { connectionId: org1.connectionId }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(run(org1.owner, "locations.listAvailable", { connectionId: org2.connectionId })),
    ).toBe("NOT_FOUND");
  });
});

describe("locations.import", () => {
  it("queues a job; the worker imports with Google's details and audits", async () => {
    const out = (await run(org1.owner, "locations.import", {
      connectionId: org1.connectionId,
      workspaceId: org1.a,
      locations: [loc(L1, A1), loc(L2, A1)],
    })) as { importId: string; jobId: string; queued: boolean };
    expect(out.queued).toBe(true);
    const jobs = await sql`select id from pgboss.job where id = ${out.jobId}`;
    expect(jobs).toHaveLength(1);
    // Nothing imported until the worker runs.
    expect(
      await db
        .select()
        .from(locations)
        .where(inArray(locations.googleLocationId, [L1, L2])),
    ).toHaveLength(0);
    expect(
      await run(org1.owner, "locations.importStatus", { importId: out.importId }),
    ).toMatchObject({
      status: "pending",
      results: null,
    });

    const results = (await processLocationImport(db, out.importId))!;
    expect(results.map((r) => r.result)).toEqual(["imported", "imported"]);
    const [row] = await db.select().from(locations).where(eq(locations.googleLocationId, L1));
    expect(row).toMatchObject({
      orgId: org1.orgId,
      workspaceId: org1.a,
      googleAccountName: A1,
      googleLocationId: L1,
      connectionId: org1.connectionId,
      title: "Harbourlight Dental - Riverside",
      name: "Harbourlight Dental - Riverside",
      phone: "+1 555 010 0101",
      status: "active",
    });
    expect(row!.addressSummary).toContain("100 Sample Street");
    expect(row!.importedAt).toBeInstanceOf(Date);

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, org1.orgId),
          eq(auditLog.entityId, row!.id),
          eq(auditLog.action, "location.import"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "location.import",
      surface: "worker",
      entityType: "location",
    });
    expect((audits[0]!.after as { requestedBy: string }).requestedBy).toBe(org1.owner.userId);
    // Importing a location enqueues its first reviews sync in the same transaction.
    const syncs = await db.select().from(reviewSyncs).where(eq(reviewSyncs.locationId, row!.id));
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ status: "pending", requestedBy: org1.owner.userId });
    const syncJobs =
      await sql`select id from pgboss.job where name = ${REVIEW_SYNC_QUEUE} and data->>'syncId' = ${syncs[0]!.id}`;
    expect(syncJobs).toHaveLength(1);
    const syncAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, syncs[0]!.id), eq(auditLog.action, "review_sync.requested")),
      );
    expect(syncAudit).toHaveLength(1);
    expect(syncAudit[0]).toMatchObject({ surface: "worker", actorType: "system" });
    // ...and its first performance backfill, so the Performance page has data before the nightly run.
    const perfJobs =
      await sql`select data from pgboss.job where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' = ${row!.id}`;
    expect(perfJobs.map((j) => j.data)).toEqual([{ locationId: row!.id, backfill: true }]);
    // ...and its coordinates are looked up once, as their own job (the import itself never waits on it).
    const centerJobs =
      await sql`select data from pgboss.job where name = ${LOCATION_CENTER_QUEUE} and data->>'locationId' = ${row!.id}`;
    expect(centerJobs.map((j) => j.data)).toEqual([{ locationId: row!.id, reason: "onboarding" }]);
    const perfAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, row!.id), eq(auditLog.action, "performance.backfill_requested")),
      );
    expect(perfAudit).toHaveLength(1);
    expect(perfAudit[0]).toMatchObject({ surface: "worker", actorType: "system" });
    const requested = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org1.orgId), eq(auditLog.entityId, out.importId)));
    expect(requested.map((r) => r.action).sort()).toEqual([
      "location_import.completed",
      "location_import.requested",
    ]);
    expect(
      await run(org1.owner, "locations.importStatus", { importId: out.importId }),
    ).toMatchObject({
      status: "done",
    });
    expect((await verifyAuditChain(db, org1.orgId)).ok).toBe(true);
  });

  it("listAvailable now marks them imported; other orgs see only a boolean", async () => {
    type R = {
      accounts: {
        locations: {
          locationName: string;
          alreadyImported: boolean;
          importedWorkspace: { id: string } | null;
          activeInAnotherOrg: boolean;
        }[];
      }[];
    };
    const mine = (await run(org1.owner, "locations.listAvailable", {
      connectionId: org1.connectionId,
    })) as R;
    const l1 = mine.accounts.flatMap((a) => a.locations).find((l) => l.locationName === L1)!;
    expect(l1).toMatchObject({ alreadyImported: true, activeInAnotherOrg: false });
    expect(l1.importedWorkspace?.id).toBe(org1.a);
    const theirs = (await run(org2.owner, "locations.listAvailable", {
      connectionId: org2.connectionId,
    })) as R;
    const t1 = theirs.accounts.flatMap((a) => a.locations).find((l) => l.locationName === L1)!;
    expect(t1).toMatchObject({
      alreadyImported: true,
      activeInAnotherOrg: true,
      importedWorkspace: null,
    });
  });

  it("is idempotent for the same workspace and reports conflict elsewhere", async () => {
    const again = await importAs(org1, org1.a, [loc(L1, A1)]);
    expect(again.results[0]).toMatchObject({ result: "already_imported" });
    const otherWs = await importAs(org1, org1.b, [loc(L1, A1)]);
    expect(otherWs.results[0]!.result).toBe("conflict");
    const otherOrg = await importAs(org2, org2.a, [loc(L1, A1)]);
    expect(otherOrg.results[0]!.result).toBe("conflict");
    expect(
      await db.select().from(locations).where(eq(locations.googleLocationId, L1)),
    ).toHaveLength(1);
    // A finished request is not processed twice.
    expect(await processLocationImport(db, again.importId)).toBeNull();
  });

  it("reports not_found for a location under the wrong account", async () => {
    const r = await importAs(org1, org1.a, [loc(L3, A1)]);
    expect(r.results[0]).toMatchObject({ result: "not_found", locationId: null });
  });

  it("a Google failure changes nothing and leaves the request pending for retry", async () => {
    const out = (await run(org1.owner, "locations.import", {
      connectionId: org1.connectionId,
      workspaceId: org1.a,
      locations: [loc(L3, A2)],
    })) as { importId: string };
    const mock = new MockGoogleClient();
    mock.failNext(1, () => new Error("boom"));
    await expect(processLocationImport(db, out.importId, { client: mock })).rejects.toThrow("boom");
    const [req] = await db
      .select()
      .from(locationImports)
      .where(eq(locationImports.id, out.importId));
    expect(req!.status).toBe("pending");
    expect(
      await db.select().from(locations).where(eq(locations.googleLocationId, L3)),
    ).toHaveLength(0);
    const retry = (await processLocationImport(db, out.importId))!;
    expect(retry[0]!.result).toBe("imported");
    // restore for later tests
    await db.delete(locations).where(eq(locations.googleLocationId, L3));
  });

  it("validates input and permissions", async () => {
    const base = { connectionId: org1.connectionId, workspaceId: org1.a };
    expect(await codeOf(run(org1.owner, "locations.import", { ...base, locations: [] }))).toBe(
      "INVALID_INPUT",
    );
    expect(
      await codeOf(
        run(org1.owner, "locations.import", {
          ...base,
          locations: Array.from({ length: 101 }, (_, i) => loc(`locations/${i}`, A1)),
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(run(org1.viewer, "locations.import", { ...base, locations: [loc(L1, A1)] })),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        run(org1.owner, "locations.import", {
          ...base,
          connectionId: org2.connectionId,
          locations: [loc(L1, A1)],
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        run(org1.owner, "locations.import", {
          ...base,
          workspaceId: org2.a,
          locations: [loc(L1, A1)],
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("activate / deactivate", () => {
  it("deactivate, import elsewhere, then activating back conflicts", async () => {
    const [row] = await db.select().from(locations).where(eq(locations.googleLocationId, L1));
    const off = (await run(org1.manager, "locations.setStatus", {
      locationIds: [row!.id, crypto.randomUUID()],
      status: "inactive",
    })) as { results: { locationId: string; result: string }[] };
    expect(off.results.map((r) => r.result)).toEqual(["updated", "not_found"]);

    // Same org, inactive: told to activate instead of importing a duplicate.
    const same = await importAs(org1, org1.a, [loc(L1, A1)]);
    expect(same.results[0]).toMatchObject({ result: "exists_inactive", locationId: row!.id });

    const other = await importAs(org2, org2.a, [loc(L1, A1)]);
    expect(other.results[0]!.result).toBe("imported");

    const back = (await run(org1.owner, "locations.setStatus", {
      locationIds: [row!.id],
      status: "active",
    })) as { results: { result: string }[] };
    expect(back.results[0]!.result).toBe("conflict");
    const [still] = await db.select().from(locations).where(eq(locations.id, row!.id));
    expect(still!.status).toBe("inactive");

    // Release it in org2; org1 can now activate (and doing it twice is unchanged).
    const [theirs] = await db
      .select()
      .from(locations)
      .where(and(eq(locations.googleLocationId, L1), eq(locations.orgId, org2.orgId)));
    await run(org2.owner, "locations.setStatus", { locationIds: [theirs!.id], status: "inactive" });
    const ok = (await run(org1.owner, "locations.setStatus", {
      locationIds: [row!.id],
      status: "active",
    })) as { results: { result: string }[] };
    expect(ok.results[0]!.result).toBe("updated");
    const twice = (await run(org1.owner, "locations.setStatus", {
      locationIds: [row!.id],
      status: "active",
    })) as { results: { result: string }[] };
    expect(twice.results[0]!.result).toBe("unchanged");
  });

  it("every outcome is audited; the DB index refuses two active rows", async () => {
    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, org1.orgId));
    const actions = new Set(audits.map((a) => a.action));
    for (const a of [
      "location.deactivate",
      "location.activate",
      "location.set_status_conflict",
      "location.set_status_not_found",
      "location.set_status_unchanged",
    ])
      expect(actions.has(a), a).toBe(true);
    await expect(
      db.insert(locations).values({
        orgId: org2.orgId,
        workspaceId: org2.a,
        name: "dup",
        googleLocationId: L1,
      }),
    ).rejects.toThrow();
  });

  it("client roles cannot manage", async () => {
    expect(
      await codeOf(
        run(org1.viewer, "locations.setStatus", {
          locationIds: [crypto.randomUUID()],
          status: "inactive",
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("locations.list", () => {
  it("client roles see only their workspace; filters work", async () => {
    await importAs(org1, org1.b, [loc(L3, A2)]);
    type L = { locations: { googleLocationId: string; workspaceId: string; status: string }[] };
    const all = (await run(org1.owner, "locations.list", {})) as L;
    expect(all.locations.map((l) => l.googleLocationId).sort()).toEqual([L1, L2, L3]);
    const mine = (await run(org1.viewer, "locations.list", {})) as L;
    expect(mine.locations.every((l) => l.workspaceId === org1.a)).toBe(true);
    expect(mine.locations.map((l) => l.googleLocationId).sort()).toEqual([L1, L2]);
    expect(await codeOf(run(org1.viewer, "locations.list", { workspaceId: org1.b }))).toBe(
      "FORBIDDEN",
    );
    const inactive = (await run(org1.owner, "locations.list", { status: "inactive" })) as L;
    expect(inactive.locations).toHaveLength(0);
    const byWs = (await run(org1.owner, "locations.list", { workspaceId: org1.b })) as L;
    expect(byWs.locations.map((l) => l.googleLocationId)).toEqual([L3]);
    // org2 sees none of org1's rows
    const other = (await run(org2.owner, "locations.list", {})) as L;
    expect(other.locations.every((l) => l.googleLocationId === L1)).toBe(true);
  });
  it("filters by locationIds, inside the caller's scope", async () => {
    type L = { locations: { id: string; workspaceId: string }[] };
    const all = (await run(org1.owner, "locations.list", {})) as L;
    const inA = all.locations.find((l) => l.workspaceId === org1.a)!;
    const inB = all.locations.find((l) => l.workspaceId === org1.b)!;
    const one = (await run(org1.owner, "locations.list", { locationIds: [inB.id] })) as L;
    expect(one.locations.map((l) => l.id)).toEqual([inB.id]);
    // The client viewer of A asks for both and gets only A's.
    const scoped = (await run(org1.viewer, "locations.list", { locationIds: [inA.id, inB.id] })) as L;
    expect(scoped.locations.map((l) => l.id)).toEqual([inA.id]);
    expect(await codeOf(run(org1.owner, "locations.list", { locationIds: [] }))).toBe("INVALID_INPUT");
  });
});

describe("locations.list needsRelink", () => {
  it("is true only for a location with a Google id but no connection", async () => {
    const n = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const base = { orgId: org1.orgId, workspaceId: org1.a, googleAccountName: `accounts/8${n}` };
    await db.insert(locations).values([
      {
        ...base,
        name: `linked-${n}`,
        googleLocationId: `locations/81${n}`,
        connectionId: org1.connectionId,
      },
      { ...base, name: `orphan-${n}`, googleLocationId: `locations/82${n}`, connectionId: null },
      { ...base, name: `nogoogle-${n}`, googleLocationId: null, connectionId: null },
    ]);
    type L = { locations: { name: string; needsRelink: boolean }[] };
    const out = (await run(org1.owner, "locations.list", { workspaceId: org1.a })) as L;
    const flag = (prefix: string) =>
      out.locations.find((l) => l.name === `${prefix}-${n}`)?.needsRelink;
    expect(flag("linked")).toBe(false);
    expect(flag("orphan")).toBe(true);
    expect(flag("nogoogle")).toBe(false);
  });
});

describe("location groups", () => {
  type G = { group: { id: string; name: string; locationIds: string[] } };
  it("create / rename / setMembers / list / delete, audited", async () => {
    const created = (await run(org1.manager, "locationGroups.create", {
      workspaceId: org1.a,
      name: "North",
    })) as G;
    expect(
      await codeOf(
        run(org1.manager, "locationGroups.create", { workspaceId: org1.a, name: "North" }),
      ),
    ).toBe("CONFLICT");
    // same name in another workspace is fine
    await run(org1.manager, "locationGroups.create", { workspaceId: org1.b, name: "North" });

    const inA = (
      await db
        .select()
        .from(locations)
        .where(and(eq(locations.orgId, org1.orgId), eq(locations.workspaceId, org1.a)))
    ).map((l) => l.id);
    const set = (await run(org1.manager, "locationGroups.setMembers", {
      groupId: created.group.id,
      locationIds: inA,
    })) as G;
    expect(set.group.locationIds.sort()).toEqual(inA.sort());

    const renamed = (await run(org1.manager, "locationGroups.rename", {
      groupId: created.group.id,
      name: "South",
    })) as G;
    expect(renamed.group.name).toBe("South");
    expect(renamed.group.locationIds).toHaveLength(inA.length);

    const listed = (await run(org1.owner, "locations.list", { groupId: created.group.id })) as {
      locations: { groups: { name: string }[] }[];
    };
    expect(listed.locations).toHaveLength(inA.length);
    expect(listed.locations[0]!.groups.map((g) => g.name)).toEqual(["South"]);

    const viewerGroups = (await run(org1.viewer, "locationGroups.list", {})) as {
      groups: { workspaceId: string }[];
    };
    expect(viewerGroups.groups.every((g) => g.workspaceId === org1.a)).toBe(true);

    await run(org1.manager, "locationGroups.delete", { groupId: created.group.id });
    expect(
      await codeOf(run(org1.manager, "locationGroups.delete", { groupId: created.group.id })),
    ).toBe("NOT_FOUND");
    // locations survive group deletion
    expect(await db.select().from(locations).where(inArray(locations.id, inA))).toHaveLength(
      inA.length,
    );

    const actions = (
      await db.select().from(auditLog).where(eq(auditLog.entityId, created.group.id))
    )
      .map((a) => a.action)
      .sort();
    expect(actions).toEqual([
      "location_group.create",
      "location_group.delete",
      "location_group.rename",
      "location_group.set_members",
    ]);
  });

  it("rejects members from another workspace, changing nothing", async () => {
    const g = (await run(org1.owner, "locationGroups.create", {
      workspaceId: org1.a,
      name: "Mixed",
    })) as G;
    const [inB] = await db
      .select()
      .from(locations)
      .where(and(eq(locations.orgId, org1.orgId), eq(locations.workspaceId, org1.b)));
    expect(
      await codeOf(
        run(org1.owner, "locationGroups.setMembers", {
          groupId: g.group.id,
          locationIds: [inB!.id],
        }),
      ),
    ).toBe("INVALID_INPUT");
    const [theirs] = await db.select().from(locations).where(eq(locations.orgId, org2.orgId));
    expect(
      await codeOf(
        run(org1.owner, "locationGroups.setMembers", {
          groupId: g.group.id,
          locationIds: [theirs!.id],
        }),
      ),
    ).toBe("INVALID_INPUT");
    const listed = (await run(org1.owner, "locationGroups.list", { workspaceId: org1.a })) as {
      groups: { id: string; locationIds: string[] }[];
    };
    expect(listed.groups.find((x) => x.id === g.group.id)!.locationIds).toEqual([]);
  });

  it("client roles cannot manage; other orgs cannot see the group", async () => {
    expect(
      await codeOf(run(org1.viewer, "locationGroups.create", { workspaceId: org1.a, name: "x" })),
    ).toBe("FORBIDDEN");
    const g = (await run(org1.owner, "locationGroups.create", {
      workspaceId: org1.a,
      name: "Private",
    })) as G;
    expect(await codeOf(run(org2.owner, "locationGroups.delete", { groupId: g.group.id }))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(run(org1.viewer, "locationGroups.delete", { groupId: g.group.id }))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("google client helpers and config", () => {
  it("fetchAllLocations follows nextPageToken and stops at the page cap", async () => {
    const mock = new MockGoogleClient();
    const full = await fetchAllLocations(mock, A1, { pageSize: 1 });
    expect(full.locations).toHaveLength(2);
    expect(full.truncated).toBe(false);
    expect(mock.calls.filter((c) => c.method === "listLocations")).toHaveLength(2);
    const capped = await fetchAllLocations(new MockGoogleClient(), A1, {
      pageSize: 1,
      maxPages: 1,
    });
    expect(capped.locations).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("the throttler reads its numbers from the config module", () => {
    expect(PROJECT_LIMIT).toBe(GOOGLE_LIMITS.projectQpm.limit);
    expect(LOCATION_EDIT_LIMIT).toBe(GOOGLE_LIMITS.locationEditsPerMinute.limit);
    for (const f of ["google/throttler.ts", "google/throttled-client.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(
        (f.endsWith("throttler.ts") ? /\b(300|60_000)\b/ : /\b300\b/).test(src),
        `${f} has a literal limit`,
      ).toBe(false);
    }
    for (const v of Object.values(GOOGLE_LIMITS)) {
      expect(v.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.verifiedOn >= "2026-10-12").toBe(true);
      expect(v.sourceUrl.length).toBeGreaterThan(0);
    }
    expect(GOOGLE_LIMITS.replyMaxBytes.limit).toBe(4096);
    expect(GOOGLE_LIMITS.duplicateWindowReplies.limit).toBe(30);
  });
});

describe("dev seed", () => {
  it("refuses unless mode is mock, and is idempotent", async () => {
    const o = await makeOrg(); // seeded once in makeOrg
    const before = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.orgId, o.orgId));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ googleAccountEmail: MOCK_GOOGLE_EMAIL });
    expect(before[0]!.googleAccountId.startsWith("mock-")).toBe(true);
    expect(before[0]!.scopes).toContain("https://www.googleapis.com/auth/business.manage");
    expect(before[0]!.refreshTokenEnc).not.toContain("mock-refresh-token");
    const again = await seedMockGoogleConnection(db, o.ownerUser.email);
    expect(again).toMatchObject({ created: false, connectionId: before[0]!.id });
    expect(
      await db.select().from(googleConnections).where(eq(googleConnections.orgId, o.orgId)),
    ).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, "google_connection.dev_seed")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.surface).toBe("cli");

    process.env.GOOGLE_BUSINESS_API_MODE = "live";
    try {
      expect(await codeOf(seedMockGoogleConnection(db, o.ownerUser.email))).toBe("NOT_CONFIGURED");
    } finally {
      process.env.GOOGLE_BUSINESS_API_MODE = "mock";
    }
  });
});

describe("re-linking an orphaned location", () => {
  type R = {
    accounts: {
      locations: { locationName: string; alreadyImported: boolean; needsRelink: boolean }[];
    }[];
  };
  const listed = async (o: Org, connectionId: string) =>
    ((await run(o.owner, "locations.listAvailable", { connectionId })) as R).accounts
      .flatMap((a) => a.locations)
      .find((l) => l.locationName === L3)!;
  /** A second connection in the same org (the seed helper is one-per-org). */
  async function addConnection(o: Org) {
    const [first] = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.id, o.connectionId));
    const [c] = await db
      .insert(googleConnections)
      .values({
        orgId: first!.orgId,
        userId: first!.userId,
        googleAccountId: `mock-${uniq()}`,
        googleAccountEmail: `second-${uniq()}@example.test`,
        refreshTokenEnc: first!.refreshTokenEnc,
        scopes: first!.scopes,
      })
      .returning();
    return c!.id;
  }

  it("re-links after disconnect + reconnect; does not steal from another live connection", async () => {
    await db.delete(locations).where(eq(locations.googleLocationId, L3));
    try {
      const o = await makeOrg();
      const first = await importAs(o, o.a, [loc(L3, A2)]);
      expect(first.results[0]!.result).toBe("imported");
      const locationId = first.results[0]!.locationId!;

      // Linked to a live connection: a second connection importing it changes nothing.
      const other = await addConnection(o);
      const out2 = (await run(o.owner, "locations.import", {
        connectionId: other,
        workspaceId: o.a,
        locations: [loc(L3, A2)],
      })) as { importId: string };
      expect((await processLocationImport(db, out2.importId))![0]).toMatchObject({
        result: "already_imported",
      });
      expect(await listed(o, other)).toMatchObject({ alreadyImported: true, needsRelink: false });
      const [still] = await db.select().from(locations).where(eq(locations.id, locationId));
      expect(still!.connectionId).toBe(o.connectionId);

      // Disconnect: FK set null leaves the location orphaned.
      await db.delete(googleConnections).where(eq(googleConnections.id, o.connectionId));
      const [orphan] = await db.select().from(locations).where(eq(locations.id, locationId));
      expect(orphan!.connectionId).toBeNull();
      expect(await listed(o, other)).toMatchObject({ alreadyImported: true, needsRelink: true });

      const syncsBefore = await db
        .select()
        .from(reviewSyncs)
        .where(eq(reviewSyncs.locationId, locationId));
      const perfBefore =
        await sql`select id from pgboss.job where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' = ${locationId}`;

      const out3 = (await run(o.owner, "locations.import", {
        connectionId: other,
        workspaceId: o.a,
        locations: [loc(L3, A2)],
      })) as { importId: string };
      expect((await processLocationImport(db, out3.importId))![0]).toEqual({
        locationName: L3,
        result: "relinked",
        locationId,
      });
      const [fixed] = await db.select().from(locations).where(eq(locations.id, locationId));
      expect(fixed).toMatchObject({ connectionId: other, googleAccountName: A2, status: "active" });
      expect(await listed(o, other)).toMatchObject({ needsRelink: false });

      const syncsAfter = await db
        .select()
        .from(reviewSyncs)
        .where(eq(reviewSyncs.locationId, locationId));
      expect(syncsAfter).toHaveLength(syncsBefore.length + 1);
      const perfAfter =
        await sql`select id from pgboss.job where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' = ${locationId}`;
      expect(perfAfter).toHaveLength(perfBefore.length + 1);

      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, locationId), eq(auditLog.action, "location.relinked")));
      expect(audit).toMatchObject({ surface: "worker", actorType: "system" });
      expect(audit!.before).toEqual({ connectionId: null });
      expect(audit!.after).toMatchObject({ connectionId: other });
      expect((await verifyAuditChain(db, o.orgId)).ok).toBe(true);
    } finally {
      await db.delete(locations).where(eq(locations.googleLocationId, L3));
    }
  });
});
