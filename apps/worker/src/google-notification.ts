import { and, eq, isNull } from "drizzle-orm";
import {
  clientFor,
  createGoogleClient,
  alertNegativeReviews,
  detectGoogleSuggestion,
  emitReviewCreated,
  googleNotificationContent,
  pushToUsers,
  GoogleApiError,
  parseReviewName,
  PROFILE_CHANGED_KIND,
  recipientsForLocation,
  recordGoogleSuggestion,
  REVIEW_NEGATIVE_KIND,
  upsertReviewsWithChanges,
  writeAudit,
  type GoogleReview,
  type GoogleSuggestion,
  type SuggestionReader,
} from "@opengmb/core";
import {
  googleConnections,
  googleNotifications,
  locations,
  notifications,
  type Db,
} from "@opengmb/db";

export { GOOGLE_NOTIFICATION_QUEUE } from "@opengmb/core";

type ReviewFetcher = { getReview(reviewName: string): Promise<GoogleReview> };

function isNotFound(e: unknown): boolean {
  const x = e as { code?: string; status?: number };
  return x?.code === "NOT_FOUND" || x?.status === 404;
}

/** Google said no (any 4xx) or does not know the location: retrying cannot help. */
const isPermanent = (e: unknown) =>
  isNotFound(e) || (e instanceof GoogleApiError && e.status < 500);

/**
 * NEW_REVIEW / UPDATED_REVIEW: the review is fetched from Google FIRST, with no transaction open
 * (the throttler may sleep). If that fetch fails the error propagates so pg-boss retries, and
 * nothing changes (processed_at stays null). Then one short transaction upserts the review, sets
 * processed_at and creates the in-app notifications. The fetch is skipped (F10 behaviour only)
 * when the location has no Google connection, the notification names no review of this location,
 * or Google says the review no longer exists (404: retrying cannot help). An inactive location is
 * marked processed and does nothing else. GOOGLE_UPDATE asks Google what consumers see
 * (`locations.getGoogleUpdated`); a new difference is stored as a google_suggested profile change with
 * a profile.changed alert in place of the generic notification, and anything else keeps F10 behaviour.
 *
 * Marks the Google notification processed and, in the same transaction, creates an in-app
 * notification for every member who can see the location (decided by core). Idempotent: the processed_at claim means a re-run is a no-op,
 * and notifications are also unique per (user, source), so they cannot duplicate. A missing row
 * is logged, not thrown (retrying cannot bring it back). Titles carry the location name only,
 * never anything from the payload.
 */
