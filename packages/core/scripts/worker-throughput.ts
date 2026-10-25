// What the worker's scheduled jobs ask Google for, for every location in a seeded database, with a fake
// clock and the mock Google (no network, no waiting). Run from the repo root, on a database that
// apps/web/scripts/scale/seed.ts filled (name must be syngmb_test_* or syngmb_scale_*):
//   ./apps/web/node_modules/.bin/tsx packages/core/scripts/worker-throughput.ts --db syngmb_scale_x
// For each job it prints: requests, requests per location, the busiest minute against the 300 a minute
// quota, and how long the cycle takes at the quota (the fake clock sleeps whenever the limiter says wait).
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { and, eq, gte, isNotNull, lt } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, googleRateWindows, locations, reviewSyncs } from "@opengmb/db";
import { GOOGLE_LIMITS } from "../src/config/google-limits";
import { REVIEWS_CONFIG } from "../src/config/reviews";
import { PROFILE_WATCH_CONFIG } from "../src/config/profile-watch";
import { PERFORMANCE_CONFIG } from "../src/config/performance";
import { ThrottledGoogleClient } from "../src/google/throttled-client";
import { MockGoogleClient } from "../src/google/mock-client";
import { currentProjectBucket } from "../src/google/throttler";
import { REVIEW_SYNC_QUEUE, enqueueScheduledReviewSyncs, processReviewSync } from "../src/reviews/sync";
import { PROFILE_SNAPSHOT_QUEUE, enqueueNightlyProfileSnapshots, processProfileSnapshot } from "../src/profile/watch";
import { CUSTOMER_MEDIA_SCAN_QUEUE, enqueueCustomerMediaScans, processCustomerMediaScan } from "../src/media/customer";
import { PERFORMANCE_SNAPSHOT_QUEUE, enqueueNightlySnapshots, processPerformanceSnapshot } from "../src/performance/snapshot";
import { dbUrlFor, findEnvFile } from "../../../scripts/gate-lib.mjs";

const i = process.argv.indexOf("--db");
const dbName = i < 0 ? undefined : process.argv[i + 1];
if (!dbName || !/^syngmb_(test|scale)_/.test(dbName)) throw new Error("pass --db syngmb_test_* or syngmb_scale_*");
const envFile = findEnvFile(process.cwd());
const base = process.env.DATABASE_URL_TEST ?? (envFile ? parseEnv(readFileSync(envFile, "utf8")).DATABASE_URL_TEST : undefined);
if (!base) throw new Error("DATABASE_URL_TEST is not set");
process.env.GOOGLE_BUSINESS_API_MODE = "mock";
const url = dbUrlFor(base, dbName);
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
await boss.start();
for (const q of [REVIEW_SYNC_QUEUE, PROFILE_SNAPSHOT_QUEUE, CUSTOMER_MEDIA_SCAN_QUEUE, PERFORMANCE_SNAPSHOT_QUEUE]) await boss.createQueue(q);

const WINDOW = GOOGLE_LIMITS.projectQpm.windowMs;
const QPM = GOOGLE_LIMITS.projectQpm.limit;
const linked = await db
  .select({ id: locations.id, google: locations.googleLocationId })
  .from(locations)
  .where(and(eq(locations.status, "active"), isNotNull(locations.googleLocationId), isNotNull(locations.connectionId)));
const mock = new MockGoogleClient();
for (const l of linked) mock.addLocation({ name: l.google!, title: l.id });

let day = Math.floor(Date.UTC(2034, 0, 1) / WINDOW) * WINDOW;
async function cycle(label: string, run: (client: ThrottledGoogleClient) => Promise<void>) {
  const start = day + 5_000;
  const clock = { t: start, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms), random: () => 0.5 };
  const before = mock.calls.length;
  await run(new ThrottledGoogleClient(mock, db, clock));
  const requests = mock.calls.length - before;
  const windows = await db
    .select()
    .from(googleRateWindows)
    .where(and(eq(googleRateWindows.bucketKey, currentProjectBucket()), gte(googleRateWindows.windowStart, new Date(day)), lt(googleRateWindows.windowStart, new Date(day + 24 * 3_600_000))));
  const peak = Math.max(0, ...windows.map((w) => w.count));
  console.log(`| ${label} | ${requests} | ${(requests / linked.length).toFixed(1)} | ${peak} of ${QPM} | ${((clock.t - start) / 60_000).toFixed(1)} min |`);
  day += 24 * 3_600_000; // the next cycle counts in fresh windows
}

console.log(`${linked.length} active linked locations; quota ${QPM} requests per ${WINDOW / 1000} s (one bucket for every API).`);
console.log(`Schedules: review sync ${REVIEWS_CONFIG.syncCron}; performance ${PERFORMANCE_CONFIG.snapshotCron}; profile snapshot ${PROFILE_WATCH_CONFIG.snapshotCron}; customer media ${PROFILE_WATCH_CONFIG.customerMediaCron} (UTC)\n`);
console.log("| Job (one fan-out over every location) | Requests | Per location | Busiest minute | Cycle at the quota |\n|---|---|---|---|---|");

await cycle("review sync", async (client) => {
  await enqueueScheduledReviewSyncs(db);
  const syncs = await db.select({ id: reviewSyncs.id }).from(reviewSyncs).where(eq(reviewSyncs.status, "pending"));
  for (const s of syncs) await processReviewSync(db, s.id, { client });
});
await cycle("performance snapshot, first run (backfill)", async (client) => {
  await enqueueNightlySnapshots(db);
  for (const l of linked) await processPerformanceSnapshot(db, { locationId: l.id }, { client });
});
await cycle("performance snapshot, nightly", async (client) => {
  for (const l of linked) await processPerformanceSnapshot(db, { locationId: l.id }, { client });
});
await cycle("profile snapshot (change watch)", async (client) => {
  await enqueueNightlyProfileSnapshots(db);
  for (const l of linked) await processProfileSnapshot(db, { locationId: l.id }, { client });
});
await cycle("customer photo scan", async (client) => {
  await enqueueCustomerMediaScans(db);
  for (const l of linked) await processCustomerMediaScan(db, { locationId: l.id }, { client });
});

await boss.stop();
await sql.end();
