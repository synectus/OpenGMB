import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  googleConnections,
  locations,
  performanceDaily,
  performanceSnapshots,
  searchKeywordsMonthly,
  type Db,
  type Tx,
} from "@opengmb/db";
import { writeAudit } from "../audit";
import { PERFORMANCE_CONFIG } from "../config/performance";
import {
  DAILY_METRICS,
  type DailyMetricSeries,
  type GoogleClient,
  type SearchKeywordCount,
} from "../google/client";
import { createGoogleClient } from "../google/factory";
import { enqueueJob } from "../jobs";
import { orgStagger } from "../google/rate-limit-retry";
import {
  clearGoogleAccessDenied,
  isGoogleAccessBlocked,
  isLocationAccessDenied,
  markGoogleAccessDenied,
} from "../locations/data-access";
import {
  addDays,
  lastCompleteMonth,
  monthOf,
  monthStart,
  monthsBetween,
  subtractMonths,
  yesterday,
  type DayRange,
} from "./dates";
import { orgIsActive } from "../account-state";

export const PERFORMANCE_SNAPSHOT_QUEUE = "performance.snapshot";
export const PERFORMANCE_SCHEDULE_QUEUE = "performance.schedule";
export const PERFORMANCE_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;

export type PerformanceSnapshotJob = { locationId: string; backfill?: boolean; rlAttempt?: number };
type Reader = Pick<GoogleClient, "fetchDailyMetrics" | "listMonthlySearchKeywords">;

const CHUNK = 1000;

/**
 * Days a snapshot fetches. A backfill (the first snapshot of a location, or a manual request) goes
 * back `retentionMonths`; a nightly run re-fetches the last `refreshDays` complete days.
 */
export function snapshotWindow(now: Date, backfill: boolean): DayRange {
  const to = yesterday(now);
  const from = backfill
    ? subtractMonths(to, PERFORMANCE_CONFIG.retentionMonths.value)
    : addDays(to, -(PERFORMANCE_CONFIG.refreshDays - 1));
  return { from, to };
}

/** Months whose keywords a snapshot fetches (complete months only: Google publishes after month end). */
export function snapshotMonths(now: Date, window: DayRange, backfill: boolean): string[] {
  const last = lastCompleteMonth(now);
  return backfill ? monthsBetween(monthOf(window.from), last) : [last];
}

/** Queue one snapshot job per active, Google-linked location. Run nightly by the schedule queue. */
/** `orgIds` restricts the fan-out to those orgs (tests only; production queues every org). */
export async function enqueueNightlySnapshots(
  db: Db,
  opts: { orgIds?: string[] } = {},
): Promise<{ enqueued: number }> {
  const rows = await db
    .select({ id: locations.id, orgId: locations.orgId })
    .from(locations)
    .where(
      and(
        eq(locations.status, "active"),
        isNotNull(locations.googleLocationId),
        isNotNull(locations.connectionId),
        opts.orgIds ? inArray(locations.orgId, opts.orgIds) : undefined,
        orgIsActive(locations.orgId),
      ),
    );
  const stagger = orgStagger();
  for (const r of rows) {
    const startAfterSeconds = stagger(r.orgId);
    await db.transaction((tx) => enqueueJob(tx, PERFORMANCE_SNAPSHOT_QUEUE, { locationId: r.id }, { startAfterSeconds }));
  }
  return { enqueued: rows.length };
}

async function fetchKeywords(client: Reader, googleLocation: string, month: string) {
  const out: SearchKeywordCount[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < PERFORMANCE_CONFIG.maxKeywordPages; page++) {
    const res = await client.listMonthlySearchKeywords(googleLocation, month, month, {
      pageSize: PERFORMANCE_CONFIG.keywordsPageSize.value,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...res.keywords);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

export async function upsertDaily(
  tx: Tx,
  p: { orgId: string; locationId: string; series: DailyMetricSeries[] },
): Promise<number> {
  const rows = p.series.flatMap((s) =>
    s.points.map((pt) => ({
      orgId: p.orgId,
      locationId: p.locationId,
      date: pt.date,
      metric: s.metric,
      value: pt.value,
    })),
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx
      .insert(performanceDaily)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [performanceDaily.locationId, performanceDaily.date, performanceDaily.metric],
        set: { value: sqlExcluded("value"), capturedAt: new Date() },
      });
  }
  return rows.length;
}

export async function upsertKeywords(
  tx: Tx,
  p: {
    orgId: string;
    locationId: string;
    byMonth: { month: string; keywords: SearchKeywordCount[] }[];
  },
): Promise<number> {
  const rows = p.byMonth.flatMap((m) =>
    // Google lowercases keywords; one row per keyword per month.
    [
      ...new Map(
        m.keywords
          .filter((k) => k.value !== undefined || k.threshold !== undefined)
          .map((k) => [k.keyword, k]),
      ).values(),
    ].map((k) => ({
      orgId: p.orgId,
      locationId: p.locationId,
      month: monthStart(m.month),
      keyword: k.keyword,
      value: k.value ?? null,
      threshold: k.value === undefined ? (k.threshold ?? null) : null,
    })),
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx
      .insert(searchKeywordsMonthly)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [
          searchKeywordsMonthly.locationId,
          searchKeywordsMonthly.month,
          searchKeywordsMonthly.keyword,
        ],
        set: {
          value: sqlExcluded("value"),
          threshold: sqlExcluded("threshold"),
          capturedAt: new Date(),
        },
      });
  }
  return rows.length;
}