export async function processGoogleNotification(
  db: Db,
  notificationId: string,
  deps: { client?: ReviewFetcher; profileClient?: SuggestionReader } = {},
): Promise<void> {
  // Phase 1: Google, no transaction.
  let fetched: GoogleReview | null = null;
  let suggestion: GoogleSuggestion | null = null;
  const [pending] = await db
    .select()
    .from(googleNotifications)
    .where(
      and(eq(googleNotifications.id, notificationId), isNull(googleNotifications.processedAt)),
    );
  const [pendingLoc] = pending
    ? await db.select().from(locations).where(eq(locations.id, pending.locationId))
    : [];
  if (pending && pendingLoc?.status === "inactive") {
    await db
      .update(googleNotifications)
      .set({ processedAt: new Date() })
      .where(
        and(eq(googleNotifications.id, notificationId), isNull(googleNotifications.processedAt)),
      );
    return;
  }
  if (
    pending &&
    pendingLoc &&
    pending.type !== "GOOGLE_UPDATE" &&
    pending.resourceName &&
    parseReviewName(pending.resourceName)?.locationName === pendingLoc.googleLocationId
  ) {
    let client = deps.client;
    if (!client && pendingLoc.connectionId) {
      const [conn] = await db
        .select()
        .from(googleConnections)
        .where(
          and(
            eq(googleConnections.id, pendingLoc.connectionId),
            eq(googleConnections.orgId, pendingLoc.orgId),
          ),
        );
      if (conn) client = createGoogleClient({ db, connection: conn });
    }
    if (client) {
      try {
        fetched = await client.getReview(pending.resourceName);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        console.warn(`[worker] google-notification ${notificationId}: review no longer exists`);
      }
    }
  }

  // GOOGLE_UPDATE: what does Google show that the merchant's profile does not? Failures that cannot
  // improve with a retry fall back to the generic notification; the rest throw so pg-boss retries.
  if (
    pending?.type === "GOOGLE_UPDATE" &&
    pendingLoc?.status === "active" &&
    pendingLoc.googleLocationId
  ) {
    const reader =
      deps.profileClient ??
      (deps.client && "getGoogleUpdated" in deps.client
        ? (deps.client as unknown as SuggestionReader)
        : await clientFor(db, pendingLoc.orgId, pendingLoc.connectionId));
    if (reader) {
      try {
        suggestion = await detectGoogleSuggestion(reader, pendingLoc.googleLocationId);
      } catch (e) {
        if (!isPermanent(e)) throw e;
        console.warn(`[worker] google-notification ${notificationId}: getGoogleUpdated failed`);
      }
    }
  }

  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(googleNotifications)
      .set({ processedAt: new Date() })
      .where(
        and(eq(googleNotifications.id, notificationId), isNull(googleNotifications.processedAt)),
      )
      .returning();
    if (!row) {
      const [exists] = await tx
        .select({ id: googleNotifications.id })
        .from(googleNotifications)
        .where(eq(googleNotifications.id, notificationId));
      if (!exists)
        console.warn(`[worker] google-notification ${notificationId} not found, skipping`);
      return;
    }
    const [loc] = await tx
      .select({
        name: locations.name,
        id: locations.id,
        orgId: locations.orgId,
        workspaceId: locations.workspaceId,
        status: locations.status,
        title: locations.title,
      })
      .from(locations)
      .where(eq(locations.id, row.locationId));
    if (loc?.status === "inactive") return; // deactivated since phase 1: processed, nothing else
    const review = fetched && loc ? await upsertReviewsWithChanges(tx, loc, [fetched]) : null;
    // A review that just became negative gets the review.negative alert INSTEAD of the generic one.
    const negative =
      review && loc ? await alertNegativeReviews(tx, loc, review.changes) : new Set<string>();
    const isNegative = negative.size > 0;
    // A live Pub/Sub review is news: same webhook path as the sync, never the first-sync import guard.
    if (review && loc) await emitReviewCreated(tx, loc, review.changes, { firstSync: false });
    // A new Google-suggested change gets the profile.changed alert INSTEAD of the generic one.
    const change = suggestion && loc ? await recordGoogleSuggestion(tx, loc, suggestion) : null;
    const generic = googleNotificationContent(row.type, loc?.name ?? row.locationName);
    const replacedBy = isNegative ? REVIEW_NEGATIVE_KIND : change ? PROFILE_CHANGED_KIND : null;
    const kind = replacedBy ?? generic.kind;
    const title = generic.title;
    const recipients = replacedBy ? [] : await recipientsForLocation(tx, row.orgId, row.locationId);
    if (recipients.length > 0) {
      const created = await tx
        .insert(notifications)
        .values(
          recipients.map((userId) => ({
            orgId: row.orgId,
            userId,
            kind,
            title,
            link: null,
            sourceType: "google_notification",
            sourceId: row.id,
          })),
        )
        .onConflictDoNothing({
          target: [notifications.userId, notifications.sourceType, notifications.sourceId],
        })
        .returning({ userId: notifications.userId });
      await pushToUsers(
        tx,
        row.orgId,
        created.map((r) => r.userId),
        { kind, title, link: null },
      );
    }
    await writeAudit(tx, {
      orgId: row.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "notification.create",
      entityType: "google_notification",
      entityId: row.id,
      after: {
        recipientCount: recipients.length,
        kind,
        ...(replacedBy ? { replacedBy } : {}),
        ...(change ? { profileChangeId: change.id } : {}),
        ...(review ? { review: { inserted: review.inserted, updated: review.updated } } : {}),
      },
    });
  });
}

export async function handleGoogleNotificationJobs(
  db: Db,
  jobs: { id: string; data: { notificationId: string } }[],
) {
  for (const job of jobs) {
    await processGoogleNotification(db, job.data.notificationId);
    console.log(`[worker] google-notification job ${job.id} processed`);
  }
}
