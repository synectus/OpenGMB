import { and, eq, isNull, or, sql } from "drizzle-orm";
import { webhookDeliveries, webhookSubscriptions, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import { WEBHOOK_QUEUE, WEBHOOK_REVIEW_MAX_AGE_DAYS } from "../config/webhooks";
import { enqueueJob } from "../jobs";
import type { ReviewChange } from "../reviews/upsert";
import { buildReviewCreatedEvents } from "./payload";

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT = "review.created";

export type WebhookLocation = { id: string; orgId: string; workspaceId: string };

/**
 * Turns newly inserted reviews into `webhook_deliveries` rows and one pg-boss job per row, in the
 * caller's transaction (the one that wrote the reviews), so the review, the deliveries and the jobs
 * all exist or none do.
 *
 * Backfill guard: an edit (`wasInserted` false) is not news, a review Google created more than
 * WEBHOOK_REVIEW_MAX_AGE_DAYS ago is history, and a location's first completed sync is an import.
 * The unique key (subscription, event, review) makes running the same changes twice a no-op.
 * The audit row carries counts only.
 */
export async function emitReviewCreated(
  tx: Tx,
  loc: WebhookLocation,
  changes: ReviewChange[],
  opts: { now?: Date; firstSync?: boolean } = {},
): Promise<{ deliveryIds: string[] }> {
  const now = opts.now ?? new Date();
  if (opts.firstSync) return { deliveryIds: [] };
  const cutoff = now.getTime() - WEBHOOK_REVIEW_MAX_AGE_DAYS * DAY_MS;
  const fresh = changes.filter((c) => c.wasInserted && c.createTime.getTime() >= cutoff);
  if (fresh.length === 0) return { deliveryIds: [] };

  const subs = await tx
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.orgId, loc.orgId),
        eq(webhookSubscriptions.status, "active"),
        sql`${webhookSubscriptions.events} @> ARRAY[${EVENT}]::text[]`,
        or(isNull(webhookSubscriptions.workspaceId), eq(webhookSubscriptions.workspaceId, loc.workspaceId)),
      ),
    );
  if (subs.length === 0) return { deliveryIds: [] };

  const events = await buildReviewCreatedEvents(
    tx,
    fresh.map((c) => c.reviewId),
    now,
  );
  const values = subs.flatMap((s) =>
    events.map((e) => ({
      orgId: loc.orgId,
      workspaceId: e.workspaceId,
      subscriptionId: s.id,
      eventType: EVENT,
      entityId: e.reviewId,
      payload: e.payload,
    })),
  );
  if (values.length === 0) return { deliveryIds: [] };
  // ON CONFLICT DO NOTHING hits the partial unique index (subscription, event, review).
  const inserted = await tx
    .insert(webhookDeliveries)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  for (const d of inserted) await enqueueJob(tx, WEBHOOK_QUEUE, { deliveryId: d.id });
  if (inserted.length > 0) {
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "webhook.queued",
      entityType: "location",
      entityId: loc.id,
      after: { event: EVENT, reviews: events.length, subscriptions: subs.length, deliveries: inserted.length },
    });
  }
  return { deliveryIds: inserted.map((d) => d.id) };
}
