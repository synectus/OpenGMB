import { and, asc, between, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  locationDataAccess,
  locations,
  performanceDaily,
  reviews,
  searchKeywordsMonthly,
  workspaces,
  type Db,
} from "@opengmb/db";
import { AccessError, workspaceScope, type Actor } from "../actor";
import { CoreError } from "../errors";
import { postCount } from "../posts/scope";
import { needsYouSql } from "../reviews/reply-stage";
import type { DailyMetric } from "../google/client";
import { DAILY_METRICS } from "../google/client";
import { addDays, daysBetween, eachDay, monthStart, previousRange, type DayRange } from "./dates";

/** Anything with `select` (a Db or a Tx). */
export type Reader = Pick<Db, "select">;

/** Longest dashboard / report range in days (Google keeps ~18 months; we keep more, so allow 2 years). */
export const MAX_RANGE_DAYS = 731;

export const KPI_DEFS = [
  {
    key: "impressionsTotal",
    label: "Profile impressions",
    metrics: [
      "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
      "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
      "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
      "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    ],
  },
  {
    key: "impressionsMaps",
    label: "Impressions on Google Maps",
    metrics: ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS"],
  },
  {
    key: "impressionsSearch",
    label: "Impressions on Google Search",
    metrics: ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"],
  },
  { key: "calls", label: "Calls", metrics: ["CALL_CLICKS"] },
  { key: "websiteClicks", label: "Website clicks", metrics: ["WEBSITE_CLICKS"] },
  { key: "directions", label: "Direction requests", metrics: ["BUSINESS_DIRECTION_REQUESTS"] },
] as const satisfies readonly { key: string; label: string; metrics: readonly DailyMetric[] }[];
export type KpiKey = (typeof KPI_DEFS)[number]["key"];

export type Delta = {
  total: number;
  previousTotal: number;
  delta: number;
  deltaPct: number | null;
};

/** Period-over-period change. `deltaPct` is null when the previous period was zero. */
export function deltaOf(total: number, previousTotal: number): Delta {
  return {
    total,
    previousTotal,
    delta: total - previousTotal,
    deltaPct: previousTotal === 0 ? null : (total - previousTotal) / previousTotal,
  };
}

export type PerformanceSummary = {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  locationCount: number;
  /** false when no snapshot row exists for the range (nothing captured yet). */
  hasData: boolean;
  kpis: ({ key: KpiKey; label: string } & Delta)[];
  metrics: ({ metric: DailyMetric } & Delta)[];
  series: { key: KpiKey; label: string; points: { date: string; value: number }[] }[];
};

/** Validates a day range. Throws INVALID_INPUT. */
export function checkRange(r: DayRange): void {
  if (r.to < r.from) throw new CoreError("INVALID_INPUT", "from must not be after to");
  if (daysBetween(r.from, r.to) > MAX_RANGE_DAYS) {
    throw new CoreError("INVALID_INPUT", `Range is longer than ${MAX_RANGE_DAYS} days`);
  }
}

/**
 * Locations a caller asked for: all of a workspace (any status: history is kept after a location
 * is deactivated), or an explicit list. Everything is checked against the actor's org and workspace
 * scope; anything outside it is NOT_FOUND, so ids cannot be probed.
 */
export async function resolveLocationIds(
  q: Reader,
  actor: Actor,
  input: { workspaceId?: string; locationIds?: string[] },
): Promise<{ locationIds: string[]; workspaceIds: string[] }> {
  const scope = workspaceScope(actor);
  const inScope = scope === "all" ? undefined : inArray(locations.workspaceId, scope);
  if (input.workspaceId) {
    const [w] = await q
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!w || (scope !== "all" && !scope.includes(w.id))) {
      throw new AccessError("NOT_FOUND", "Workspace not found");
    }
    const rows = await q
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.orgId, actor.orgId), eq(locations.workspaceId, w.id)));
    return { locationIds: rows.map((r) => r.id), workspaceIds: [w.id] };
  }
  const ids = [...new Set(input.locationIds ?? [])];
  if (ids.length === 0) {
    throw new CoreError("INVALID_INPUT", "Give a workspaceId or at least one locationId");
  }
  const rows = await q
    .select({ id: locations.id, workspaceId: locations.workspaceId })
    .from(locations)
    .where(and(eq(locations.orgId, actor.orgId), inArray(locations.id, ids), inScope));
  if (rows.length !== ids.length) throw new AccessError("NOT_FOUND", "Location not found");
  return {
    locationIds: rows.map((r) => r.id),
    workspaceIds: [...new Set(rows.map((r) => r.workspaceId))],
  };
}

