import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { googleConnections, locations, reviewSyncs, type Db, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import { GOOGLE_LIMITS } from "../config/google-limits";
import type { GoogleReview, ListReviewsResponse } from "../google/client";
import { createGoogleClient } from "../google/factory";
import { enqueueJob } from "../jobs";
import { isGoogleRateLimit, googleRetryAfterMs } from "../google/errors";
import { orgStagger, rateLimitDelaySec } from "../google/rate-limit-retry";
import { syncGooglePosts } from "../posts/google-sync";
import { syncGoogleMedia } from "../media/google-sync";
import type { ActionAuditEntry } from "../registry";
import { NEGATIVE_ALERT_MAX_AGE_DAYS } from "../config/review-alerts";
import { emitReviewCreated } from "../webhooks/emit";
import { enqueueArrivalDrafts } from "./draft-on-arrival";
import { alertNegativeReviews } from "./negative-alert";
import { upsertReviewsWithChanges } from "./upsert";
import { orgIsActive } from "../account-state";

export const REVIEW_SYNC_QUEUE = "reviews.sync";
export const REVIEW_SCHEDULE_QUEUE = "reviews.schedule";
/** OPS2: the posts / photos mirror of one location, run on its own so a rate limit retries only that step. */
export const REVIEW_MIRROR_QUEUE = "reviews.mirror_sync";
export type MirrorStep = "posts" | "media";
export type ReviewMirrorJob = { locationId: string; step: MirrorStep; rlAttempt?: number };
/** Our own bound (not a Google number): stop following nextPageToken after this many pages. */
export const MAX_REVIEW_PAGES = 50;
/** Queue options the worker creates `reviews.sync` with. The job is retried this many times. */
export const REVIEW_SYNC_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
} as const;

