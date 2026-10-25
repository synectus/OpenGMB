import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, googleRateWindows, locations, reviewSyncs } from "@opengmb/db";
import { REVIEWS_CONFIG } from "./config/reviews";
import { GOOGLE_LIMITS } from "./config/google-limits";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { currentProjectBucket } from "./google/throttler";
import { REVIEW_SYNC_QUEUE, enqueueScheduledReviewSyncs, processReviewSync } from "./reviews/sync";
import { makeKit } from "./testkit";

// H4: the worker's scheduled review sync for 1,000 locations, with a fake clock and counted mock Google.
// 1,000 locations take a few seconds of database work, none of it waiting.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);

const LOCATIONS = 1000;
const WINDOW = GOOGLE_LIMITS.projectQpm.windowMs;
const QPM = GOOGLE_LIMITS.projectQpm.limit;
// Window-aligned and far from now; this file counts in its own bucket (vitest.setup.ts), so only it writes here.
const T0 = Math.floor(Date.UTC(2033, 0, 1) / WINDOW) * WINDOW;
const T_END = T0 + 24 * 60 * 60 * 1000;

afterAll(async () => {
  await db.delete(googleRateWindows).where(and(eq(googleRateWindows.bucketKey, currentProjectBucket()), gte(googleRateWindows.windowStart, new Date(T0)), lt(googleRateWindows.windowStart, new Date(T_END))));
  await kit.deactivateAll();
  await boss.stop();
  await sql.end();
});
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REVIEW_SYNC_QUEUE);
});

describe("worker throughput at 1,000 locations", () => {
  it("one scheduled review-sync cycle stays within 300 requests a minute and fits inside its 2-hour period", async () => {
    const org = await kit.makeOrg();
    const first = await org.mkLoc(org.a);
    const { connectionId } = first.row;
    const rows = await db
      .insert(locations)
      .values(
        Array.from({ length: LOCATIONS - 1 }, (_, i) => ({
          orgId: org.orgId,
          workspaceId: org.a,
          name: `Throughput ${i}`,
          googleAccountName: first.row.googleAccountName,
          googleLocationId: `locations/8${String(i).padStart(12, "0")}`,
          connectionId,
        })),
      )
      .returning({ id: locations.id });
    kit.created.push(...rows.map((r) => r.id)); // deactivateAll leaves none active for other suites

    const queued = await enqueueScheduledReviewSyncs(db, { orgIds: [org.orgId] });
    expect(queued).toMatchObject({ locations: LOCATIONS, queued: LOCATIONS });
    const syncs = await db.select({ id: reviewSyncs.id }).from(reviewSyncs).where(and(eq(reviewSyncs.orgId, org.orgId), eq(reviewSyncs.status, "pending")));
    expect(syncs).toHaveLength(LOCATIONS);

    const clock = {
      t: T0 + 5_000,
      sleeps: [] as number[],
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.sleeps.push(ms);
        clock.t += ms;
      },
      random: () => 0.5,
    };
    const client = new ThrottledGoogleClient(mock, db, clock);
    const before = mock.calls.length;
    for (const s of syncs) await processReviewSync(db, s.id, { client });
    const requests = mock.calls.length - before;

    const windows = await db
      .select()
      .from(googleRateWindows)
      .where(and(eq(googleRateWindows.bucketKey, currentProjectBucket()), gte(googleRateWindows.windowStart, new Date(T0)), lt(googleRateWindows.windowStart, new Date(T_END))));
    const perMinute = windows.map((w) => w.count);
    const elapsedMin = (clock.t - (T0 + 5_000)) / 60_000;
    const methods = [...new Set(mock.calls.slice(before).map((c) => c.method))].sort();
    console.log(
      `[H4] review sync, ${LOCATIONS} locations: ${requests} requests (${(requests / LOCATIONS).toFixed(1)} a location: ${methods.join(" + ")}), ` +
        `busiest minute ${Math.max(...perMinute)} of ${QPM}, ${windows.length} minutes used, cycle ${elapsedMin.toFixed(1)} min`,
    );

    // The denominator: every request the sync made went through the limiter and was counted.
    expect(requests).toBeGreaterThanOrEqual(LOCATIONS); // at least the reviews page per location
    expect(perMinute.reduce((a, b) => a + b, 0)).toBe(requests);
    expect(Math.max(...perMinute)).toBeLessThanOrEqual(QPM);
    // Canary: the limiter is what held the line (the mock answers instantly, so without it all of this lands in one minute).
    expect(clock.sleeps.length).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThanOrEqual(Math.ceil(requests / QPM));
    // The cycle (about requests / 300 minutes) finishes long before the next one starts.
    expect(REVIEWS_CONFIG.syncCron).toBe("15 */2 * * *");
    expect(clock.t - (T0 + 5_000)).toBeLessThan(2 * 60 * 60 * 1000);
    expect(await db.select({ id: reviewSyncs.id }).from(reviewSyncs).where(and(eq(reviewSyncs.orgId, org.orgId), inArray(reviewSyncs.status, ["pending"])))).toHaveLength(0);
  });
});
