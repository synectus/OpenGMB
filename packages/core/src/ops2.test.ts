import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { locationDataAccess, locations, reviewSyncs } from "@opengmb/db";
import { GOOGLE_ACCESS_CONFIG, GOOGLE_RETRY } from "./config/google-retry";
import {
  GoogleApiError,
  GoogleOrgLimitError,
  GoogleRateLimitError,
  GoogleRetriesExhaustedError,
  googleRetryAfterMs,
  isGooglePermissionDenied,
  isGoogleRateLimit,
} from "./google/errors";
import { MockGoogleClient } from "./google/mock-client";
import { deferOnRateLimit, orgStagger, rateLimitDelaySec, staggerSeconds } from "./google/rate-limit-retry";
import { markGoogleAccessDenied, isGoogleAccessBlocked } from "./locations/data-access";
import { enqueueNightlySnapshots, PERFORMANCE_SNAPSHOT_QUEUE, processPerformanceSnapshot } from "./performance/snapshot";
import { enqueueScheduledReviewSyncs, processReviewSync, REVIEW_MIRROR_QUEUE, REVIEW_SYNC_QUEUE } from "./reviews/sync";
import { db, makeOrg, sql } from "./performance-fixture";

const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T10:00:00Z");
const denied403 = () => new GoogleApiError(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
const DAY = 86_400_000;

beforeAll(async () => {
  await boss.start();
  for (const q of [PERFORMANCE_SNAPSHOT_QUEUE, REVIEW_SYNC_QUEUE, REVIEW_MIRROR_QUEUE]) await boss.createQueue(q);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("classifiers", () => {
  it("recognises every rate limit shape, including a wrapped cause", () => {
    expect(isGoogleRateLimit(new GoogleOrgLimitError(30_000))).toBe(true);
    expect(isGoogleRateLimit(new GoogleRateLimitError(1000))).toBe(true);
    expect(isGoogleRateLimit(new GoogleRetriesExhaustedError(3, new GoogleRateLimitError()))).toBe(true);
    expect(isGoogleRateLimit(new GoogleApiError(429, null))).toBe(true);
    expect(isGoogleRateLimit(new GoogleApiError(500, { error: { status: "RESOURCE_EXHAUSTED" } }))).toBe(true);
    expect(isGoogleRateLimit(new Error("x", { cause: new GoogleOrgLimitError(1000) }))).toBe(true);
    expect(isGoogleRateLimit(denied403())).toBe(false);
    expect(isGoogleRateLimit(new Error("boom"))).toBe(false);
    expect(googleRetryAfterMs(new GoogleOrgLimitError(45_000))).toBe(45_000);
  });
  it("403: plain permission denied only, not project-wide reasons", () => {
    const no = GOOGLE_ACCESS_CONFIG.notLocationSpecificReasons;
    expect(isGooglePermissionDenied(denied403(), no)).toBe(true);
    expect(isGooglePermissionDenied(new GoogleApiError(404, null), no)).toBe(false);
    const disabled = new GoogleApiError(403, { error: { status: "PERMISSION_DENIED", message: "API disabled", details: [{ reason: "SERVICE_DISABLED" }] } });
    expect(isGooglePermissionDenied(disabled, no)).toBe(false);
    const scope = new GoogleApiError(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    expect(isGooglePermissionDenied(scope, no)).toBe(false);
  });
});

describe("delay and stagger", () => {
  it("backs off 70 s then doubles, honours a longer ask, caps", () => {
    expect([0, 1, 2, 3, 4].map((a) => rateLimitDelaySec(a))).toEqual([70, 140, 280, 560, 1120]);
    expect(rateLimitDelaySec(0, 200_000)).toBe(210);
    expect(rateLimitDelaySec(20)).toBe(GOOGLE_RETRY.maxDelaySec);
  });
  it("spaces one org's locations and starts each org at 0", () => {
    expect(staggerSeconds(3)).toBe(3 * GOOGLE_RETRY.staggerSecondsPerLocation);
    const s = orgStagger();
    expect([s("a"), s("a"), s("b"), s("a")]).toEqual([0, 2, 0, 4]);
  });
});

describe("deferOnRateLimit", () => {
  const mk = (data: { rlAttempt?: number }, err: unknown) => {
    const sent: { queue: string; data: object; opts: { startAfter: number } }[] = [];
    const p = deferOnRateLimit({
      queue: "q",
      data,
      send: async (queue, d, opts) => void sent.push({ queue, data: d, opts }),
      run: async () => {
        throw err;
      },
    });
    return { p, sent };
  };
  it("re-sends a rate-limited job with startAfter and does not throw", async () => {
    const { p, sent } = mk({ rlAttempt: 1 }, new GoogleOrgLimitError(30_000));
    expect(await p).toBe("deferred");
    expect(sent).toEqual([{ queue: "q", data: { rlAttempt: 2 }, opts: { startAfter: 140 } }]);
  });
  it("rethrows other errors and rate limits past the attempt cap", async () => {
    await expect(mk({}, new Error("boom")).p).rejects.toThrow("boom");
    await expect(mk({ rlAttempt: GOOGLE_RETRY.maxAttempts }, new GoogleOrgLimitError(1000)).p).rejects.toThrow();
  });
  it("tells run whether it may defer", async () => {
    const seen: boolean[] = [];
    for (const rlAttempt of [0, GOOGLE_RETRY.maxAttempts]) {
      await deferOnRateLimit({ queue: "q", data: { rlAttempt }, send: async () => {}, run: async ({ canDefer }) => void seen.push(canDefer) });
    }
    expect(seen).toEqual([true, false]);
  });
});

describe("reviews.sync under a rate limit", () => {
  async function pendingSync(label: string) {
    const org = await makeOrg();
    await db.update(locations).set({ googleAccountName: `accounts/${label}` }).where(eq(locations.id, org.locA1.id));
    const [sync] = await db.insert(reviewSyncs).values({ orgId: org.orgId, locationId: org.locA1.id, requestedBy: null }).returning();
    return { org, syncId: sync!.id };
  }
  const limited = { listReviews: async () => { throw new GoogleOrgLimitError(60_000); } };
  const status = async (id: string) => (await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, id)))[0]!.status;

  it("stays pending (not failed) when the worker will re-queue, even on the last pg-boss attempt", async () => {
    const { syncId } = await pendingSync("1");
    await expect(processReviewSync(db, syncId, { client: limited, isFinalAttempt: true, deferRateLimit: true })).rejects.toThrow();
    expect(await status(syncId)).toBe("pending");
  });
  it("fails once re-queues are used up", async () => {
    const { syncId } = await pendingSync("2");
    await expect(processReviewSync(db, syncId, { client: limited, isFinalAttempt: false, deferRateLimit: false })).rejects.toThrow();
    expect(await status(syncId)).toBe("failed");
  });
  it("a rate-limited posts step is queued on its own, ~70 s out, and the sync still completes", async () => {
    const { org, syncId } = await pendingSync("3");
    const client = {
      listReviews: async () => ({ reviews: [] }),
      listLocalPosts: async () => { throw new GoogleOrgLimitError(60_000); },
    };
    await processReviewSync(db, syncId, { client });
    expect(await status(syncId)).toBe("done");
    const jobs = await sql<{ data: { step: string; rlAttempt: number }; secs: number }[]>`
      select data, extract(epoch from (start_after - now()))::float as secs from pgboss.job
      where name = ${REVIEW_MIRROR_QUEUE} and data->>'locationId' = ${org.locA1.id}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.step).toBe("posts");
    expect(jobs[0]!.secs).toBeGreaterThan(55);
    expect(jobs[0]!.secs).toBeLessThan(75);
  });
});

describe("stagger of scheduled fan-outs", () => {
  it("reviews.schedule and performance nightly space one org's locations", async () => {
    const org = await makeOrg(); // 3 active linked locations
    await db.update(locations).set({ googleAccountName: "accounts/1" }).where(eq(locations.orgId, org.orgId));
    await enqueueScheduledReviewSyncs(db, { orgIds: [org.orgId] });
    await enqueueNightlySnapshots(db, { orgIds: [org.orgId] });
    const perf = await sql<{ secs: number }[]>`
      select extract(epoch from (start_after - created_on))::float as secs from pgboss.job
      where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' in ${sql([org.locA1.id, org.locA2.id, org.locB.id])}
      order by 1`;
    const secs = perf.map((r) => Math.round(r.secs));
    const step = GOOGLE_RETRY.staggerSecondsPerLocation;
    expect(secs).toEqual([0, step, 2 * step]);
    const syncs = await sql<{ secs: number }[]>`
      select extract(epoch from (j.start_after - j.created_on))::float as secs from pgboss.job j
      join review_syncs s on s.id::text = j.data->>'syncId' where s.org_id = ${org.orgId} order by 1`;
    expect(syncs.map((r) => Math.round(r.secs))).toEqual([0, step, 2 * step]);
  });
});

describe("403 on performance", () => {
  it("marks the location, finishes quietly, skips later runs, re-checks after the window, clears on success", async () => {
    const org = await makeOrg();
    const loc = org.locA1;
    let calls = 0;
    const denying = {
      fetchDailyMetrics: async () => { calls++; throw denied403(); },
      listMonthlySearchKeywords: async () => ({ keywords: [] }),
    };
    expect(await processPerformanceSnapshot(db, { locationId: loc.id }, { client: denying, now: NOW }))
      .toEqual({ status: "skipped", reason: "google_access_denied" });
    expect(calls).toBe(1);
    const [row] = await db.select().from(locationDataAccess).where(eq(locationDataAccess.locationId, loc.id));
    expect(row).toMatchObject({ resource: "performance", reason: "permission_denied" });

    // Next night: skipped without a call.
    const next = new Date(NOW.getTime() + DAY);
    expect(await processPerformanceSnapshot(db, { locationId: loc.id }, { client: denying, now: next }))
      .toEqual({ status: "skipped", reason: "google_access_denied" });
    expect(calls).toBe(1);
    expect(await isGoogleAccessBlocked(db, loc.id, "performance", next)).toBe(true);

    // After the window: one re-check; still denied moves lastCheckedAt only.
    const later = new Date(NOW.getTime() + (GOOGLE_ACCESS_CONFIG.recheckDays + 1) * DAY);
    await processPerformanceSnapshot(db, { locationId: loc.id }, { client: denying, now: later });
    expect(calls).toBe(2);
    const [row2] = await db.select().from(locationDataAccess).where(eq(locationDataAccess.locationId, loc.id));
    expect(row2!.firstSeenAt.getTime()).toBe(row!.firstSeenAt.getTime());
    expect(row2!.lastCheckedAt.getTime()).toBe(later.getTime());

    // Access restored: a re-check that works clears the mark.
    const much = new Date(later.getTime() + (GOOGLE_ACCESS_CONFIG.recheckDays + 1) * DAY);
    const r = await processPerformanceSnapshot(db, { locationId: loc.id }, { client: new MockGoogleClient(), now: much });
    expect(r.status).toBe("done");
    expect(await db.select().from(locationDataAccess).where(eq(locationDataAccess.locationId, loc.id))).toHaveLength(0);
  });

  it("a project-wide 403 still throws and marks nothing", async () => {
    const org = await makeOrg();
    const off = new GoogleApiError(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } });
    const client = { fetchDailyMetrics: async () => { throw off; }, listMonthlySearchKeywords: async () => ({ keywords: [] }) };
    await expect(processPerformanceSnapshot(db, { locationId: org.locA1.id }, { client, now: NOW })).rejects.toThrow();
    expect(await isGoogleAccessBlocked(db, org.locA1.id, "performance", NOW)).toBe(false);
  });

  it("a manual backfill tries again even while marked, and the by-location read reports the mark", async () => {
    const org = await makeOrg();
    await markGoogleAccessDenied(db, org.locA1, "performance", NOW);
    const client = new MockGoogleClient();
    const r = await processPerformanceSnapshot(db, { locationId: org.locA1.id, backfill: true }, { client, now: NOW });
    expect(r.status).toBe("done");
    await markGoogleAccessDenied(db, org.locA2, "place_actions", NOW);
    await markGoogleAccessDenied(db, org.locA2, "performance", NOW);
    const { executeAction } = await import("./executor");
    const res = (await executeAction(db, org.owner, "performance.byLocation", { workspaceId: org.wsA, from: "2026-10-01", to: "2026-10-10" })) as {
      rows: { locationId: string; googleAccessDenied: boolean }[];
    };
    const by = Object.fromEntries(res.rows.map((x) => [x.locationId, x.googleAccessDenied]));
    expect(by[org.locA1.id]).toBe(false);
    expect(by[org.locA2.id]).toBe(true);
  });
});
