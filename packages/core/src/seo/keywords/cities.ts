import { and, desc, eq, ilike, inArray, max, sql } from "drizzle-orm";
import { dfsGeoLocations, type Db, type Tx } from "@opengmb/db";
import { DFS_COUNTRY_LOCATIONS } from "../../config/dfs-locations";
import { SEO_KEYWORDS } from "../../config/seo";
import { CoreError } from "../../errors";
import { rankSource } from "../../geogrid/drivers/source";
import { fixtureGeoRows } from "./fixtures";
import { fixtureKeywordTransport, liveKeywordTransport, type KeywordTransport } from "./transport";

export const defaultKeywordTransport = (): KeywordTransport => (rankSource() === "fixture" ? fixtureKeywordTransport() : liveKeywordTransport());

export function assertCountry(countryIso: string): string {
  const iso = countryIso.trim().toUpperCase();
  if (!(iso in DFS_COUNTRY_LOCATIONS.codes)) throw new CoreError("INVALID_INPUT", `Country ${countryIso} is not supported`);
  return iso;
}

/** Fill the country's geotargets when it has none or the newest row is older than registryMaxAgeDays. Free call. */
async function ensureRegistry(db: Db, iso: string, now: Date, transport: KeywordTransport): Promise<void> {
  const [row] = await db.select({ newest: max(dfsGeoLocations.fetchedAt) }).from(dfsGeoLocations).where(eq(dfsGeoLocations.countryIso, iso));
  const newest = row?.newest;
  if (newest && now.getTime() - newest.getTime() < SEO_KEYWORDS.registryMaxAgeDays * 86_400_000) return;
  const fetched = (await transport.adsLocations(iso)).filter((r) => (SEO_KEYWORDS.cityTypes as readonly string[]).includes(r.location_type));
  if (fetched.length === 0) return; // keep what we have rather than wipe the list on an empty answer
  await db.transaction(async (tx) => {
    await tx.delete(dfsGeoLocations).where(eq(dfsGeoLocations.countryIso, iso));
    for (let i = 0; i < fetched.length; i += 1000) {
      await tx.insert(dfsGeoLocations).values(
        fetched.slice(i, i + 1000).map((r) => ({ countryIso: iso, locationCode: r.location_code, locationName: r.location_name, locationType: r.location_type, fetchedAt: now })),
      );
    }
  });
}

export async function searchCities(
  db: Db,
  p: { countryIso: string; query: string; now?: Date; transport?: KeywordTransport },
): Promise<{ locationName: string; locationType: string }[]> {
  const iso = assertCountry(p.countryIso);
  const q = p.query.trim();
  if (q.length < 2) return [];
  const transport = p.transport ?? defaultKeywordTransport();
  if (transport.fixture) {
    // Sample cities are served from memory and never stored, so a later real key gets the real list.
    const needle = q.toLowerCase();
    return fixtureGeoRows(iso)
      .filter((r) => (SEO_KEYWORDS.cityTypes as readonly string[]).includes(r.location_type) && r.location_name.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.location_type === "City") - Number(a.location_type === "City") || a.location_name.length - b.location_name.length)
      .slice(0, 10)
      .map((r) => ({ locationName: r.location_name, locationType: r.location_type }));
  }
  await ensureRegistry(db, iso, p.now ?? new Date(), transport);
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db
    .select({ locationName: dfsGeoLocations.locationName, locationType: dfsGeoLocations.locationType })
    .from(dfsGeoLocations)
    .where(and(eq(dfsGeoLocations.countryIso, iso), ilike(dfsGeoLocations.locationName, `%${escaped}%`), inArray(dfsGeoLocations.locationType, [...SEO_KEYWORDS.cityTypes])))
    .orderBy(desc(sql`(${dfsGeoLocations.locationType} = 'City')`), sql`length(${dfsGeoLocations.locationName})`)
    .limit(10);
}

/** True when `name` is a geotarget we offer for the country. Reads the stored list only (no provider call); the city search fills it. */
export async function cityExists(db: Db | Tx, p: { countryIso: string; name: string }): Promise<boolean> {
  const iso = assertCountry(p.countryIso);
  const [r] = await db.select({ n: dfsGeoLocations.locationCode }).from(dfsGeoLocations).where(and(eq(dfsGeoLocations.countryIso, iso), eq(dfsGeoLocations.locationName, p.name))).limit(1);
  return !!r;
}
