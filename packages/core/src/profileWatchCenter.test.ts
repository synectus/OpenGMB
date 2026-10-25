import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, locations } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { processProfileSnapshot } from "./profile/watch";
import { LOCATION_CENTER_QUEUE, addressHash } from "./locations/center";
import { makeKit, type Loc } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
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
const snap = (loc: Loc) => processProfileSnapshot(db, { locationId: loc.row.id }, { client });
const setAddress = (loc: Loc, a: unknown) => {
  (mock as unknown as { locations: { name: string; storefrontAddress?: unknown }[] }).locations.find((l) => l.name === loc.google)!.storefrontAddress = a;
};
const jobs = async (loc: Loc) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from pgboss.job where name = ${LOCATION_CENTER_QUEUE} and data->>'locationId' = ${loc.row.id}`)[0]!.n);

async function located(source: "google" | "manual" | null = "google") {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  setAddress(loc, ADDR);
  await db
    .update(locations)
    .set(source ? { centerLat: 1, centerLng: 2, centerSource: source, centerAddressHash: addressHash(ADDR) } : { centerLat: null })
    .where(eq(locations.id, loc.row.id));
  await snap(loc);
  return loc;
}

describe("the nightly snapshot refreshes coordinates only when the address changed", () => {
  it("an unchanged address, snapshot after snapshot, enqueues nothing", async () => {
    const loc = await located();
    await snap(loc);
    await snap(loc);
    expect(await jobs(loc)).toBe(0);
  });

  it("a changed address enqueues exactly one re-resolve, even if snapshots repeat afterwards", async () => {
    const loc = await located();
    setAddress(loc, { ...ADDR, addressLines: ["99 New Rd"] });
    await snap(loc);
    expect(await jobs(loc)).toBe(1);
  });

  it("an edit to something other than the address enqueues nothing", async () => {
    const loc = await located();
    mock.editLocation(loc.google, { profile: { description: "A new description." } }, ["profile"]);
    await snap(loc);
    expect(await jobs(loc)).toBe(0);
  });

  it("a manual centre is not re-resolved even when the address changed", async () => {
    const loc = await located("manual");
    setAddress(loc, { ...ADDR, addressLines: ["99 New Rd"] });
    await snap(loc);
    expect(await jobs(loc)).toBe(0);
  });

  it("a location never resolved (no stored hash) is left to the backfill, not retried nightly", async () => {
    const loc = await located(null);
    setAddress(loc, { ...ADDR, addressLines: ["99 New Rd"] });
    await snap(loc);
    expect(await jobs(loc)).toBe(0);
  });
});
