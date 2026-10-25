/** Plain arithmetic over review rows. No AI. No review text and no reviewer names ever enter this module. */
export const ANALYTICS_CONFIG = {
  /** Most rows read per window. Our choice: far above one agency scope; past it the result says truncated. */
  maxRows: 50_000,
  /** Longest range a caller may ask for. Our choice. */
  maxDays: 800,
} as const;

export type AnalyticsRow = {
  locationId: string;
  createTime: Date;
  /** 1 to 5, null when Google sent no stars. */
  rating: number | null;
  /** Google shows a reply to customers (a REJECTED reply does not count). */
  replied: boolean;
  /** Hours from the review to the reply's update time; null when not replied or unknown. */
  replyHours: number | null;
};

export type Totals = {
  count: number;
  rated: number;
  avgRating: number | null;
  replied: number;
  /** 0 to 1, null when there are no reviews. */
  replyRate: number | null;
  medianReplyHours: number | null;
  needsReply: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function totalsOf(rows: AnalyticsRow[]): Totals {
  const ratings = rows.flatMap((r) => (r.rating === null ? [] : [r.rating]));
  const replied = rows.filter((r) => r.replied).length;
  const med = median(rows.flatMap((r) => (r.replied && r.replyHours !== null ? [r.replyHours] : [])));
  return {
    count: rows.length,
    rated: ratings.length,
    avgRating: ratings.length ? round1(mean(ratings)) : null,
    replied,
    replyRate: rows.length ? replied / rows.length : null,
    medianReplyHours: med === null ? null : round1(med),
    needsReply: rows.length - replied,
  };
}

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** Calendar months (UTC, "YYYY-MM") that [from, to) touches, oldest first. */
export function monthsBetween(from: Date, to: Date): string[] {
  const last = monthKey(new Date(to.getTime() - 1));
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  for (;;) {
    const k = `${y}-${String(m + 1).padStart(2, "0")}`;
    out.push(k);
    if (k >= last) return out;
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
}

export type MonthRow = { month: string; total: number; low: number; avg: number | null };

export function monthlyOf(rows: AnalyticsRow[], months: string[]): MonthRow[] {
  return months.map((month) => {
    const inMonth = rows.filter((r) => monthKey(r.createTime) === month);
    const rated = inMonth.flatMap((r) => (r.rating === null ? [] : [r.rating]));
    return {
      month,
      total: inMonth.length,
      low: rated.filter((x) => x <= 3).length,
      avg: rated.length ? round1(mean(rated)) : null,
    };
  });
}

export const starCounts = (rows: AnalyticsRow[]) =>
  [5, 4, 3, 2, 1].map((star) => ({ star, count: rows.filter((r) => r.rating === star).length }));

export type Trend = "up" | "down" | "flat" | "none";

/** Least-squares slope of the monthly averages that exist (nulls skipped). Under 0.02 stars a month is flat. */
export function trendOf(monthly: (number | null)[]): Trend {
  const pts = monthly.flatMap((v, i) => (v === null ? [] : [[i, v] as const]));
  if (pts.length < 2) return "none";
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const slope = num / den;
  return slope > 0.02 ? "up" : slope < -0.02 ? "down" : "flat";
}

export type LocationRow = Totals & {
  locationId: string;
  name: string;
  trend: Trend;
  /** Average rating per month of the window, null for a month without ratings (sparkline). */
  monthly: (number | null)[];
};

export function byLocation(rows: AnalyticsRow[], names: Map<string, string>, months: string[]): LocationRow[] {
  return [...new Set(rows.map((r) => r.locationId))]
    .map((locationId) => {
      const mine = rows.filter((r) => r.locationId === locationId);
      const monthly = monthlyOf(mine, months).map((m) => m.avg);
      return { locationId, name: names.get(locationId) ?? "Unknown", ...totalsOf(mine), trend: trendOf(monthly), monthly };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function computeAnalytics(i: {
  rows: AnalyticsRow[];
  previousRows: AnalyticsRow[];
  names: Map<string, string>;
  from: Date;
  to: Date;
}) {
  const months = monthsBetween(i.from, i.to);
  const len = i.to.getTime() - i.from.getTime();
  return {
    period: {
      from: i.from.toISOString(),
      to: i.to.toISOString(),
      previousFrom: new Date(i.from.getTime() - len).toISOString(),
      previousTo: i.from.toISOString(),
    },
    current: totalsOf(i.rows),
    previous: totalsOf(i.previousRows),
    months: monthlyOf(i.rows, months),
    stars: starCounts(i.rows),
    locations: byLocation(i.rows, i.names, months),
  };
}
