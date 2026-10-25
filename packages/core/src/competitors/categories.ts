import { and, desc, eq, inArray } from "drizzle-orm";
import { competitorProfiles, gridCompetitorSnapshots, gridConfigs, type Db, type Tx } from "@opengmb/db";
import { COMPETITOR_PROFILES } from "../config/competitor-profiles";

export type CompetitorCategoryRow = {
  placeId: string;
  title: string;
  /** Grid points where it appeared in the tracker's latest scans, summed over keywords and trackers. */
  appearances: number;
  primary: string | null;
  additional: string[];
  ids: string[];
  fetchedAt: string;
};

export type CompetitorCategories = {
  /** The one data source everything below comes from. Null when nothing is stored. Sample data is never mixed with live. */
  dataSource: "fixture" | "sandbox" | "live" | null;
  competitors: CompetitorCategoryRow[];
  /** Each category (primary or additional), with how many of those competitors use it and how many use it as their primary. */
  categories: { name: string; competitors: number; asPrimary: number }[];
};

const SOURCE_ORDER = { live: 0, sandbox: 1, fixture: 2 } as const;

/**
 * The categories the top competitors of a location's trackers use (for K3 category suggestions and
 * L7's category-fit check). Reads stored data only. Uses the data source of the location's newest
 * competitor snapshot, so live data is never blended with sample data. Always scoped to `orgId`.
 */
export async function getCompetitorCategories(db: Db | Tx, orgId: string, locationId: string): Promise<CompetitorCategories> {
  const empty: CompetitorCategories = { dataSource: null, competitors: [], categories: [] };
  const configs = await db
    .select({ id: gridConfigs.id })
    .from(gridConfigs)
    .where(and(eq(gridConfigs.orgId, orgId), eq(gridConfigs.locationId, locationId), eq(gridConfigs.kind, "tracker")));
  if (configs.length === 0) return empty;
  const snaps = await db
    .select()
    .from(gridCompetitorSnapshots)
    .where(and(eq(gridCompetitorSnapshots.orgId, orgId), inArray(gridCompetitorSnapshots.configId, configs.map((c) => c.id))))
    .orderBy(desc(gridCompetitorSnapshots.snapshotDate));
  if (snaps.length === 0) return empty;
  const newest = snaps[0]!.snapshotDate;
  const dataSource = snaps.filter((s) => s.snapshotDate === newest).map((s) => s.dataSource).sort((a, b) => SOURCE_ORDER[a] - SOURCE_ORDER[b])[0]!;

  // Latest day per tracker and keyword, for this source; per tracker keep the top competitors by appearances.
  const latestDay = new Map<string, string>();
  for (const s of snaps) {
    if (s.dataSource !== dataSource) continue;
    const k = `${s.configId}\u0000${s.keyword}`;
    if (!latestDay.has(k)) latestDay.set(k, s.snapshotDate);
  }
  // Newest scan snapshot of this source that carries categories, per business (snaps are newest first).
  const scanCategories = new Map<string, { primary: string; additional: string[]; ids: string[]; at: Date }>();
  for (const s of snaps) {
    if (s.dataSource !== dataSource || !s.category || scanCategories.has(s.placeId)) continue;
    scanCategories.set(s.placeId, { primary: s.category, additional: s.additionalCategories ?? [], ids: s.categoryIds ?? [], at: s.createdAt });
  }
  const perConfig = new Map<string, Map<string, { title: string; appearances: number }>>();
  for (const s of snaps) {
    if (s.dataSource !== dataSource || latestDay.get(`${s.configId}\u0000${s.keyword}`) !== s.snapshotDate) continue;
    const m = perConfig.get(s.configId) ?? new Map();
    const cur = m.get(s.placeId) ?? { title: s.title, appearances: 0 };
    cur.appearances += s.appearances;
    m.set(s.placeId, cur);
    perConfig.set(s.configId, m);
  }
  const top = new Map<string, { title: string; appearances: number }>();
  for (const m of perConfig.values()) {
    const ranked = [...m].sort((a, b) => b[1].appearances - a[1].appearances).slice(0, COMPETITOR_PROFILES.topPerTracker);
    for (const [placeId, v] of ranked) {
      const cur = top.get(placeId) ?? { title: v.title, appearances: 0 };
      cur.appearances += v.appearances;
      top.set(placeId, cur);
    }
  }
  if (top.size === 0) return { ...empty, dataSource };

  const profiles = await db
    .select()
    .from(competitorProfiles)
    .where(and(eq(competitorProfiles.orgId, orgId), eq(competitorProfiles.dataSource, dataSource), inArray(competitorProfiles.placeId, [...top.keys()])))
    .orderBy(desc(competitorProfiles.fetchedOn));
  const latest = new Map<string, (typeof profiles)[number]>();
  for (const p of profiles) if (!latest.has(p.placeId) && p.categories.primary) latest.set(p.placeId, p);

  // A paid profile wins; otherwise the scan's categories (free with every Maps result) stand in.
  const competitors: CompetitorCategoryRow[] = [];
  for (const [placeId, t] of top) {
    const p = latest.get(placeId);
    const sc = scanCategories.get(placeId);
    const src = p ? { primary: p.categories.primary, additional: p.categories.additional, ids: p.categories.ids, at: p.fetchedAt } : sc;
    if (!src) continue;
    competitors.push({ placeId, title: t.title, appearances: t.appearances, primary: src.primary, additional: src.additional, ids: src.ids, fetchedAt: src.at.toISOString() });
  }
  competitors.sort((a, b) => b.appearances - a.appearances || a.title.localeCompare(b.title));
  const tally = new Map<string, { competitors: number; asPrimary: number }>();
  for (const c of competitors) {
    for (const name of new Set([...(c.primary ? [c.primary] : []), ...c.additional])) {
      const t = tally.get(name) ?? { competitors: 0, asPrimary: 0 };
      t.competitors++;
      if (name === c.primary) t.asPrimary++;
      tally.set(name, t);
    }
  }
  const categories = [...tally]
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => b.competitors - a.competitors || b.asPrimary - a.asPrimary || a.name.localeCompare(b.name));
  return { dataSource, competitors, categories };
}
