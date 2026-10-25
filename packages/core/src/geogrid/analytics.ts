import { GEOGRID_DEFAULTS } from "../config/geogrid";

export type Competitor = {
  rank: number;
  title: string | null;
  placeId: string | null;
  rating: number | null;
  isTarget: boolean;
  /** Absent on points stored before plan 4B1. */
  address?: string | null;
  /** Number of Google reviews (DataForSEO rating.votes_count). Absent on older points. */
  reviewCount?: number | null;
  /** Google categories from the Maps result (K2c). Absent on older points and on keyword-rank results. */
  category?: string | null;
  additionalCategories?: string[];
  categoryIds?: string[];
};

export type PointResult = {
  rank: number | null;
  top3: boolean;
  competitors: Competitor[];
  /** Keyword rank (K4) only: the website's organic position and its URL (null = not in the results fetched). */
  organicRank?: number | null;
  organicUrl?: string | null;
};

/**
 * Average rank over all points. A point where the target was not found counts as
 * GEOGRID_DEFAULTS.notFoundRank (21 = one worse than the deepest result we fetch), so a grid
 * that is mostly "not found" scores worse than one that is found at the edge. Null for no points.
 */
export function averageRank(points: readonly { rank: number | null }[]): number | null {
  if (points.length === 0) return null;
  const sum = points.reduce((s, p) => s + (p.rank ?? GEOGRID_DEFAULTS.notFoundRank), 0);
  return round2(sum / points.length);
}

export function top3Share(points: readonly { rank: number | null }[]): number | null {
  if (points.length === 0) return null;
  return round2(points.filter((p) => p.rank !== null && p.rank <= 3).length / points.length);
}

export function foundShare(points: readonly { rank: number | null }[]): number | null {
  if (points.length === 0) return null;
  return round2(points.filter((p) => p.rank !== null).length / points.length);
}

export function runSummary(points: readonly { rank: number | null }[]) {
  return {
    points: points.length,
    averageRank: averageRank(points),
    top3Share: top3Share(points),
    foundShare: foundShare(points),
  };
}

export type HistoryEntry = {
  runId: string;
  keyword: string;
  finishedAt: string | null;
  points: number;
  averageRank: number | null;
  top3Share: number | null;
  foundShare: number | null;
};

/** One entry per run, oldest first, for trend tables. */
export function runHistory(
  runs: readonly {
    id: string;
    keyword: string;
    finishedAt: Date | null;
    points: readonly { rank: number | null }[];
  }[],
): HistoryEntry[] {
  return [...runs]
    .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0))
    .map((r) => ({
      runId: r.id,
      keyword: r.keyword,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      ...runSummary(r.points),
    }));
}

export type CompetitorRow = {
  business: string;
  placeId: string | null;
  appearances: number;
  averageRank: number;
  bestRank: number;
  address: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** K2c: set only when a scan result carried categories. */
  category?: string;
  additionalCategories?: string[];
  categoryIds?: string[];
  isTarget: boolean;
};

/**
 * Businesses seen across the points, ordered by appearances then average rank. The target is left
 * out unless `includeTarget`; then it is one row ("You") and comes first. Address, rating and
 * review count are the first non-null values seen.
 */
export function competitorTable(
  points: readonly { competitors: Competitor[] }[],
  opts: { includeTarget?: boolean } = {},
): CompetitorRow[] {
  type Acc = Omit<CompetitorRow, "appearances" | "averageRank" | "bestRank"> & { ranks: number[] };
  const acc = new Map<string, Acc>();
  for (const p of points) {
    for (const c of p.competitors) {
      if (c.isTarget && !opts.includeTarget) continue;
      const key = c.isTarget ? "target" : (c.placeId ?? `t:${(c.title ?? "").trim().toLowerCase()}`);
      const cur: Acc = acc.get(key) ?? {
        business: c.title ?? c.placeId ?? "Unknown",
        placeId: c.placeId,
        address: null,
        rating: null,
        reviewCount: null,
        isTarget: c.isTarget,
        ranks: [],
      };
      cur.ranks.push(c.rank);
      cur.address ??= c.address ?? null;
      cur.rating ??= c.rating;
      cur.reviewCount ??= c.reviewCount ?? null;
      if (!cur.category && c.category) {
        cur.category = c.category;
        cur.additionalCategories = c.additionalCategories ?? [];
        cur.categoryIds = c.categoryIds ?? [];
      }
      acc.set(key, cur);
    }
  }
  return [...acc.values()]
    .map(({ ranks, ...a }) => ({
      ...a,
      appearances: ranks.length,
      averageRank: round2(ranks.reduce((s, r) => s + r, 0) / ranks.length),
      bestRank: Math.min(...ranks),
    }))
    .sort(
      (a, b) =>
        Number(b.isTarget) - Number(a.isTarget) ||
        b.appearances - a.appearances ||
        a.averageRank - b.averageRank ||
        a.business.localeCompare(b.business),
    );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
