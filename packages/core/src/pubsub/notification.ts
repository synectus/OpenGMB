import { z } from "zod";

/**
 * Business Profile notifications as delivered to Pub/Sub.
 * Docs (types and which field names a notification carries):
 *   https://developers.google.com/my-business/reference/rest/v4/Notifications
 *   https://developers.google.com/my-business/reference/notifications/rest/v1/NotificationSetting
 *   https://developers.google.com/my-business/content/notification-setup
 * Push envelope: https://docs.cloud.google.com/pubsub/docs/push
 *
 * The documented payload fields are `notificationType`, `locationName` and, for review
 * notifications, `reviewName` (the v1 reference spells these in snake_case). The docs print no
 * example message, and a third party reports that Google's first real review push arrived as
 * `{"type":"NEW_REVIEW","location":"accounts/../locations/..","review":"accounts/../reviews/.."}`
 * (github.com/kodes-agency/reputation-key PR 635; unconfirmed by Google). Until a real message
 * from this project's topic settles it, all three spellings are accepted and normalised.
 */
export const NOTIFICATION_TYPES = ["NEW_REVIEW", "UPDATED_REVIEW", "GOOGLE_UPDATE"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Push envelope. Pub/Sub writes `messageId`/`publishTime` (and snake_case twins). */
export const pushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    attributes: z.record(z.string(), z.string()).optional(),
    messageId: z.string().min(1).optional(),
    message_id: z.string().min(1).optional(),
    publishTime: z.string().optional(),
    publish_time: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

export type ParsedEnvelope = {
  messageId: string;
  publishTime: Date | null;
  data: string;
};

export function parsePushEnvelope(body: unknown): ParsedEnvelope | null {
  const r = pushEnvelopeSchema.safeParse(body);
  if (!r.success) return null;
  const m = r.data.message;
  const messageId = m.messageId ?? m.message_id;
  if (!messageId) return null;
  const pt = m.publishTime ?? m.publish_time;
  const publishTime = pt && !Number.isNaN(Date.parse(pt)) ? new Date(pt) : null;
  return { messageId, publishTime, data: Buffer.from(m.data, "base64").toString("utf8") };
}

const nonEmpty = z.string().min(1);
const rawNotificationSchema = z
  .object({
    notificationType: nonEmpty.optional(),
    notification_type: nonEmpty.optional(),
    type: nonEmpty.optional(),
    locationName: nonEmpty.optional(),
    location_name: nonEmpty.optional(),
    location: nonEmpty.optional(),
    reviewName: nonEmpty.optional(),
    review_name: nonEmpty.optional(),
    review: nonEmpty.optional(),
  })
  .loose();

export type GoogleNotification = {
  type: NotificationType;
  /** Normalised `locations/{id}`. */
  locationName: string;
  /** Review resource name as sent; null for GOOGLE_UPDATE. */
  resourceName: string | null;
};

/** `accounts/1/locations/2` or `locations/2` -> `locations/2`; null if not a location name. */
export function normaliseLocationName(name: string): string | null {
  const m = /(?:^|\/)locations\/([^/]+)$/.exec(name);
  return m ? `locations/${m[1]}` : null;
}

export type ParseResult =
  { ok: true; notification: GoogleNotification } | { ok: false; reason: string };

/** Parse the decoded Pub/Sub `data` string. Unknown types are rejected with a reason. */
export function parseGoogleNotification(data: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, reason: "data is not JSON" };
  }
  const r = rawNotificationSchema.safeParse(json);
  if (!r.success) return { ok: false, reason: "data is not a notification object" };
  const v = r.data;
  const type = v.notificationType ?? v.notification_type ?? v.type;
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(type ?? "")) {
    return { ok: false, reason: `unsupported notification type ${type ?? "(none)"}` };
  }
  const rawLocation = v.locationName ?? v.location_name ?? v.location;
  const locationName = rawLocation ? normaliseLocationName(rawLocation) : null;
  if (!locationName) return { ok: false, reason: "missing or invalid location name" };
  const resourceName = v.reviewName ?? v.review_name ?? v.review ?? null;
  if (type !== "GOOGLE_UPDATE" && !resourceName) {
    return { ok: false, reason: `${type} without a review name` };
  }
  return {
    ok: true,
    notification: {
      type: type as NotificationType,
      locationName,
      resourceName: type === "GOOGLE_UPDATE" ? null : resourceName,
    },
  };
}
