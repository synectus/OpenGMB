import { count, isNotNull, max } from "drizzle-orm";
import { googleNotificationRegistrations, googleNotifications, type Db } from "@opengmb/db";
import { GOOGLE_NOTIFICATIONS } from "../config/google-notifications";

/** What the database says about instant review alerts, for the "Instant review alerts" status row. */
export async function getPushFacts(db: Db) {
  const [reg] = await db
    .select({ n: count() })
    .from(googleNotificationRegistrations)
    .where(isNotNull(googleNotificationRegistrations.registeredAt));
  const [last] = await db.select({ at: max(googleNotifications.receivedAt) }).from(googleNotifications);
  return {
    registered: reg?.n ?? 0,
    lastPushAt: last?.at ?? null,
    recentDays: GOOGLE_NOTIFICATIONS.recentPushDays,
  };
}