/** Sum of each metric per day, over `locationIds`, for the days in `range`. */
async function dailyTotals(q: Reader, locationIds: string[], range: DayRange) {
  if (locationIds.length === 0) return [];
  return q
    .select({
      date: performanceDaily.date,
      metric: performanceDaily.metric,
      total: sql<number>`sum(${performanceDaily.value})::int`,
    })
    .from(performanceDaily)
    .where(
      and(
        inArray(performanceDaily.locationId, locationIds),
        between(performanceDaily.date, range.from, range.to),
      ),
    )
    .groupBy(performanceDaily.date, performanceDaily.metric);
}

/**
 * Totals per metric and KPI for `range` against the equal-length range just before it, plus a
 * zero-filled daily series per KPI. Days Google omitted (zero) count as 0.
 */
export async function summarize(
  q: Reader,
  p: { locationIds: string[]; range: DayRange },
): Promise<PerformanceSummary> {
  checkRange(p.range);
  const prev = previousRange(p.range);
  const rows = await dailyTotals(q, p.locationIds, { from: prev.from, to: p.range.to });
  const byMetric = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byMetric.get(r.metric) ?? new Map<string, number>();
    m.set(r.date, r.total);
    byMetric.set(r.metric, m);
  }
  const days = eachDay(p.range.from, p.range.to);
  const prevDays = eachDay(prev.from, prev.to);
  const sumOver = (metrics: readonly string[], over: string[]) =>
    over.reduce((n, d) => n + metrics.reduce((k, m) => k + (byMetric.get(m)?.get(d) ?? 0), 0), 0);

  return {
    from: p.range.from,
    to: p.range.to,
    previousFrom: prev.from,
    previousTo: prev.to,
    locationCount: p.locationIds.length,
    hasData: rows.some((r) => r.date >= p.range.from),
    kpis: KPI_DEFS.map((k) => ({
      key: k.key,
      label: k.label,
      ...deltaOf(sumOver(k.metrics, days), sumOver(k.metrics, prevDays)),
    })),
    metrics: DAILY_METRICS.map((metric) => ({
      metric,
      ...deltaOf(sumOver([metric], days), sumOver([metric], prevDays)),
    })),
    series: KPI_DEFS.map((k) => ({
      key: k.key,
      label: k.label,
      points: days.map((date) => ({ date, value: sumOver(k.metrics, [date]) })),
    })),
  };
}

export type KeywordRow = {
  keyword: string;
  /** Sum of the exact monthly counts we know. */
  value: number;
  /** true when at least one month was hidden by Google (below its threshold): `value` is a floor. */
  isLowerBound: boolean;
  /** Sum of the thresholds of hidden months: those months each had fewer unique users than this. */
  hiddenBelow: number;
};

/**
 * Top keywords over the given months (`YYYY-MM`) and locations. Google reports small counts only as
 * "below threshold"; those never add to `value`, so a keyword with hidden months is marked as a
 * lower bound and sorts by what is known.
 */
export async function topKeywords(
  q: Reader,
  p: { locationIds: string[]; months: string[]; limit: number },
): Promise<KeywordRow[]> {
  if (p.locationIds.length === 0 || p.months.length === 0) return [];
  const rows = await q
    .select({
      keyword: searchKeywordsMonthly.keyword,
      value: sql<number>`coalesce(sum(${searchKeywordsMonthly.value}), 0)::int`,
      hidden: sql<number>`count(*) filter (where ${searchKeywordsMonthly.value} is null)::int`,
      hiddenBelow: sql<number>`coalesce(sum(${searchKeywordsMonthly.threshold}), 0)::int`,
    })
    .from(searchKeywordsMonthly)
    .where(
      and(
        inArray(searchKeywordsMonthly.locationId, p.locationIds),
        inArray(
          searchKeywordsMonthly.month,
          p.months.map((m) => monthStart(m)),
        ),
      ),
    )
    .groupBy(searchKeywordsMonthly.keyword)
    .orderBy(
      sql`coalesce(sum(${searchKeywordsMonthly.value}), 0) desc`,
      searchKeywordsMonthly.keyword,
    )
    .limit(p.limit);
  return rows.map((r) => ({
    keyword: r.keyword,
    value: r.value,
    isLowerBound: r.hidden > 0,
    hiddenBelow: r.hiddenBelow,
  }));
}

/** The metrics a person acts on; "vs before" on /performance sums these. */
export const ACTION_METRICS = ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS"] as const;

export type LocationPerformance = {
  locationId: string;
  title: string;
  status: "active" | "inactive";
  /** Google was disconnected: the location must be re-imported (same rule as locations.list). */
  needsRelink: boolean;
  /** Newest day stored for the location, any metric; null when nothing was ever captured. */
  lastDataDate: string | null;
  /** OPS2: Google refuses to share performance data for this location with the connected account. */
  googleAccessDenied: boolean;
  calls: Delta;
  websiteClicks: Delta;
  directions: Delta;
  /** calls + websiteClicks + directions. */
  actions: Delta;
};

