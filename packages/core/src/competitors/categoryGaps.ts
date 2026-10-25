import type { CompetitorCategories } from "./categories";

export type CategoryGapEvidence = {
  placeId: string;
  title: string;
  /** 1 = the competitor seen at the most grid points in the stored scans. */
  rank: number;
  appearances: number;
  /** The competitor lists this category as its primary one (otherwise as an additional one). */
  isPrimary: boolean;
};

export type CategoryGap = {
  /** The competitors' own wording of the category (a display name such as "Emergency dental service"). */
  name: string;
  competitors: number;
  asPrimary: number;
  /** Best rank first. */
  evidence: CategoryGapEvidence[];
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The categories that ranking competitors use and the location lacks, most-used first, with the
 * competitors behind each one. `ownCategoryNames` are the location's category display names.
 * Pure: no reads. Shared by K3 (suggestions) and available to L7 (category fit).
 */
export function categoriesCompetitorsHaveThatLocationLacks(
  competitorCategories: Pick<CompetitorCategories, "competitors">,
  ownCategoryNames: readonly string[],
): CategoryGap[] {
  const own = new Set(ownCategoryNames.map(norm));
  const gaps = new Map<string, CategoryGap>();
  competitorCategories.competitors.forEach((c, i) => {
    const names = [...new Set([...(c.primary ? [c.primary] : []), ...c.additional])];
    for (const name of names) {
      const key = norm(name);
      if (!key || own.has(key)) continue;
      const gap = gaps.get(key) ?? { name, competitors: 0, asPrimary: 0, evidence: [] };
      const isPrimary = name === c.primary;
      gap.competitors++;
      if (isPrimary) gap.asPrimary++;
      gap.evidence.push({ placeId: c.placeId, title: c.title, rank: i + 1, appearances: c.appearances, isPrimary });
      gaps.set(key, gap);
    }
  });
  return [...gaps.values()].sort(
    (a, b) => b.competitors - a.competitors || b.asPrimary - a.asPrimary || a.name.localeCompare(b.name),
  );
}