type Lister = {
  listReviews(
    accountName: string,
    locationId: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListReviewsResponse>;
};

/** Follows nextPageToken up to `maxPages`; `truncated` says there was more we did not fetch. */
export async function fetchAllReviews(
  client: Lister,
  accountName: string,
  locationId: string,
  opts: { maxPages?: number } = {},
): Promise<{ reviews: GoogleReview[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? MAX_REVIEW_PAGES;
  const out: GoogleReview[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listReviews(accountName, locationId, {
      pageSize: GOOGLE_LIMITS.reviewsListPageSize.limit,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...res.reviews);
    if (!res.nextPageToken) return { reviews: out, truncated: false };
    pageToken = res.nextPageToken;
  }
  return { reviews: out, truncated: true };
}

/**
 * Record a sync request and enqueue its job, inside the caller's transaction (so both exist or
 * neither does). Writes the `review_sync.requested` audit row itself. `requestedBy` is null for
 * the initial sync enqueued by the import job.
 */
export async function requestReviewSync(
  tx: Tx,
  p: {
    orgId: string;
    locationId: string;
    requestedBy: string | null;
    audit: (entry: ActionAuditEntry) => Promise<void>;
    reason: Record<string, unknown>;
    /** Seconds to hold the job back (scheduled fan-outs stagger per org). */
    startAfterSeconds?: number;
  },
): Promise<{ syncId: string; jobId: string }> {
  const [row] = await tx
    .insert(reviewSyncs)
    .values({ orgId: p.orgId, locationId: p.locationId, requestedBy: p.requestedBy })
    .returning({ id: reviewSyncs.id });
  const jobId = await enqueueJob(tx, REVIEW_SYNC_QUEUE, { syncId: row!.id }, { startAfterSeconds: p.startAfterSeconds });
  await p.audit({
    action: "review_sync.requested",
    entityType: "review_sync",
    entityId: row!.id,
    before: null,
    after: { locationId: p.locationId, requestedBy: p.requestedBy, jobId, ...p.reason },
  });
  return { syncId: row!.id, jobId };
}

/**
 * Scheduled poll: one review sync per active Google-linked location, skipping any location that
 * already has a pending sync so a slow run never stacks duplicates. `orgIds` narrows the fan-out
 * (tests); the worker passes none.
 */
export async function enqueueScheduledReviewSyncs(
  db: Db,
  opts: { orgIds?: string[] } = {},
): Promise<{ locations: number; queued: number; skippedPending: number }> {
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
  let queued = 0;
  let skippedPending = 0;
  const stagger = orgStagger();
  for (const r of rows) {
    const startAfterSeconds = stagger(r.orgId);
    const didQueue = await db.transaction(async (tx) => {
      const [pending] = await tx
        .select({ id: reviewSyncs.id })
        .from(reviewSyncs)
        .where(and(eq(reviewSyncs.locationId, r.id), eq(reviewSyncs.status, "pending")))
        .limit(1);
      if (pending) return false;
      await requestReviewSync(tx, {
        orgId: r.orgId,
        locationId: r.id,
        requestedBy: null,
        reason: { trigger: "schedule" },
        startAfterSeconds,
        audit: async (e) => {
          await writeAudit(tx, {
            ...e,
            orgId: r.orgId,
            actorUserId: null,
            actorType: "system",
            surface: "worker",
          });
        },
      });
      return true;
    });
    if (didQueue) queued++;
    else skippedPending++;
  }
  return { locations: rows.length, queued, skippedPending };
}

export type ReviewSyncCounts = {
  fetched: number;
  inserted: number;
  updated: number;
  truncated: boolean;
};

/** Marks a still-pending sync failed (own audit row, surface worker). No-op if already settled. */
export async function failReviewSync(db: Db, syncId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(reviewSyncs)
      .set({ status: "failed", error: reason, finishedAt: new Date() })
      .where(and(eq(reviewSyncs.id, syncId), eq(reviewSyncs.status, "pending")))
      .returning();
    if (!row) return;
    await writeAudit(tx, {
      orgId: row.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: reason === "location_inactive" ? "review_sync.skipped" : "review_sync.failed",
      entityType: "review_sync",
      entityId: syncId,
      after: { locationId: row.locationId, requestedBy: row.requestedBy, reason },
    });
  });
}

/**
 * Worker side of `reviews.sync`. Phase 1 reads the sync and location, then fetches every review
 * page from Google with no transaction open. Phase 2 is one short transaction: claim the pending
 * sync, re-check the location is still active, upsert, store counts, audit (counts only, never
 * review text).
 *
 * A Google failure throws before phase 2 and changes nothing, so pg-boss retries the job and the
 * sync stays `pending` meanwhile. pg-boss does not tell the handler about a final failure, so the
 * worker passes `isFinalAttempt` (retryCount >= retryLimit) and the sync is marked `failed` then;
 * if the process dies before that, the row stays `pending`. Inactive location: nothing is fetched
 * and the sync ends `failed` with error `location_inactive`. Re-running a settled sync is a no-op.
 */
export async function processReviewSync(
  db: Db,
  syncId: string,
  deps: { client?: Lister; isFinalAttempt?: boolean; deferRateLimit?: boolean } = {},
): Promise<ReviewSyncCounts | null> {
  const counts = await processReviewSyncReviews(db, syncId, deps);
  if (counts) await syncPostsQuietly(db, syncId, deps.client);
  return counts;
}

/**
 * F6: the same visit also refreshes the location's Google posts mirror, and X3a the photo mirror.
 * Best effort: a failure here never fails or retries the review sync (the next sync tries again).
 * OPS2: a rate limit on a step queues just that step (`reviews.mirror_sync`) for later instead of
 * dropping it; the reviews already stored are not fetched again. Skipped when the injected client
 * cannot list posts.
 */
async function syncPostsQuietly(db: Db, syncId: string, injected: Lister | undefined) {
  let loc: typeof locations.$inferSelect | undefined;
  let client: unknown = injected;
  try {
    const [row] = await db
      .select({ loc: locations })
      .from(reviewSyncs)
      .innerJoin(locations, eq(locations.id, reviewSyncs.locationId))
      .where(eq(reviewSyncs.id, syncId));
    loc = row?.loc;
    if (!loc) return;
    if (!client) {
      const [conn] = loc.connectionId
        ? await db.select().from(googleConnections).where(eq(googleConnections.id, loc.connectionId))
        : [];
      if (!conn) return;
      client = createGoogleClient({ db, connection: conn });
    }
  } catch (e) {
    console.warn(`[reviews.sync] google mirror sync for sync ${syncId} failed: ${e instanceof Error ? e.message : "error"}`);
    return;
  }
  for (const step of ["posts", "media"] as const) {
    try {
      await runMirrorStep(db, loc, client, step);
    } catch (e) {
      if (isGoogleRateLimit(e)) {
        try {
          await db.transaction((tx) =>
            enqueueJob(tx, REVIEW_MIRROR_QUEUE, { locationId: loc.id, step, rlAttempt: 1 } satisfies ReviewMirrorJob, {
              startAfterSeconds: rateLimitDelaySec(0, googleRetryAfterMs(e)),
            }),
          );
          console.warn(`[reviews.sync] google ${step} sync for sync ${syncId} rate limited, queued for later`);
          continue;
        } catch {
          // queue missing: fall through to the plain warning
        }
      }
      console.warn(`[reviews.sync] google ${step} sync for sync ${syncId} failed: ${e instanceof Error ? e.message : "error"}`);
    }
  }
}

async function runMirrorStep(db: Db, loc: typeof locations.$inferSelect, client: unknown, step: MirrorStep) {
  if (step === "posts") {
    if (typeof (client as { listLocalPosts?: unknown }).listLocalPosts !== "function") return;
    await syncGooglePosts(db, loc, client as Parameters<typeof syncGooglePosts>[2]);
  } else {
    if (typeof (client as { listMedia?: unknown }).listMedia !== "function") return;
    await syncGoogleMedia(db, loc, client as Parameters<typeof syncGoogleMedia>[2]);
  }
}

/** Worker side of `reviews.mirror_sync`: one step for one location. Google errors throw (the worker defers rate limits). */
export async function processReviewMirror(
  db: Db,
  job: ReviewMirrorJob,
  deps: { client?: unknown } = {},
): Promise<"done" | "skipped"> {
  const [loc] = await db.select().from(locations).where(eq(locations.id, job.locationId));
  if (!loc || loc.status !== "active" || !loc.connectionId) return "skipped";
  let client = deps.client;
  if (!client) {
    const [conn] = await db
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.id, loc.connectionId), eq(googleConnections.orgId, loc.orgId)));
    if (!conn) return "skipped";
    client = createGoogleClient({ db, connection: conn });
  }
  await runMirrorStep(db, loc, client, job.step);
  return "done";
}