/** Per-location totals of the action metrics for `range` and the equal-length range before it. */
export async function byLocation(
  q: Reader,
  p: { locationIds: string[]; range: DayRange },
): Promise<LocationPerformance[]> {
  checkRange(p.range);
  if (p.locationIds.length === 0) return [];
  const prev = previousRange(p.range);
  const locs = await q
    .select({
      id: locations.id,
      title: locations.title,
      name: locations.name,
      status: locations.status,
      connectionId: locations.connectionId,
      googleLocationId: locations.googleLocationId,
    })
    .from(locations)
    .where(inArray(locations.id, p.locationIds))
    .orderBy(asc(locations.title), asc(locations.id));
  const sums = await q
    .select({
      locationId: performanceDaily.locationId,
      metric: performanceDaily.metric,
      cur: sql<number>`coalesce(sum(${performanceDaily.value}) filter (where ${performanceDaily.date} >= ${p.range.from}::date), 0)::int`,
      prev: sql<number>`coalesce(sum(${performanceDaily.value}) filter (where ${performanceDaily.date} <= ${prev.to}::date), 0)::int`,
    })
    .from(performanceDaily)
    .where(
      and(
        inArray(performanceDaily.locationId, p.locationIds),
        inArray(performanceDaily.metric, [...ACTION_METRICS]),
        between(performanceDaily.date, prev.from, p.range.to),
      ),
    )
    .groupBy(performanceDaily.locationId, performanceDaily.metric);
  const last = await q
    .select({
      locationId: performanceDaily.locationId,
      last: sql<string>`max(${performanceDaily.date})::text`,
    })
    .from(performanceDaily)
    .where(inArray(performanceDaily.locationId, p.locationIds))
    .groupBy(performanceDaily.locationId);
  const lastBy = new Map(last.map((r) => [r.locationId, r.last]));
  const denied = new Set(
    (
      await q
        .select({ id: locationDataAccess.locationId })
        .from(locationDataAccess)
        .where(and(inArray(locationDataAccess.locationId, p.locationIds), eq(locationDataAccess.resource, "performance")))
    ).map((r) => r.id),
  );
  const get = (id: string, metric: string) =>
    sums.find((s) => s.locationId === id && s.metric === metric) ?? { cur: 0, prev: 0 };
  return locs.map((l) => {
    const [c, w, d] = ACTION_METRICS.map((m) => get(l.id, m));
    return {
      locationId: l.id,
      title: l.title ?? l.name,
      status: l.status,
      needsRelink: l.connectionId === null && l.googleLocationId !== null,
      lastDataDate: lastBy.get(l.id) ?? null,
      googleAccessDenied: denied.has(l.id),
      calls: deltaOf(c!.cur, c!.prev),
      websiteClicks: deltaOf(w!.cur, w!.prev),
      directions: deltaOf(d!.cur, d!.prev),
      actions: deltaOf(c!.cur + w!.cur + d!.cur, c!.prev + w!.prev + d!.prev),
    };
  });
}

export type Activity = {
  newReviews: number;
  /** Mean star rating of the new reviews, one decimal; null when none has a rating. */
  averageRating: number | null;
  /** New reviews in the range that still have no reply. */
  unreplied: number;
  /** Distinct posts published in the range at a location in scope, SynGMB-made and Google-only (posts/scope.ts). */
  postsPublished: number;
};

/** Reviews and posts in `range` (UTC days, `to` inclusive). Counts only: no review text is read. */
export async function activity(
  q: Reader,
  p: { locationIds: string[]; range: DayRange },
): Promise<Activity> {
  checkRange(p.range);
  if (p.locationIds.length === 0) {
    return { newReviews: 0, averageRating: null, unreplied: 0, postsPublished: 0 };
  }
  const start = new Date(`${p.range.from}T00:00:00Z`);
  const end = new Date(`${addDays(p.range.to, 1)}T00:00:00Z`);
  const [r] = await q
    .select({
      n: sql<number>`count(*)::int`,
      avg: sql<string | null>`round(avg(${reviews.starRating})::numeric, 1)::text`,
      unreplied: sql<number>`count(*) filter (where ${needsYouSql})::int`,
    })
    .from(reviews)
    .where(
      and(
        inArray(reviews.locationId, p.locationIds),
        gte(reviews.createTime, start),
        lt(reviews.createTime, end),
      ),
    );
  const postsPublished = await postCount(q, { locationIds: p.locationIds, start, end });
  return {
    newReviews: r?.n ?? 0,
    averageRating: r?.avg == null ? null : Number(r.avg),
    unreplied: r?.unreplied ?? 0,
    postsPublished,
  };
}