const sqlExcluded = (col: string) => sql.raw(`excluded."${col}"`);

export type SnapshotResult =
  | {
      status: "done";
      backfill: boolean;
      from: string;
      to: string;
      dailyRows: number;
      keywordRows: number;
    }
  | { status: "skipped"; reason: string };

/**
 * Worker side of `performance.snapshot`. Phase 1 reads the location and fetches from Google with no
 * transaction open. Phase 2 is one short transaction: re-check the location is still active, upsert
 * (idempotent, keyed by location/date/metric and location/month/keyword), advance the snapshot row
 * and audit counts only. Rows are never deleted. A location with no snapshot row, or a job with
 * `backfill: true`, fetches the full retention window. Google errors throw so pg-boss retries.
 */
export async function processPerformanceSnapshot(
  db: Db,
  job: PerformanceSnapshotJob,
  deps: { client?: Reader; now?: Date } = {},
): Promise<SnapshotResult> {
  const now = deps.now ?? new Date();
  const [loc] = await db.select().from(locations).where(eq(locations.id, job.locationId));
  if (!loc) return { status: "skipped", reason: "not_found" };
  if (loc.status !== "active") return { status: "skipped", reason: "location_inactive" };
  if (!loc.googleLocationId) return { status: "skipped", reason: "location_not_linked_to_google" };

  // OPS2: Google refused this location's performance data recently: skip until the recheck window
  // passes. A manual backfill (a person asked) always tries again.
  if (!job.backfill && (await isGoogleAccessBlocked(db, loc.id, "performance", now))) {
    return { status: "skipped", reason: "google_access_denied" };
  }

  let client = deps.client;
  if (!client) {
    const [conn] = loc.connectionId
      ? await db
          .select()
          .from(googleConnections)
          .where(
            and(eq(googleConnections.id, loc.connectionId), eq(googleConnections.orgId, loc.orgId)),
          )
      : [];
    if (!conn) return { status: "skipped", reason: "connection_removed" };
    client = createGoogleClient({ db, connection: conn });
  }

  const [existing] = await db
    .select({ id: performanceSnapshots.locationId })
    .from(performanceSnapshots)
    .where(eq(performanceSnapshots.locationId, loc.id));
  const backfill = job.backfill === true || !existing;
  const window = snapshotWindow(now, backfill);
  const months = snapshotMonths(now, window, backfill);

  // Phase 1: Google, no transaction.
  let daily: Awaited<ReturnType<Reader["fetchDailyMetrics"]>>;
  const byMonth: { month: string; keywords: SearchKeywordCount[] }[] = [];
  try {
    daily = await client.fetchDailyMetrics(loc.googleLocationId, DAILY_METRICS, window.from, window.to);
    for (const month of months) {
      byMonth.push({ month, keywords: await fetchKeywords(client, loc.googleLocationId, month) });
    }
  } catch (e) {
    // A plain 403 means Google does not share this location's data with the connected account:
    // remember it and finish quietly (a thrown error would alert every night).
    if (isLocationAccessDenied(e)) {
      await markGoogleAccessDenied(db, loc, "performance", now);
      return { status: "skipped", reason: "google_access_denied" };
    }
    throw e;
  }
  await clearGoogleAccessDenied(db, loc.id, "performance");

  // Phase 2: one short transaction.
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .select({ status: locations.status })
      .from(locations)
      .where(eq(locations.id, loc.id));
    if (fresh?.status !== "active") return { status: "skipped", reason: "location_inactive" };
    const dailyRows = await upsertDaily(tx, {
      orgId: loc.orgId,
      locationId: loc.id,
      series: daily.series,
    });
    const keywordRows = await upsertKeywords(tx, {
      orgId: loc.orgId,
      locationId: loc.id,
      byMonth,
    });
    await tx
      .insert(performanceSnapshots)
      .values({
        locationId: loc.id,
        orgId: loc.orgId,
        backfilledAt: now,
        lastSnapshotDate: window.to,
      })
      .onConflictDoUpdate({
        target: performanceSnapshots.locationId,
        set: {
          lastSnapshotDate: window.to,
          updatedAt: now,
          ...(backfill ? { backfilledAt: now } : {}),
        },
      });
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "performance.snapshot_completed",
      entityType: "location",
      entityId: loc.id,
      after: { backfill, from: window.from, to: window.to, dailyRows, keywordRows },
    });
    return { status: "done", backfill, from: window.from, to: window.to, dailyRows, keywordRows };
  });
}
