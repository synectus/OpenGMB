import { and, eq, inArray } from "drizzle-orm";
import { pushSubscriptions, type Db, type Tx } from "@opengmb/db";
import { integrationEnv } from "./integrations";
import { GOOGLE_NOTIFICATION_KINDS } from "./notifications";

/**
 * Web Push (X4). Push goes to the people who get the in-app notification, for new reviews (the
 * generic one and the negative alert that replaces it) and for approvals. The payload is the
 * notification title, which names the location and never carries review text.
 */
// Literals, not imports: approvals.ts and negative-alert.ts call this file. push.test.ts pins them.
const REVIEW_NEGATIVE_KIND = "review.negative";
const APPROVAL_REQUESTED_KIND = "approval.requested";
const GEOGRID_BUDGET_EXCEEDED_KIND = "geogrid.budget_exceeded";

export const PUSH_KINDS: readonly string[] = [
  GOOGLE_NOTIFICATION_KINDS.NEW_REVIEW,
  REVIEW_NEGATIVE_KIND,
  APPROVAL_REQUESTED_KIND,
  GEOGRID_BUDGET_EXCEEDED_KIND,
];

export type PushConfig = { publicKey: string; privateKey: string; subject: string };

/** The VAPID keys, or null when any is missing: the feature is then hidden and nothing is sent. */
export function pushConfig(env: NodeJS.ProcessEnv = integrationEnv() as NodeJS.ProcessEnv): PushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

/**
 * The endpoint is a URL this server will POST to, so a person must not be able to point it at an
 * internal address. Only the push services of the browsers' vendors are accepted.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
};

/** Store this device for the person. The same endpoint again replaces its row (keys can rotate). */
export async function savePushSubscription(
  db: Db | Tx,
  who: { userId: string; orgId: string },
  sub: PushSubscriptionInput,
): Promise<void> {
  const values = {
    orgId: who.orgId,
    userId: who.userId,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    userAgent: sub.userAgent?.slice(0, 300) ?? null,
  };
  await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
}

/** Remove this device for the person. Another person's row with the same endpoint is not touched. */
export async function removePushSubscription(
  db: Db | Tx,
  who: { userId: string },
  endpoint: string,
): Promise<number> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, who.userId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

export type PushPayload = { title: string; url: string; tag: string };

/**
 * Send one notification to every stored device of the given people. Never throws: a push failure
 * must not undo the notification that caused it. A 404 or 410 from the push service means the
 * device is gone, so its subscription is deleted. Returns how many pushes were accepted.
 */
export async function pushToUsers(
  db: Db | Tx,
  orgId: string,
  userIds: string[],
  n: { kind: string; title: string; link: string | null },
  env: NodeJS.ProcessEnv = integrationEnv() as NodeJS.ProcessEnv,
): Promise<number> {
  const config = pushConfig(env);
  if (!config || userIds.length === 0 || !PUSH_KINDS.includes(n.kind)) return 0;
  try {
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.orgId, orgId), inArray(pushSubscriptions.userId, userIds)));
    if (subs.length === 0) return 0;
    const webpush = (await import("web-push")).default;
    const payload: PushPayload = {
      title: n.title,
      url: n.link ?? (n.kind === APPROVAL_REQUESTED_KIND ? "/settings/notifications" : "/reviews"),
      tag: n.kind,
    };
    const body = JSON.stringify(payload);
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            {
              TTL: 3600,
              timeout: 5000,
              vapidDetails: {
                subject: config.subject,
                publicKey: config.publicKey,
                privateKey: config.privateKey,
              },
            },
          );
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(s.id);
          // The endpoint is a capability URL: log the status only.
          else console.warn(`[core] push failed, status ${status ?? "none"}`);
        }
      }),
    );
    if (gone.length > 0) {
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    }
    return sent;
  } catch (e) {
    console.warn("[core] push failed", e instanceof Error ? e.message : e);
    return 0;
  }
}