async function processReviewSyncReviews(
  db: Db,
  syncId: string,
  deps: { client?: Lister; isFinalAttempt?: boolean; deferRateLimit?: boolean },
): Promise<ReviewSyncCounts | null> {
  const [sync] = await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, syncId));
  if (!sync) {
    console.warn(`[reviews.sync] sync ${syncId} not found, skipping`);
    return null;
  }
  if (sync.status !== "pending") return null;

  const [loc] = await db.select().from(locations).where(eq(locations.id, sync.locationId));
  if (!loc || loc.status !== "active") {
    await failReviewSync(db, syncId, "location_inactive");
    return null;
  }
  if (!loc.googleAccountName || !loc.googleLocationId) {
    await failReviewSync(db, syncId, "location_not_linked_to_google");
    return null;
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
    if (!conn) {
      await failReviewSync(db, syncId, "connection_removed");
      return null;
    }
    client = createGoogleClient({ db, connection: conn });
  }

  // Phase 1: Google, no transaction.
  let fetched: Awaited<ReturnType<typeof fetchAllReviews>>;
  try {
    fetched = await fetchAllReviews(client, loc.googleAccountName, loc.googleLocationId);
  } catch (e) {
    // OPS2: a rate limit the worker will re-queue must leave the sync pending; once re-queues are
    // used up (deferRateLimit false) it fails like any final attempt.
    const final =
      isGoogleRateLimit(e) && deps.deferRateLimit !== undefined ? !deps.deferRateLimit : deps.isFinalAttempt;
    if (final) {
      await failReviewSync(db, syncId, "google_fetch_failed");
    }
    throw e;
  }

  // Phase 2: one short transaction.
  return db.transaction(async (tx) => {
    // G7a: a location's first completed sync is an import, not news, so it sends no webhooks. Read
    // before this sync claims "done" below.
    const [priorDone] = await tx
      .select({ id: reviewSyncs.id })
      .from(reviewSyncs)
      .where(
        and(
          eq(reviewSyncs.locationId, loc.id),
          eq(reviewSyncs.status, "done"),
          ne(reviewSyncs.id, syncId),
        ),
      )
      .limit(1);
    const [claimed] = await tx
      .update(reviewSyncs)
      .set({ status: "done", finishedAt: new Date() })
      .where(and(eq(reviewSyncs.id, syncId), eq(reviewSyncs.status, "pending")))
      .returning({ id: reviewSyncs.id });
    if (!claimed) return null; // another run settled it first
    const [now] = await tx
      .select({ status: locations.status })
      .from(locations)
      .where(eq(locations.id, loc.id));
    if (now?.status !== "active") {
      // Deactivated while we were talking to Google: store nothing.
      await tx
        .update(reviewSyncs)
        .set({ status: "failed", error: "location_inactive" })
        .where(eq(reviewSyncs.id, syncId));
      await writeAudit(tx, {
        orgId: loc.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "review_sync.skipped",
        entityType: "review_sync",
        entityId: syncId,
        after: { locationId: loc.id, requestedBy: sync.requestedBy, reason: "location_inactive" },
      });
      return null;
    }
    const { inserted, updated, changes } = await upsertReviewsWithChanges(tx, loc, fetched.reviews);
    await alertNegativeReviews(tx, loc, changes, { maxAgeDays: NEGATIVE_ALERT_MAX_AGE_DAYS });
    await emitReviewCreated(tx, loc, changes, { firstSync: !priorDone });
    // A2: queue one AI draft job per new unreplied review (when the workspace has it on). The jobs only
    // exist if this transaction commits, and the AI call itself runs later in the worker, never here.
    await enqueueArrivalDrafts(tx, loc, changes, { firstSync: !priorDone });
    const counts: ReviewSyncCounts = {
      fetched: fetched.reviews.length,
      inserted,
      updated,
      truncated: fetched.truncated,
    };
    await tx.update(reviewSyncs).set({ counts }).where(eq(reviewSyncs.id, syncId));
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "review_sync.completed",
      entityType: "review_sync",
      entityId: syncId,
      after: { locationId: loc.id, requestedBy: sync.requestedBy, ...counts },
    });
    return counts;
  });
}
