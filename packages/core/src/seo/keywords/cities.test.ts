import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, dfsGeoLocations } from "@opengmb/db";
import { eq } from "drizzle-orm";
import { searchCities } from "./cities";
import { fixtureKeywordTransport, type KeywordTransport } from "./transport";
import { sql as dsql } from "drizzle-orm";

vi.setConfig({ testTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(async () => { await sql.end(); });

function counting(): { t: KeywordTransport; calls: () => number } {
  const base = fixtureKeywordTransport();
  let n = 0;
  return { t: { ...base, fixture: false, adsLocations: async (c) => { n++; return base.adsLocations(c); } }, calls: () => n };
}

describe("city registry", () => {
  it("fills an empty country from the transport, finds Austin (canary), caches, and rejects bad input", async () => {
    await db.delete(dfsGeoLocations).where(eq(dfsGeoLocations.countryIso, "US"));
    const { t, calls } = counting();
    const found = await searchCities(db, { countryIso: "US", query: "aust", transport: t });
    expect(found.map((f) => f.locationName)).toContain("Austin,Texas,United States");
    expect(found.length).toBeLessThanOrEqual(10);
    expect(found[0]).toMatchObject({ locationType: "City" });
    expect(found.some((f) => f.locationType === "State")).toBe(false);
    expect(calls()).toBe(1);
    await searchCities(db, { countryIso: "US", query: "dall", transport: t });
    expect(calls()).toBe(1);
    expect(await searchCities(db, { countryIso: "US", query: "a", transport: t })).toEqual([]);
    expect(await searchCities(db, { countryIso: "US", query: "%%", transport: t })).toEqual([]);
    await expect(searchCities(db, { countryIso: "FR", query: "paris", transport: t })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // an old registry is refreshed
    const later = new Date(Date.now() + 40 * 86_400_000);
    await searchCities(db, { countryIso: "US", query: "aust", transport: t, now: later });
    expect(calls()).toBe(2);
  });

  it("fixture mode serves sample cities from memory and stores nothing", async () => {
    await db.delete(dfsGeoLocations).where(eq(dfsGeoLocations.countryIso, "AU"));
    const found = await searchCities(db, { countryIso: "AU", query: "syd", transport: fixtureKeywordTransport() });
    expect(found.map((f) => f.locationName)).toEqual(["Sydney,New South Wales,Australia"]);
    const [n] = await db.select({ n: dsql<number>`count(*)::int` }).from(dfsGeoLocations).where(eq(dfsGeoLocations.countryIso, "AU"));
    expect(n!.n).toBe(0);
  });
});
