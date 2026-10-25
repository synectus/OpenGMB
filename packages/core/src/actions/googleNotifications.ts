import { desc, max } from "drizzle-orm";
import { z } from "zod";
import { googleNotificationRegistrations, googleNotifications, type Db, type Tx } from "@opengmb/db";
import { AccessError } from "../actor";
import { isPlatformAdmin } from "../config/platform-admin";
import { GOOGLE_NOTIFICATIONS } from "../config/google-notifications";
import { CoreError } from "../errors";
import { NOTIFICATION_REGISTER_QUEUE } from "../google/notification-registration";
import { getIntegration } from "../integrations";
import { enqueueJob } from "../jobs";
import { defineAction } from "../registry";

// Instant review alerts (PS). Server-wide, so platform administrators only, like integrations.*.

async function assertPlatformAdmin(tx: Tx | Db, userId: string) {
  if (!(await isPlatformAdmin(tx, userId))) {
    throw new AccessError("FORBIDDEN", "Only platform administrators can manage instant review alerts");
  }
}

const registrationOut = z.object({
  accountName: z.string(),
  topic: z.string().nullable(),
  registeredAt: z.string().nullable(),
  lastAttemptAt: z.string(),
  lastError: z.string().nullable(),
});

export const googleNotificationsStatus = defineAction({
  name: "googleNotifications.status",
  description:
    "Platform administrators only (everyone else gets FORBIDDEN). Whether instant review alerts are set up: which of the three settings (PUBSUB_TOPIC, PUBSUB_AUDIENCE, PUBSUB_SERVICE_ACCOUNT_EMAIL) are set, each Google account's registration (topic, when Google accepted it, last error in plain words) and when the last push arrived. Never returns setting values.",
  input: z.object({}),
  output: z.object({
    settings: z.object({ topic: z.boolean(), audience: z.boolean(), serviceAccount: z.boolean() }),
    pushPath: z.string(),
    publisherServiceAccount: z.string(),
    apiName: z.string(),
    registrations: z.array(registrationOut),
    lastPushAt: z.string().nullable(),
  }),
  permission: "member:invite",
  kind: "read",
  async handler({ tx, actor }) {
    await assertPlatformAdmin(tx, actor.userId);
    const regs = await tx
      .select()
      .from(googleNotificationRegistrations)
      .orderBy(desc(googleNotificationRegistrations.lastAttemptAt))
      .limit(200);
    const [last] = await tx.select({ at: max(googleNotifications.receivedAt) }).from(googleNotifications);
    return {
      settings: {
        topic: Boolean(getIntegration("PUBSUB_TOPIC")),
        audience: Boolean(getIntegration("PUBSUB_AUDIENCE")),
        serviceAccount: Boolean(getIntegration("PUBSUB_SERVICE_ACCOUNT_EMAIL")),
      },
      pushPath: "/webhooks/google-pubsub",
      publisherServiceAccount: GOOGLE_NOTIFICATIONS.publisherServiceAccount,
      apiName: GOOGLE_NOTIFICATIONS.apiName,
      registrations: regs.map((r) => ({
        accountName: r.accountName,
        topic: r.topic,
        registeredAt: r.registeredAt?.toISOString() ?? null,
        lastAttemptAt: r.lastAttemptAt.toISOString(),
        lastError: r.lastError,
      })),
      lastPushAt: last?.at?.toISOString() ?? null,
    };
  },
});

export const googleNotificationsRegisterAll = defineAction({
  name: "googleNotifications.registerAll",
  description:
    "Platform administrators only. Point every connected Google account's Business Profile notifications at the PUBSUB_TOPIC Pub/Sub topic. This writes a notification setting to Google for each account, so a signed-in person runs it. The work runs in the worker; the result (registered at, last error) shows in googleNotifications.status within a minute or two. Refused while PUBSUB_TOPIC is not set.",
  input: z.object({}),
  output: z.object({ queued: z.boolean() }),
  permission: "member:invite",
  kind: "write",
  approval: "own_flow",
  async preview() {
    return { summary: "Register every connected Google account for instant review alerts on the configured Pub/Sub topic" };
  },
  async handler({ tx, actor, audit }) {
    await assertPlatformAdmin(tx, actor.userId);
    if (!getIntegration("PUBSUB_TOPIC")) {
      throw new CoreError("INVALID_INPUT", "Set PUBSUB_TOPIC in Settings > Integrations first.");
    }
    await enqueueJob(tx, NOTIFICATION_REGISTER_QUEUE, { scope: "all" });
    await audit({
      action: "google_notifications.register_requested",
      entityType: "google_notification_registrations",
      entityId: "all",
      before: null,
      after: { scope: "all" },
    });
    return { queued: true };
  },
});
