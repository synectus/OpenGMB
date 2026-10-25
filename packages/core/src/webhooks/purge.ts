import { and, inArray, lt } from "drizzle-orm";
import { webhookDeliveries, type Db } from "@opengmb/db";
import { WEBHOOK_DELIVERY_RETENTION_DAYS } from "../config/webhooks";

/**
 * Deletes settled deliveries (delivered, failed, skipped) older than the retention window. Their
 * payload holds review text, so it must not live forever. Pending deliveries are kept: a queued
 * retry still needs its payload. Returns the number deleted.
 */
export async function purgeOldWebhookDeliveries(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 86_400_000);
  const gone = await db
    .delete(webhookDeliveries)
    .where(
      and(
        lt(webhookDeliveries.createdAt, cutoff),
        inArray(webhookDeliveries.status, ["delivered", "failed", "skipped"]),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return gone.length;
}
