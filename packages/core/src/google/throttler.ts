import { lt, sql } from "drizzle-orm";
import { googleRateWindows, type Db } from "@opengmb/db";
import { GOOGLE_LIMITS } from "../config/google-limits";

export const PROJECT_BUCKET = "project";
let projectBucket = PROJECT_BUCKET;
/** The bucket the shared project quota is counted in; `PROJECT_BUCKET` unless a test overrode it. */
export const currentProjectBucket = () => projectBucket;
/**
 * Test hook (vitest.setup.ts only). All test files share one database, so real-clock calls from
 * parallel files would otherwise drain the one shared "project" bucket and make unrelated
 * tests sleep until the next window. Each test file counts in its own bucket instead.
 */
export const useProjectBucketForTests = (key: string) => {
  projectBucket = key;
};
/** Limits come from the config module (source URL + verified-on date live there). */
export const PROJECT_LIMIT = GOOGLE_LIMITS.projectQpm.limit;
export const PROJECT_WINDOW_MS = GOOGLE_LIMITS.projectQpm.windowMs;
export const LOCATION_EDIT_LIMIT = GOOGLE_LIMITS.locationEditsPerMinute.limit;
export const ORG_LIMIT = GOOGLE_LIMITS.orgFairUse.limit;
export const ORG_WINDOW_MS = GOOGLE_LIMITS.orgFairUse.windowMs;
export const orgBucket = (orgId: string) => `org:${orgId}`;
export const locationEditBucket = (locationName: string) => `location-edit:${locationName}`;

const KEEP_WINDOWS_MS = 60 * 60 * 1000;
const CLEANUP_PROBABILITY = 0.01;
const MAX_JITTER_MS = 250;

export type Clock = {
  /** Epoch ms. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** [0, 1); used for wait jitter, backoff jitter and opportunistic cleanup. */
  random: () => number;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

/**
 * Fixed-window rate limiter backed by Postgres so web, mcp and worker processes share one budget
 * (the Google quota is per Cloud project, not per process). Each acquire is one atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit`: the row lock serialises racing
 * processes, and a full window yields no row, so the caller sleeps to the next window.
 *
 * Fairness: waiters retry after the window rolls with a little jitter, so ordering within a bucket
 * (e.g. edits to one location) is best-effort FIFO only. A durable per-location queue arrives
 * with P3 via pg-boss.
 */
export class PostgresRateLimiter {
  private readonly clock: Clock;

  constructor(
    private readonly db: Db,
    clock: Partial<Clock> = {},
  ) {
    this.clock = { ...realClock, ...clock };
  }

  /** Resolves once a slot in `bucketKey`'s current window is taken. */
  async acquire(bucketKey: string, limit: number, windowMs: number): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const rows = await this.db
        .insert(googleRateWindows)
        .values({ bucketKey, windowStart: new Date(windowStart), count: 1 })
        .onConflictDoUpdate({
          target: [googleRateWindows.bucketKey, googleRateWindows.windowStart],
          set: { count: sql`${googleRateWindows.count} + 1` },
          setWhere: sql`${googleRateWindows.count} < ${limit}`,
        })
        .returning({ count: googleRateWindows.count });
      if (rows.length > 0) {
        if (this.clock.random() < CLEANUP_PROBABILITY) await this.cleanup(now);
        return;
      }
      await this.clock.sleep(
        windowStart + windowMs - now + Math.floor(this.clock.random() * MAX_JITTER_MS),
      );
    }
  }

  /** Like `acquire` but never waits: `retryAfterMs` is 0 when a slot was taken, else the time to the next window. */
  async tryAcquire(bucketKey: string, limit: number, windowMs: number): Promise<{ retryAfterMs: number }> {
    const now = this.clock.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const rows = await this.db
      .insert(googleRateWindows)
      .values({ bucketKey, windowStart: new Date(windowStart), count: 1 })
      .onConflictDoUpdate({
        target: [googleRateWindows.bucketKey, googleRateWindows.windowStart],
        set: { count: sql`${googleRateWindows.count} + 1` },
        setWhere: sql`${googleRateWindows.count} < ${limit}`,
      })
      .returning({ count: googleRateWindows.count });
    if (rows.length > 0) {
      if (this.clock.random() < CLEANUP_PROBABILITY) await this.cleanup(now);
      return { retryAfterMs: 0 };
    }
    return { retryAfterMs: windowStart + windowMs - now };
  }

  private async cleanup(now: number) {
    await this.db
      .delete(googleRateWindows)
      .where(lt(googleRateWindows.windowStart, new Date(now - KEEP_WINDOWS_MS)));
  }
}
