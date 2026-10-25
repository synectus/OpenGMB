/** R9: pure helpers for the competitor review benchmark. Input is stored K2 snapshot rows, no I/O. */

export type BenchRow = {
  placeId: string;
  title: string;
  appearances: number;
  averageRank: number;
  rating: number | null;
  reviewCount: number | null;
};

/** Same business across keywords/trackers: appearances add up, rank is the appearance-weighted mean, review figures come from the row with the most reviews. */
export function topCompetitors(rows: readonly BenchRow[], limit = 3): BenchRow[] {
  const byPlace = new Map<string, { row: BenchRow; rankSum: number }>();
  for (const r of rows) {
    const cur = byPlace.get(r.placeId);
    if (!cur) {
      byPlace.set(r.placeId, { row: { ...r }, rankSum: r.averageRank * r.appearances });
      continue;
    }
    cur.rankSum += r.averageRank * r.appearances;
    cur.row.appearances += r.appearances;
    if ((r.reviewCount ?? -1) > (cur.row.reviewCount ?? -1)) {
      cur.row.reviewCount = r.reviewCount;
      cur.row.rating = r.rating;
    }
  }
  return [...byPlace.values()]
    .map(({ row, rankSum }) => ({ ...row, averageRank: row.appearances > 0 ? Math.round((rankSum / row.appearances) * 100) / 100 : row.averageRank }))
    .sort((a, b) => b.appearances - a.appearances || a.averageRank - b.averageRank || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export type CountPoint = { day: string; reviewCount: number };

const DAY_MS = 86_400_000;

/**
 * Review count change per 30 days between the oldest and newest stored snapshot day.
 * Null ("not enough history") with fewer than 2 distinct days.
 */
export function velocityPer30Days(points: readonly CountPoint[]): { perThirtyDays: number; fromDay: string; toDay: string; days: number } | null {
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last || first.day === last.day) return null;
  const days = Math.round((Date.parse(`${last.day}T00:00:00Z`) - Date.parse(`${first.day}T00:00:00Z`)) / DAY_MS);
  if (days < 1) return null;
  return {
    perThirtyDays: Math.round(((last.reviewCount - first.reviewCount) / days) * 30 * 10) / 10,
    fromDay: first.day,
    toDay: last.day,
    days,
  };
}
