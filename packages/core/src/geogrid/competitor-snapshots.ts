import { competitorTable, type Competitor } from "./analytics";

/** One competitor as stored per tracker, keyword and day. */
export type SnapshotRow = {
  placeId: string;
  title: string;
  address: string | null;
  appearances: number;
  averageRank: number;
  bestRank: number;
  rating: number | null;
  reviewCount: number | null;
  /** K2c: Google categories from the scan; null/empty when the scan carried none. */
  category?: string | null;
  additionalCategories?: string[];
  categoryIds?: string[];
  /** fixture | sandbox | live. Stored rows carry it; the diff only compares rows of the same source. */
  dataSource?: string;
};

/** The competitors of one run (target excluded). Businesses without a place id cannot be matched across days, so they are left out. */
export function snapshotRowsFromPoints(points: readonly { competitors: Competitor[] }[]): SnapshotRow[] {
  return competitorTable(points).flatMap((c) =>
    c.placeId
      ? [
          {
            placeId: c.placeId,
            title: c.business,
            address: c.address,
            appearances: c.appearances,
            averageRank: c.averageRank,
            bestRank: c.bestRank,
            rating: c.rating,
            reviewCount: c.reviewCount,
            category: c.category,
            additionalCategories: c.additionalCategories,
            categoryIds: c.categoryIds,
          },
        ]
      : [],
  );
}

export type CompetitorChange = SnapshotRow & {
  status: "new" | "dropped" | "continuing";
  /** Previous average rank minus current: positive = moved up. Null unless continuing. */
  rankChange: number | null;
  /** Review count change since the previous snapshot (review velocity). Null when either count is unknown or not continuing. */
  reviewsAdded: number | null;
  /** Rating change since the previous snapshot. Null when either rating is unknown or not continuing. */
  ratingChange: number | null;
};

const delta = (cur: number | null, prev: number | null, round: (n: number) => number): number | null =>
  cur === null || prev === null ? null : round(cur - prev);

/**
 * Current snapshot against the previous one. With no previous snapshot (null) nothing is "new": every row is
 * "continuing" with no changes, so the first day is not flagged as all-new. Order: current rows by appearances
 * then average rank, then dropped rows.
 */
export function diffCompetitorSnapshots(current: readonly SnapshotRow[], previous: readonly SnapshotRow[] | null): CompetitorChange[] {
  // Different sources are different worlds (sample vs real businesses): never diff across them.
  const source = current[0]?.dataSource;
  if (previous && source) previous = previous.filter((p) => p.dataSource === source);
  if (previous && previous.length === 0) previous = null;
  const prev = new Map((previous ?? []).map((p) => [p.placeId, p]));
  const seen = new Set<string>();
  const live: CompetitorChange[] = current.map((c) => {
    seen.add(c.placeId);
    const p = prev.get(c.placeId);
    if (!p) return { ...c, status: previous ? "new" : "continuing", rankChange: null, reviewsAdded: null, ratingChange: null };
    return {
      ...c,
      status: "continuing",
      rankChange: Math.round((p.averageRank - c.averageRank) * 100) / 100,
      reviewsAdded: delta(c.reviewCount, p.reviewCount, Math.round),
      ratingChange: delta(c.rating, p.rating, (n) => Math.round(n * 10) / 10),
    };
  });
  live.sort((a, b) => b.appearances - a.appearances || a.averageRank - b.averageRank || a.title.localeCompare(b.title));
  const dropped: CompetitorChange[] = (previous ?? [])
    .filter((p) => !seen.has(p.placeId))
    .map((p) => ({ ...p, status: "dropped", rankChange: null, reviewsAdded: null, ratingChange: null }));
  return [...live, ...dropped];
}
