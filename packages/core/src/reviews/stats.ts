import { and, gte, inArray, lt, sql } from "drizzle-orm";
import { reviews } from "@opengmb/db";
import { addDays, addMonths, monthOf, monthStart, monthsBetween, previousRange, type DayRange } from "../performance/dates";
import type { Reader } from "../performance/queries";
import { noVisibleReply } from "./reply-stage";

/**
 * Review aggregates for the Review report (and plan 1C's Analytics). Counts, ratings, reply rate and
 * time to reply only. This module selects star_rating, create_time, reply_update_time and location_id,
 * plus booleans computed in SQL: it never selects a review's text, a reviewer's name or a reply's text
 * (reviewReport.test.ts fails if it ever names a text column).
 */
export type LocationStats = {
  locationId: string;
  label: string;
  newReviews: number;
  averageRating: number | null;
  replyRate: number | null;
  medianHoursToReply: number | null;
};
export type ReviewStats = {
  newReviews: number;
  previousNewReviews: number;
  averageRating: number | null;
  previousAverageRating: number | null;
  /** Share of the period's reviews that have a visible reply today (0 to 1). */
  replyRate: number | null;
  previousReplyRate: number | null;
  /** Median of reply_update_time minus create_time over visible replies. reply_update_time moves when a reply is edited, so this is to the latest version. */
  medianHoursToReply: number | null;
  /** Reviews with 1, 2, 3, 4 and 5 stars. */
  starMix: [number, number, number, number, number];
  /** The six calendar months ending in the period's last month, zero-filled. */
  trend: { month: string; count: number; averageRating: number | null }[];
  byLocation: LocationStats[];
};

const start = (day: string) => new Date(`${day}T00:00:00Z`);
const inRange = (ids: string[], r: DayRange) =>
  and(
    inArray(reviews.locationId, ids),
    gte(reviews.createTime, start(r.from)),
    lt(reviews.createTime, start(addDays(r.to, 1))),
  );

const replied = sql`not ${noVisibleReply}`;
const hours = sql`extract(epoch from (${reviews.replyUpdateTime} - ${reviews.createTime})) / 3600.0`;
const median = sql<number | null>`(percentile_cont(0.5) within group (order by ${hours}) filter (where ${replied} and ${reviews.replyUpdateTime} >= ${reviews.createTime}))::float8`;
const star = (n: number) => sql<number>`(count(*) filter (where ${reviews.starRating} = ${n}))::int`;

async function perLocation(q: Reader, ids: string[], r: DayRange) {
  if (ids.length === 0) return [];
  return q
    .select({
      locationId: reviews.locationId,
      n: sql<number>`count(*)::int`,
      rated: sql<number>`count(${reviews.starRating})::int`,
      avg: sql<number | null>`avg(${reviews.starRating})::float8`,
      replied: sql<number>`(count(*) filter (where ${replied}))::int`,
      median,
      s1: star(1),
      s2: star(2),
      s3: star(3),
      s4: star(4),
      s5: star(5),
    })
    .from(reviews)
    .where(inRange(ids, r))
    .groupBy(reviews.locationId);
}
type Row = Awaited<ReturnType<typeof perLocation>>[number];

async function overallMedian(q: Reader, ids: string[], r: DayRange): Promise<number | null> {
  if (ids.length === 0) return null;
  const [row] = await q.select({ median }).from(reviews).where(inRange(ids, r));
  return row?.median ?? null;
}

const totalOf = (rows: Row[]) => {
  const n = rows.reduce((a, x) => a + x.n, 0);
  const rated = rows.reduce((a, x) => a + x.rated, 0);
  const stars = rows.reduce((a, x) => a + (x.avg ?? 0) * x.rated, 0);
  const done = rows.reduce((a, x) => a + x.replied, 0);
  return {
    n,
    avg: rated > 0 ? stars / rated : null,
    rate: n > 0 ? done / n : null,
  };
};

export async function reviewStats(
  q: Reader,
  p: { locations: { id: string; label: string }[]; range: DayRange },
): Promise<ReviewStats> {
  const ids = p.locations.map((l) => l.id);
  const prev = previousRange(p.range);
  const [cur, before, med] = await Promise.all([
    perLocation(q, ids, p.range),
    perLocation(q, ids, prev),
    overallMedian(q, ids, p.range),
  ]);
  const now = totalOf(cur);
  const then = totalOf(before);

  const lastMonth = monthOf(p.range.to);
  const months = monthsBetween(addMonths(lastMonth, -5), lastMonth);
  const month = sql<string>`to_char(${reviews.createTime} at time zone 'UTC', 'YYYY-MM')`;
  const trendRows = ids.length
    ? await q
        .select({
          month,
          count: sql<number>`count(*)::int`,
          avg: sql<number | null>`avg(${reviews.starRating})::float8`,
        })
        .from(reviews)
        .where(
          and(
            inArray(reviews.locationId, ids),
            gte(reviews.createTime, start(monthStart(months[0]!))),
            lt(reviews.createTime, start(addDays(p.range.to, 1))),
          ),
        )
        .groupBy(month)
    : [];
  const byMonth = new Map(trendRows.map((t) => [t.month, t]));

  const byLoc = new Map(cur.map((x) => [x.locationId, x]));
  return {
    newReviews: now.n,
    previousNewReviews: then.n,
    averageRating: now.avg,
    previousAverageRating: then.avg,
    replyRate: now.rate,
    previousReplyRate: then.rate,
    medianHoursToReply: med,
    starMix: [
      cur.reduce((a, x) => a + x.s1, 0),
      cur.reduce((a, x) => a + x.s2, 0),
      cur.reduce((a, x) => a + x.s3, 0),
      cur.reduce((a, x) => a + x.s4, 0),
      cur.reduce((a, x) => a + x.s5, 0),
    ],
    trend: months.map((m) => ({
      month: m,
      count: byMonth.get(m)?.count ?? 0,
      averageRating: byMonth.get(m)?.avg ?? null,
    })),
    byLocation: [...p.locations]
      .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1))
      .map((l) => {
        const x = byLoc.get(l.id);
        return {
          locationId: l.id,
          label: l.label,
          newReviews: x?.n ?? 0,
          averageRating: x?.avg ?? null,
          replyRate: x && x.n > 0 ? x.replied / x.n : null,
          medianHoursToReply: x?.median ?? null,
        };
      }),
  };
}

// ---- formatting (numbers and symbols only; the PDF maps "n/a" to its language) ----

const round1 = (n: number) => Math.round(n * 10) / 10;
export function formatHours(h: number | null, lang: "en" | "es"): string {
  if (h === null) return lang === "es" ? "n/d" : "n/a";
  if (h < 1) return lang === "es" ? "menos de 1 h" : "under 1 h";
  if (h < 48) return `${round1(h)} h`;
  const d = round1(h / 24);
  return lang === "es" ? `${d} días` : `${d} days`;
}
export const percent = (rate: number | null): string => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);
const signed = (n: number, text: string) => (n > 0 ? `+${text}` : text);
export function changeCount(cur: number, prev: number): string {
  if (prev === 0) return "n/a";
  const pct = ((cur - prev) / prev) * 100;
  return signed(pct, `${pct.toFixed(1)}%`);
}
export function changeRating(cur: number | null, prev: number | null): string {
  if (cur === null || prev === null) return "n/a";
  const d = Math.round((cur - prev) * 10) / 10;
  return signed(d, d.toFixed(1));
}
export function changePoints(cur: number | null, prev: number | null): string {
  if (cur === null || prev === null) return "n/a";
  const d = Math.round((cur - prev) * 100);
  return signed(d, `${d} pts`);
}
