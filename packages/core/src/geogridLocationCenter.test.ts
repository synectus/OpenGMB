import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, gridConfigs, locations } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
beforeAll(() => setSharedMockGoogleClient(mock));
afterAll(async () => {
  setSharedMockGoogleClient(null);
  await kit.deactivateAll();
  await sql.end();
});

type Centre = { centerLat: number | null; centerLng: number | null; centerSource: string | null; placeId: string | null; note: string | null };

describe("U7: geogrid.locationCenter fills a new tracker from the location", () => {
  it("returns Google's coordinates and place id for a linked location", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const g = (mock as unknown as { locations: { name: string; latlng?: unknown; metadata?: unknown }[] }).locations.find((l) => l.name === loc.google)!;
    g.latlng = { latitude: 29.4241, longitude: -98.4936 };
    g.metadata = { placeId: "ChIJ-test-place-id_1" };
    const out = await kit.run<Centre>(org.manager, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toEqual({ centerLat: 29.4241, centerLng: -98.4936, centerSource: "google", placeId: "ChIJ-test-place-id_1", websiteDomain: "example.test", note: null });
  });

  it("still returns the place id, with a note, when Google has no coordinates", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const g = (mock as unknown as { locations: { name: string; metadata?: unknown }[] }).locations.find((l) => l.name === loc.google)!;
    g.metadata = { placeId: "ChIJ-test-place-id_2" };
    const out = await kit.run<Centre>(org.owner, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toMatchObject({ centerLat: null, centerLng: null, placeId: "ChIJ-test-place-id_2" });
    expect(out.note).toContain("no coordinates");
  });

  it("without Google coordinates, falls back to the newest rank tracker's centre and place id, and says so", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const base = { orgId: org.orgId, createdBy: org.ownerId, workspaceId: org.a, locationId: loc.row.id, keywords: ["k"], gridSize: 3, radiusM: 1000, driverId: "dataforseo_standard" as const, targetName: "T" };
    await db.insert(gridConfigs).values({ ...base, kind: "tracker", centerLat: 1, centerLng: 2, targetPlaceId: "old", updatedAt: new Date("2026-01-01") });
    await db.insert(gridConfigs).values({ ...base, kind: "tracker", centerLat: 23.1841, centerLng: 72.62975, targetPlaceId: "ChIJ-tracker-place", updatedAt: new Date("2026-06-01") });
    await db.insert(gridConfigs).values({ ...base, kind: "keyword_rank", gridSize: 1, centerLat: 9, centerLng: 9, updatedAt: new Date("2026-09-01") });
    const out = await kit.run<Centre>(org.owner, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toMatchObject({ centerLat: 23.1841, centerLng: 72.62975, centerSource: "tracker", placeId: "ChIJ-tracker-place" });
    expect(out.note).toBe("Using the centre of your rank tracker. Google has no coordinates for this location.");
  });

  it("with neither Google coordinates nor a tracker, gives null and a note", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const out = await kit.run<Centre>(org.owner, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toMatchObject({ centerLat: null, centerLng: null, centerSource: null, note: "Google has no coordinates for this location." });
  });

  it("the coordinates stored on the location win over a live Google read, and say where they came from", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const g = (mock as unknown as { locations: { name: string; latlng?: unknown; metadata?: unknown }[] }).locations.find((l) => l.name === loc.google)!;
    g.latlng = { latitude: 1, longitude: 1 };
    g.metadata = { placeId: "ChIJ-test-place-id_3" };
    await db.update(locations).set({ centerLat: 23.18, centerLng: 72.63, centerSource: "dataforseo" }).where(eq(locations.id, loc.row.id));
    const out = await kit.run<Centre>(org.owner, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toMatchObject({ centerLat: 23.18, centerLng: 72.63, centerSource: "dataforseo", placeId: "ChIJ-test-place-id_3", note: null });
  });

  it("stored coordinates also serve an unlinked location", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await db.update(locations).set({ googleLocationId: null, googleAccountName: null, centerLat: 5, centerLng: 6, centerSource: "manual" }).where(eq(locations.id, loc.row.id));
    const out = await kit.run<Centre>(org.owner, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toMatchObject({ centerLat: 5, centerLng: 6, centerSource: "manual", placeId: null });
  });

  it("an unlinked location gives empty values and a note, not an error", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await db.update(locations).set({ googleLocationId: null, googleAccountName: null }).where(eq(locations.id, loc.row.id));
    const out = await kit.run<Centre>(org.owner, "geogrid.locationCenter", { locationId: loc.row.id });
    expect(out).toEqual({ centerLat: null, centerLng: null, centerSource: null, placeId: null, websiteDomain: null, note: "This location is not linked to Google." });
  });

  it("is for people who can manage trackers: clients are refused", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    expect(await codeOf(kit.run(org.viewerA, "geogrid.locationCenter", { locationId: loc.row.id }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(org.approverA, "geogrid.locationCenter", { locationId: loc.row.id }))).toBe("FORBIDDEN");
  });
});
