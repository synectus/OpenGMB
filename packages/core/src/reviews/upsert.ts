import { inArray, sql } from "drizzle-orm";
import { reviews, type Tx } from "@opengmb/db";
import type { GoogleReview } from "../google/client";

const CHUNK = 200;

export type ReviewLocation = { id: string; orgId: string; workspaceId: string };
export type UpsertCounts = { inserted: number; updated: number };
/** A review row this upsert actually wrote (inserted or changed), with what it held before. */
export type ReviewChange = {
  reviewId: string;
  wasInserted: boolean;
  rating: number | null;
  /** Null when inserted, or when the stored row had no rating. */
  previousRating: number | null;
  createTime: Date;
  updateTime: Date;
};

function toRow(loc: ReviewLocation, r: GoogleReview, now: Date) {
  const reply = r.reviewReply?.comment ? r.reviewReply : null;
  return {
    orgId: loc.orgId,
    workspaceId: loc.workspaceId,
    locationId: loc.id,
    googleReviewName: r.name,
    reviewerDisplayName: r.reviewer?.displayName ?? null,
    reviewerIsAnonymous: r.reviewer?.isAnonymous ?? false,
    starRating: r.starRating,
    comment: r.comment ? r.comment : null,
    createTime: new Date(r.createTime),
    updateTime: new Date(r.updateTime),
    replyComment: reply?.comment ?? null,
    replyUpdateTime: reply ? new Date(reply.updateTime) : null,
    replyState: reply?.reviewReplyState ?? null,
    replyPolicyViolation: reply?.policyViolation ?? null,
    syncedAt: now,
  };
}

/**
 * Insert new reviews and update changed ones, keyed on `google_review_name`. Google is the source
 * of truth, reply included (a reply made in the Google UI counts). An existing row is touched only
 * when the incoming copy is not older (`update_time`) AND something differs, so re-running a sync
 * changes nothing and a stale Pub/Sub fetch cannot overwrite a newer row. `org_id`, `workspace_id`
 * and `location_id` are never rewritten by an update.
 */
export async function upsertReviews(
  tx: Tx,
  loc: ReviewLocation,
  incoming: GoogleReview[],
): Promise<UpsertCounts> {
  const { inserted, updated } = await upsertReviewsWithChanges(tx, loc, incoming);
  return { inserted, updated };
}

/** Same as `upsertReviews`, also returning one `ReviewChange` per row actually written. */
export async function upsertReviewsWithChanges(
  tx: Tx,
  loc: ReviewLocation,
  incoming: GoogleReview[],
): Promise<UpsertCounts & { changes: ReviewChange[] }> {
  const now = new Date();
  // The same review twice in one batch would hit "cannot affect row a second time": keep the newest.
  const byName = new Map<string, GoogleReview>();
  for (const r of incoming) {
    const prev = byName.get(r.name);
    if (!prev || Date.parse(r.updateTime) >= Date.parse(prev.updateTime)) byName.set(r.name, r);
  }
  const list = [...byName.values()];
  let inserted = 0;
  let updated = 0;
  const changes: ReviewChange[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const rows = list.slice(i, i + CHUNK).map((r) => toRow(loc, r, now));
    const before = new Map(
      (
        await tx
          .select({ name: reviews.googleReviewName, rating: reviews.starRating })
          .from(reviews)
          .where(
            inArray(
              reviews.googleReviewName,
              rows.map((r) => r.googleReviewName),
            ),
          )
      ).map((r) => [r.name, r.rating]),
    );
    const out = await tx
      .insert(reviews)
      .values(rows)
      .onConflictDoUpdate({
        target: reviews.googleReviewName,
        set: {
          reviewerDisplayName: sql`excluded.reviewer_display_name`,
          reviewerIsAnonymous: sql`excluded.reviewer_is_anonymous`,
          starRating: sql`excluded.star_rating`,
          comment: sql`excluded.comment`,
          createTime: sql`excluded.create_time`,
          updateTime: sql`excluded.update_time`,
          replyComment: sql`excluded.reply_comment`,
          replyUpdateTime: sql`excluded.reply_update_time`,
          replyState: sql`excluded.reply_state`,
          replyPolicyViolation: sql`excluded.reply_policy_violation`,
          syncedAt: sql`excluded.synced_at`,
        },
        setWhere: sql`excluded.update_time >= ${reviews.updateTime} and (
          excluded.update_time > ${reviews.updateTime}
          or excluded.reply_comment is distinct from ${reviews.replyComment}
          or excluded.reply_update_time is distinct from ${reviews.replyUpdateTime}
          or excluded.reply_state is distinct from ${reviews.replyState}
          or excluded.reply_policy_violation is distinct from ${reviews.replyPolicyViolation}
        )`,
      })
      .returning({
        id: reviews.id,
        name: reviews.googleReviewName,
        rating: reviews.starRating,
        createTime: reviews.createTime,
        updateTime: reviews.updateTime,
        wasInserted: sql<boolean>`(xmax = 0)`,
      });
    for (const o of out) {
      if (o.wasInserted) inserted++;
      else updated++;
      changes.push({
        reviewId: o.id,
        wasInserted: o.wasInserted,
        rating: o.rating,
        previousRating: before.get(o.name) ?? null,
        createTime: o.createTime,
        updateTime: o.updateTime,
      });
    }
  }
  return { inserted, updated, changes };
}
