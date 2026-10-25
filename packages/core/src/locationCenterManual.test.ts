import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { auditLog, createDb, locations } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { processProfileSnapshot } from "./profile/watch";
import { LOCATION_CENTER_QUEUE, addressHash } from "./locations/center";
import { codeOf, makeKit, type Loc } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(LOCATION_CENTER_QUEUE);
});
afterAll(async () => {
  await kit.deactivateAll();
  await boss.stop();
  await sql.end();
});

const ADDR = { regionCode: "US", locality: "San Antonio", addressLines: ["1 Main St"] };
type Center = { lat: number | null; lng: number | null; source: string | null; updatedAt: string | null };
const row = async (loc: Loc) => (await db.select().from(locations).where(eq(locations.id, loc.row.id)))[0]!;
const jobs = async (loc: Loc) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from pgboss.job where name = ${LOCATION_CENTER_QUEUE} and data->>'locationId' = ${loc.row.id}`)[0]!.n);
async function setup() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a, { centerLat: 1, centerLng: 2, centerSource: "google", centerAddressHash: addressHash(ADDR) });
  return { org, loc };
}

describe("locations.center.set", () => {
  it("stores a manual centre, keeps the address hash, audits, and get reads it back", async () => {
    const { org, loc } = await setup();
    const out = await kit.run<Center>(org.owner, "locations.center.set", { locationId: loc.row.id, lat: 23.1815, lng: 72.6369 });
    expect(out).toMatchObject({ lat: 23.1815, lng: 72.6369, source: "manual" });
    const l = await row(loc);
    expect(l).toMatchObject({ centerLat: 23.1815, centerLng: 72.6369, centerSource: "manual", centerAddressHash: addressHash(ADDR) });
    expect(l.centerUpdatedAt).toBeInstanceOf(Date);
    expect(await kit.run<Center>(org.owner, "locations.center.get", { locationId: loc.row.id })).toMatchObject({ lat: 23.1815, lng: 72.6369, source: "manual" });
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "location.center_set_manual")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityId).toBe(loc.row.id);
  });

  it("refuses latitude outside -90..90, longitude outside -180..180 and non-numbers; nothing is written", async () => {
    const { org, loc } = await setup();
    for (const bad of [{ lat: 90.5, lng: 0 }, { lat: -91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 0, lng: -180.1 }, { lat: Number.NaN, lng: 0 }, { lat: "1", lng: 0 }]) {
      expect(await codeOf(kit.run(org.owner, "locations.center.set", { locationId: loc.row.id, ...bad })), JSON.stringify(bad)).toBe("INVALID_INPUT");
    }
    expect(await row(loc)).toMatchObject({ centerLat: 1, centerLng: 2, centerSource: "google" });
  });

  it("is for owners and admins only: a manager, an approver and a viewer are refused", async () => {
    const { org, loc } = await setup();
    for (const who of [org.manager, org.approverA, org.viewerA]) {
      expect(await codeOf(kit.run(who, "locations.center.set", { locationId: loc.row.id, lat: 5, lng: 6 }))).toBe("FORBIDDEN");
      expect(await codeOf(kit.run(who, "locations.center.clearManual", { locationId: loc.row.id }))).toBe("FORBIDDEN");
    }
    expect(await row(loc)).toMatchObject({ centerLat: 1, centerLng: 2, centerSource: "google" });
  });

  it("another organization's location is not found", async () => {
    const { loc } = await setup();
    const other = await kit.makeOrg();
    expect(await codeOf(kit.run(other.owner, "locations.center.set", { locationId: loc.row.id, lat: 5, lng: 6 }))).toBe("NOT_FOUND");
  });
});

describe("locations.center.clearManual", () => {
  it("clears the manual centre, queues one re-resolve and audits", async () => {
    const { org, loc } = await setup();
    await kit.run(org.owner, "locations.center.set", { locationId: loc.row.id, lat: 5, lng: 6 });
    const out = await kit.run<Center>(org.owner, "locations.center.clearManual", { locationId: loc.row.id });
    expect(out).toMatchObject({ lat: null, lng: null, source: null });
    // the stale hash is cleared too, or the resolver would answer "unchanged" and never look again
    expect(await row(loc)).toMatchObject({ centerLat: null, centerLng: null, centerSource: null, centerAddressHash: null });
    expect(await jobs(loc)).toBe(1);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "location.center_cleared_manual")));
    expect(audit).toHaveLength(1);
  });

  it("does nothing, and queues nothing, when the centre is not manual", async () => {
    const { org, loc } = await setup();
    await kit.run(org.owner, "locations.center.clearManual", { locationId: loc.row.id });
    expect(await row(loc)).toMatchObject({ centerLat: 1, centerLng: 2, centerSource: "google" });
    expect(await jobs(loc)).toBe(0);
  });
});

describe("a manual centre and the nightly watch", () => {
  it("survives a nightly run whose address is unchanged, and a changed address queues nothing", async () => {
    const { org, loc } = await setup();
    const g = (mock as unknown as { locations: { name: string; storefrontAddress?: unknown }[] }).locations.find((l) => l.name === loc.google)!;
    g.storefrontAddress = ADDR;
    await kit.run(org.owner, "locations.center.set", { locationId: loc.row.id, lat: 5, lng: 6 });
    const client = new ThrottledGoogleClient(mock, db);
    await processProfileSnapshot(db, { locationId: loc.row.id }, { client });
    await processProfileSnapshot(db, { locationId: loc.row.id }, { client });
    expect(await row(loc)).toMatchObject({ centerLat: 5, centerLng: 6, centerSource: "manual", centerAddressHash: addressHash(ADDR) });
    expect(await jobs(loc)).toBe(0);
    g.storefrontAddress = { ...ADDR, addressLines: ["99 New Rd"] };
    await processProfileSnapshot(db, { locationId: loc.row.id }, { client });
    expect(await jobs(loc)).toBe(0);
    expect(await row(loc)).toMatchObject({ centerLat: 5, centerLng: 6, centerSource: "manual" });
  });
});
