import type { GoogleCategory } from "../google/client";

/** The categories one competitor lists, as stored by K2 part 2 (display names, plus gcid ids). */
export type CompetitorCats = { primary: string | null; additional: string[]; ids: string[] };

/** One comparable key for "Real estate agency", "gcid:real_estate_agency" and "categories/gcid:real_estate_agency". */
export const categoryKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^categories\//, "")
    .replace(/^gcid:/, "")
    .replace(/[_\s]+/g, " ")
    .trim();

/** Every key one of the listing's own categories answers to (its resource name and, when Google sent it, its display name). */
export function ownCategoryKeys(c: GoogleCategory): Set<string> {
  return new Set([c.name, c.displayName].filter((x): x is string => !!x).map(categoryKey));
}

const keysOf = (c: CompetitorCats): Set<string> =>
  new Set([c.primary, ...c.additional, ...c.ids].filter((x): x is string => !!x).map(categoryKey));

/** How many of the competitors list a category (as primary or additional) matching any of `keys`. */
export function shareUsing(keys: Set<string>, competitors: CompetitorCats[]): { using: number; total: number } {
  const using = competitors.filter((c) => {
    const have = keysOf(c);
    return [...keys].some((k) => have.has(k));
  }).length;
  return { using, total: competitors.length };
}

/**
 * Categories at least `minShare` of the competitors list that the listing does not have, most used
 * first. `minShare` 0 gives every category any competitor uses (what category suggestions want).
 */
export function missingCompetitorCategories(
  own: { primary?: GoogleCategory; additional: GoogleCategory[] },
  competitors: CompetitorCats[],
  minShare: number,
): { name: string; competitors: number; total: number }[] {
  const have = new Set([...(own.primary ? ownCategoryKeys(own.primary) : []), ...own.additional.flatMap((c) => [...ownCategoryKeys(c)])]);
  const tally = new Map<string, { name: string; competitors: number }>();
  for (const c of competitors) {
    // One display name per category per competitor; ids only help matching, they are not shown.
    const seen = new Set<string>();
    for (const name of [c.primary, ...c.additional]) {
      if (!name) continue;
      const k = categoryKey(name);
      if (have.has(k) || seen.has(k)) continue;
      seen.add(k);
      const t = tally.get(k) ?? { name, competitors: 0 };
      t.competitors++;
      tally.set(k, t);
    }
  }
  const total = competitors.length;
  return [...tally.values()]
    .filter((t) => t.competitors > 0 && t.competitors / total >= minShare)
    .sort((a, b) => b.competitors - a.competitors || a.name.localeCompare(b.name))
    .map((t) => ({ ...t, total }));
}
