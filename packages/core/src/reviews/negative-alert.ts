import { notifications, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import { NEGATIVE_REVIEW_MAX_STARS } from "../config/review-alerts";
import { recipientsForLocation } from "../notifications";
import { pushToUsers } from "../push";
import type { ReviewChange } from "./upsert";

export const REVIEW_NEGATIVE_KIND = "review.negative";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A stored change is negative: rating <= 3 and (new row, or it moved from > 3 / null to <= 3). */
export function isNegativeChange(c: ReviewChange): boolean {
  if (c.rating === null || c.rating > NEGATIVE_REVIEW_MAX_STARS) return false;
  return c.wasInserted || c.previousRating === null || c.previousRating > NEGATIVE_REVIEW_MAX_STARS;
}

export type AlertLocation = {
  id: string;
  orgId: string;
  name: string;
  title?: string | null;
};

/**
 * Creates `review.negative` notifications (and one audit row per alerted review, counts only) for
 * the negative changes among `changes`. Call inside the same transaction that wrote the reviews.
 * The title carries the star rating and location only: never review text or reviewer name.
 * `source_id` includes the Google update time so a later drop is not swallowed by the unique key.
 * `maxAgeDays` (sync path) skips reviews Google created longer ago than that; Pub/Sub passes none.
 * Returns the ids of the reviews that were negative and not too old (alerted, even with zero
 * recipients), so the Pub/Sub path can drop its generic notification.
 */
export async function alertNegativeReviews(
  tx: Tx,
  loc: AlertLocation,
  changes: ReviewChange[],
  opts: { maxAgeDays?: number; now?: Date } = {},
): Promise<Set<string>> {
  const now = opts.now ?? new Date();
  const cutoff = opts.maxAgeDays === undefined ? null : now.getTime() - opts.maxAgeDays * DAY_MS;
  const negatives = changes.filter(
    (c) => isNegativeChange(c) && (cutoff === null || c.createTime.getTime() >= cutoff),
  );
  const alerted = new Set(negatives.map((c) => c.reviewId));
  if (negatives.length === 0) return alerted;
  const recipients = await recipientsForLocation(tx, loc.orgId, loc.id);
  if (recipients.length === 0) return alerted;
  const where = loc.title || loc.name;
  for (const c of negatives) {
    const title = `${c.rating}★ review at ${where}`;
    const link = `/reviews?review=${c.reviewId}`;
    const created = await tx
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          orgId: loc.orgId,
          userId,
          kind: REVIEW_NEGATIVE_KIND,
          title,
          link,
          sourceType: "review",
          sourceId: `${c.reviewId}:${c.updateTime.toISOString()}`,
        })),
      )
      .onConflictDoNothing({
        target: [notifications.userId, notifications.sourceType, notifications.sourceId],
      })
      .returning({ userId: notifications.userId });
    await pushToUsers(
      tx,
      loc.orgId,
      created.map((r) => r.userId),
      { kind: REVIEW_NEGATIVE_KIND, title, link },
    );
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "notification.create",
      entityType: "review",
      entityId: c.reviewId,
      after: { reviewId: c.reviewId, rating: c.rating, recipientCount: recipients.length },
    });
  }
  return alerted;
}
