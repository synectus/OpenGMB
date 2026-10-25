import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, gridConfigs, locations, platformDfsSpend } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { makeKit, type Loc } from "./testkit";
import { LOCATION_CENTER_QUEUE, addressHash, livePlacesCenter, processLocationCenter } from "./locations/center";
import { enqueueLocationCenterBackfill } from "./locations/center-backfill";
import { PgBoss } from "pg-boss";
import { platformDayToDateUsd } from "./geogrid/cost";
import { LOCATION_CENTER } from "./config/location-center";
import { GEOGRID_PLATFORM_CAP } from "./config/geogrid";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const boss = new PgBoss(url);
beforeAll(async () => {
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(LOCATION_CENTER_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  setSharedMockGoogleClient(null);
  await kit.deactivateAll();
  await sql.end();
});

type G = { name: string; latlng?: unknown; metadata?: unknown; storefrontAddress?: unknown };
const gOf = (loc: Loc) => (mock as unknown as { locations: G[] }).locations.find((l) => l.name === loc.google)!;
const row = async (loc: Loc) => (await db.select().from(locations).where(eq(locations.id, loc.row.id)))[0]!;
const ADDR = { regionCode: "US", locality: "San Antonio", addressLines: ["1 Main St"] };

const calls: string[] = [];
const dfsCodes: number[] = [];
const fakes = (o: { places?: { lat: number; lng: number } | null; dfs?: { lat: number; lng: number; costUsd: number } | null; dfsOn?: boolean } = {}) => ({
  client: mock,
  places: async () => (calls.push("places"), o.places ?? null),
  dfsEnabled: () => o.dfsOn ?? true,
  dfs: async (_placeId: string, code: number) => (calls.push("dfs"), dfsCodes.push(code), o.dfs ?? null),
});

async function setup(opts: { latlng?: boolean; placeId?: string | null } = {}) {
  calls.length = 0;
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  const g = gOf(loc);
  g.storefrontAddress = ADDR;
  g.metadata = opts.placeId === null ? {} : { placeId: opts.placeId ?? "ChIJ-center-test-place" };
  if (opts.latlng) g.latlng = { latitude: 29.4241, longitude: -98.4936 };
  return { org, loc, g };
}
const job = (loc: Loc, reason: "onboarding" | "address_changed" | "backfill" = "onboarding") => ({ locationId: loc.row.id, reason });

describe("resolveLocationCenter order", () => {
  it("(a) Google's latlng wins and no paid lookup runs", async () => {
    const { loc } = await setup({ latlng: true });
    const r = await processLocationCenter(db, job(loc), fakes({ places: { lat: 1, lng: 1 }, dfs: { lat: 2, lng: 2, costUsd: 0.0054 } }));
    expect(r).toEqual({ outcome: "resolved", source: "google" });
    expect(calls).toEqual([]);
    const l = await row(loc);
    expect(l).toMatchObject({ centerLat: 29.4241, centerLng: -98.4936, centerSource: "google", centerAddressHash: addressHash(ADDR) });
    expect(l.centerUpdatedAt).toBeInstanceOf(Date);
  });

  it("(b) Google has no latlng and a Places key is set: Places answers, DataForSEO is not called", async () => {
    const { loc } = await setup();
    const r = await processLocationCenter(db, job(loc), fakes({ places: { lat: 10.5, lng: 20.5 }, dfs: { lat: 2, lng: 2, costUsd: 0.0054 } }));
    expect(r).toEqual({ outcome: "resolved", source: "places" });
    expect(calls).toEqual(["places"]);
    expect(await row(loc)).toMatchObject({ centerLat: 10.5, centerLng: 20.5, centerSource: "places" });
  });

  it("(c) no Places answer: DataForSEO answers and the cost is recorded as platform spend", async () => {
    const { loc } = await setup();
    const before = await platformDayToDateUsd(db, new Date());
    const r = await processLocationCenter(db, job(loc), fakes({ dfs: { lat: 23.18, lng: 72.63, costUsd: 0.0054 } }));
    expect(r).toEqual({ outcome: "resolved", source: "dataforseo" });
    expect(calls).toEqual(["places", "dfs"]);
    expect(await row(loc)).toMatchObject({ centerLat: 23.18, centerLng: 72.63, centerSource: "dataforseo" });
    const spends = await db.select().from(platformDfsSpend).where(eq(platformDfsSpend.locationId, loc.row.id));
    expect(spends).toHaveLength(1);
    const spend = spends[0];
    expect(Number(spend!.costUsd)).toBe(LOCATION_CENTER.dataforseo.perProfileUsd);
    expect(spend!.kind).toBe("location_center");
    // other suites share the test database and may spend too: the day total includes at least this lookup
    expect(await platformDayToDateUsd(db, new Date())).toBeGreaterThanOrEqual(before + 0.0054 - 1e-9);
  });

  it("(c) DataForSEO is not called when it is not live or the platform's daily cap is spent", async () => {
    const off = await setup();
    await processLocationCenter(db, job(off.loc), fakes({ dfsOn: false, dfs: { lat: 2, lng: 2, costUsd: 0.0054 } }));
    expect(calls).not.toContain("dfs");

    const capped = await setup();
    const [spent] = await db.insert(platformDfsSpend).values({ kind: "test", costUsd: String(GEOGRID_PLATFORM_CAP.dailyUsd) }).returning({ id: platformDfsSpend.id });
    const id = spent!.id;
    try {
      calls.length = 0;
      const r = await processLocationCenter(db, job(capped.loc), fakes({ dfs: { lat: 2, lng: 2, costUsd: 0.0054 } }));
      expect(calls).not.toContain("dfs");
      expect(r.outcome).toBe("unresolved");
    } finally {
      await db.delete(platformDfsSpend).where(eq(platformDfsSpend.id, id));
    }
  });

  it("(d) all lookups miss: the location's newest rank tracker centre is used", async () => {
    const { org, loc } = await setup();
    const base = { orgId: org.orgId, createdBy: org.ownerId, workspaceId: org.a, locationId: loc.row.id, keywords: ["k"], gridSize: 3, radiusM: 1000, driverId: "dataforseo_standard" as const, targetName: "T", kind: "tracker" as const };
    await db.insert(gridConfigs).values({ ...base, centerLat: 1, centerLng: 2, updatedAt: new Date("2026-01-01") });
    await db.insert(gridConfigs).values({ ...base, centerLat: 23.1841, centerLng: 72.62975, updatedAt: new Date("2026-06-01") });
    const r = await processLocationCenter(db, job(loc), fakes());
    expect(r).toEqual({ outcome: "resolved", source: "tracker" });
    expect(await row(loc)).toMatchObject({ centerLat: 23.1841, centerLng: 72.62975, centerSource: "tracker" });
  });

  it("everything misses and there is no tracker: coordinates stay null", async () => {
    const { loc } = await setup();
    const r = await processLocationCenter(db, job(loc), fakes());
    expect(r.outcome).toBe("unresolved");
    expect(await row(loc)).toMatchObject({ centerLat: null, centerLng: null, centerSource: null });
  });

  it("without a place id, DataForSEO is not asked (it needs one)", async () => {
    const { loc } = await setup({ placeId: null });
    await processLocationCenter(db, job(loc), fakes({ dfs: { lat: 2, lng: 2, costUsd: 0.0054 } }));
    expect(calls).not.toContain("dfs");
  });
});

describe("only an address change re-resolves", () => {
  it("a location that already has coordinates for the current address is left alone", async () => {
    const { loc } = await setup({ latlng: true });
    await processLocationCenter(db, job(loc), fakes());
    gOf(loc).latlng = { latitude: 5, longitude: 5 };
    const r = await processLocationCenter(db, job(loc, "backfill"), fakes());
    expect(r.outcome).toBe("unchanged");
    expect(await row(loc)).toMatchObject({ centerLat: 29.4241 });
  });

  it("a changed address resolves again and stores the new hash", async () => {
    const { loc, g } = await setup({ latlng: true });
    await processLocationCenter(db, job(loc), fakes());
    const moved = { ...ADDR, addressLines: ["99 New Rd"] };
    g.storefrontAddress = moved;
    g.latlng = { latitude: 30, longitude: -97 };
    const r = await processLocationCenter(db, job(loc, "address_changed"), fakes());
    expect(r.outcome).toBe("resolved");
    expect(await row(loc)).toMatchObject({ centerLat: 30, centerLng: -97, centerAddressHash: addressHash(moved) });
  });

  it("a moved address no lookup can place keeps the old coordinates, records the new hash and time (no nightly retries)", async () => {
    const { loc, g } = await setup({ latlng: true });
    await processLocationCenter(db, job(loc), fakes());
    const before = await row(loc);
    g.storefrontAddress = { ...ADDR, addressLines: ["99 New Rd"] };
    delete g.latlng;
    const r = await processLocationCenter(db, job(loc, "address_changed"), fakes());
    expect(r.outcome).toBe("unresolved");
    const l = await row(loc);
    expect(l).toMatchObject({ centerLat: 29.4241, centerLng: -98.4936, centerSource: "google" });
    expect(l.centerAddressHash).toBe(addressHash(g.storefrontAddress));
    expect(l.centerUpdatedAt!.getTime()).toBeGreaterThanOrEqual(before.centerUpdatedAt!.getTime());
  });

  it("a manual centre is never overwritten, even when the address changed", async () => {
    const { loc } = await setup({ latlng: true });
    await db.update(locations).set({ centerLat: 7, centerLng: 8, centerSource: "manual", centerAddressHash: "old" }).where(eq(locations.id, loc.row.id));
    const r = await processLocationCenter(db, job(loc, "address_changed"), fakes());
    expect(r.outcome).toBe("kept_manual");
    expect(await row(loc)).toMatchObject({ centerLat: 7, centerLng: 8, centerSource: "manual" });
  });

  it("addressHash ignores whitespace and region case, and differs for a different address", () => {
    expect(addressHash({ regionCode: "us", addressLines: [" 1 Main St "] })).toBe(addressHash({ regionCode: "US", addressLines: ["1 Main St"] }));
    expect(addressHash(ADDR)).not.toBe(addressHash({ ...ADDR, locality: "Austin" }));
    expect(addressHash(undefined)).toBeNull();
  });
});

describe("backfill", () => {
  it("queues only active linked locations without coordinates, and a dry run queues nothing", async () => {
    const org = await kit.makeOrg();
    const bare = await org.mkLoc(org.a);
    const has = await org.mkLoc(org.a, { centerLat: 1, centerLng: 2, centerSource: "google" });
    const manual = await org.mkLoc(org.a, { centerLat: null, centerSource: "manual" });
    const count = async (l: Loc) =>
      Number((await sql<{ n: string }[]>`select count(*)::text as n from pgboss.job where name = ${LOCATION_CENTER_QUEUE} and data->>'locationId' = ${l.row.id}`)[0]!.n);
    const dry = await enqueueLocationCenterBackfill(db, { orgId: org.orgId, dryRun: true });
    expect(dry).toEqual({ candidates: 1, enqueued: 0 });
    expect(await count(bare)).toBe(0);
    const r = await enqueueLocationCenterBackfill(db, { orgId: org.orgId });
    expect(r).toEqual({ candidates: 1, enqueued: 1 });
    expect([await count(bare), await count(has), await count(manual)]).toEqual([1, 0, 0]);
  });
});

describe("live Places lookup", () => {
  it("makes no request without a key", async () => {
    const fetch = vi.fn();
    const out = await livePlacesCenter({ key: async () => undefined, fetch: fetch as unknown as typeof globalThis.fetch })({ placeId: "ChIJ-x-0123456789", query: "q" });
    expect(out).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks Place Details for a place id and reads location.latitude/longitude", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ location: { latitude: 1.5, longitude: 2.5 } }), { status: 200 }));
    const out = await livePlacesCenter({ key: async () => "k", fetch: fetch as unknown as typeof globalThis.fetch })({ placeId: "ChIJ-x-0123456789", query: "q" });
    expect(out).toEqual({ lat: 1.5, lng: 2.5 });
    const [u, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(u).toBe("https://places.googleapis.com/v1/places/ChIJ-x-0123456789");
    expect((init.headers as Record<string, string>)["x-goog-fieldmask"]).toBe("location");
  });
});


describe("DataForSEO location follows the business's country", () => {
  it.each([
    ["IN", 2356],
    ["au", 2036],
    ["US", 2840],
    ["ZZ", 2840],
  ])("storefront region %s asks DataForSEO for location %i", async (region, code) => {
    const { loc, g } = await setup();
    g.storefrontAddress = { ...ADDR, regionCode: region };
    dfsCodes.length = 0;
    const r = await processLocationCenter(db, job(loc), fakes({ dfs: { lat: 23.18, lng: 72.63, costUsd: 0.0054 } }));
    expect(r).toEqual({ outcome: "resolved", source: "dataforseo" });
    expect(dfsCodes).toEqual([code]);
  });
});
