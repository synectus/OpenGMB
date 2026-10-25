import { eq } from "drizzle-orm";
import { googleNotifications, locations, type Db } from "@opengmb/db";
import { writeAudit } from "../audit";
import { enqueueJob } from "../jobs";
import { parseGoogleNotification, parsePushEnvelope } from "./notification";
import { PubsubAuthError, verifyPubsubToken, type PubsubVerifyConfig } from "./verify";

export const GOOGLE_NOTIFICATION_QUEUE = "google-notification.process";
export const PUBSUB_MAX_BODY_BYTES = 64 * 1024;

export type PubsubPushResult = { status: 204 | 401 | 503; body?: { error: string } };

/**
 * One implementation of the Pub/Sub push receiver, used by the worker's HTTP server and by the
 * web app's public /webhooks/google-pubsub route (production has no public worker domain).
 *
 * Pub/Sub redelivers anything that is not 2xx, so after authentication only transient failures
 * (a thrown error, which the caller turns into 500) may be non-2xx. A payload we can never process
 * (malformed, oversized, unknown location, unsupported type) is logged and acknowledged with 204.
 * Auth failures are 401; no configuration is 503. `rawBody` is null when the body was over the limit.
 * The row, its audit entry and the job share one transaction, so 204 means the job is enqueued.
 */
export async function acceptPubsubPush(
  db: Db,
  p: {
    config: PubsubVerifyConfig | null;
    authorization: string | undefined;
    rawBody: Buffer | Uint8Array | null;
    surface: "worker" | "web";
  },
): Promise<PubsubPushResult> {
  const tag = `[${p.surface}]`;
  if (!p.config) {
    console.error(`${tag} pubsub webhook not configured (PUBSUB_AUDIENCE / PUBSUB_SERVICE_ACCOUNT_EMAIL)`);
    return { status: 503, body: { error: "not_configured" } };
  }
  try {
    await verifyPubsubToken(p.authorization, p.config);
  } catch (e) {
    if (!(e instanceof PubsubAuthError)) throw e;
    console.warn(`${tag} pubsub auth failed: ${e.message}`);
    return { status: 401, body: { error: "unauthorized" } };
  }

  if (!p.rawBody || p.rawBody.length > PUBSUB_MAX_BODY_BYTES) {
    console.error(`${tag} pubsub body over ${PUBSUB_MAX_BODY_BYTES} bytes, acknowledged and dropped`);
    return { status: 204 };
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(p.rawBody).toString("utf8"));
  } catch {
    console.error(`${tag} pubsub body is not JSON, acknowledged and dropped`);
    return { status: 204 };
  }
  const envelope = parsePushEnvelope(body);
  if (!envelope) {
    console.error(`${tag} pubsub envelope malformed, acknowledged and dropped`);
    return { status: 204 };
  }
  const parsed = parseGoogleNotification(envelope.data);
  if (!parsed.ok) {
    console.error(`${tag} pubsub message ${envelope.messageId} dropped: ${parsed.reason}`);
    return { status: 204 };
  }
  const n = parsed.notification;

  const rows = await db
    .select({ id: locations.id, orgId: locations.orgId, status: locations.status })
    .from(locations)
    .where(eq(locations.googleLocationId, n.locationName));
  // Inactive locations are excluded from processing; only active rows count as matches.
  const matches = rows.filter((r) => r.status === "active");
  if (matches.length !== 1) {
    const why = matches.length > 1 ? "ambiguous" : rows.length > 0 ? "inactive" : "unknown";
    console.error(
      `${tag} pubsub message ${envelope.messageId}: ${why} location ${n.locationName} (${matches.length} active matches), acknowledged and dropped`,
    );
    return { status: 204 };
  }
  const loc = matches[0]!;

  // Insert, audit and enqueue share one transaction (the job is written through the same tx), so a
  // committed notification always has its job and a rollback leaves neither.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(googleNotifications)
      .values({
        orgId: loc.orgId,
        locationId: loc.id,
        pubsubMessageId: envelope.messageId,
        type: n.type,
        resourceName: n.resourceName,
        locationName: n.locationName,
        payload: JSON.parse(envelope.data),
        publishTime: envelope.publishTime,
      })
      .onConflictDoNothing({ target: googleNotifications.pubsubMessageId })
      .returning({ id: googleNotifications.id });
    if (!row) return; // duplicate delivery: already stored, audited and enqueued
    await writeAudit(tx, {
      orgId: loc.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker", // the audit enum has no web surface; the job that follows runs in the worker
      action: "google_notification.received",
      entityType: "google_notification",
      entityId: row.id,
      after: {
        type: n.type,
        locationName: n.locationName,
        resourceName: n.resourceName,
        messageId: envelope.messageId,
      },
    });
    await enqueueJob(tx, GOOGLE_NOTIFICATION_QUEUE, { notificationId: row.id });
  });
  return { status: 204 };
}

