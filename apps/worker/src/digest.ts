import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { DIGEST_CRON, DIGEST_LOCAL_HOUR, dayKey, escapeHtml, localParts, resendSendEmail, writeAudit, type SendEmail } from "@opengmb/core";
import {
  googleNotifications,
  locations,
  notificationDigests,
  notifications,
  users,
  workspaces,
  type Db,
} from "@opengmb/db";

export { DIGEST_CRON, resendSendEmail };

/**
 * The zone a (org, user) digest follows: the zone of the workspace owning most of the user's unread
 * items (tie: the alphabetically first zone). Items without a location (approval requests) do not
 * vote; with no voters it is the org's oldest workspace, then UTC.
 */
export function digestZone(itemZones: (string | null)[], orgDefault: string | undefined): string {
  const votes = new Map<string, number>();
  for (const z of itemZones) if (z) votes.set(z, (votes.get(z) ?? 0) + 1);
  const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? orgDefault ?? "UTC";
}
export type { EmailMessage, SendEmail } from "@opengmb/core";

export const DIGEST_QUEUE = "notifications.digest";

export type DigestDeps = {
  sendEmail: SendEmail;
  /** Empty or undefined: the run logs and sends nothing. */
  apiKey: string | undefined;
  from: string | undefined;
  appUrl: string;
  now?: () => Date;
  /** Restrict the run to these orgs. Production leaves it unset (every org); tests pass their own org so a run never scans the shared DB. */
  orgIds?: string[];
};

/** The queue must exist before it can be scheduled. Safe to call on every start. */
export async function registerDigestSchedule(boss: PgBoss) {
  await boss.createQueue(DIGEST_QUEUE);
  await boss.schedule(DIGEST_QUEUE, DIGEST_CRON, {}, { tz: "UTC", retryLimit: 2, retryDelay: 300 });
}

const KIND_LABEL: Record<string, string> = {
  "google.new_review": "New reviews",
  "google.updated_review": "Updated reviews",
  "google.google_update": "Google suggested edits",
  "review.negative": "Negative reviews",
  "review.assigned": "Reviews assigned to you",
  "approval.requested": "Items awaiting your approval",
  "profile.changed": "Profile changes",
  "media.customer_photo": "New customer photos",
  "geogrid.budget_exceeded": "Rank tracking budget reached",
};

export function renderDigest(
  items: { kind: string; locationName: string | null }[],
  appUrl: string,
) {
  const byKind = new Map<string, number>();
  const locs = new Set<string>();
  for (const i of items) {
    byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    if (i.locationName) locs.add(i.locationName);
  }
  const counts = [...byKind].map(([k, n]) => `${KIND_LABEL[k] ?? k}: ${n}`);
  const locations = [...locs].sort();
  const text = [
    `You have ${items.length} new notifications in OpenGMB.`,
    "",
    ...counts,
    ...(locations.length ? ["", "Locations:", ...locations.map((l) => `- ${l}`)] : []),
    "",
    `Open OpenGMB: ${appUrl}`,
  ].join("\n");
  const html =
    `<p>You have ${items.length} new notifications in OpenGMB.</p>` +
    `<ul>${counts.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` +
    (locations.length
      ? `<p>Locations:</p><ul>${locations.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
      : "") +
    `<p><a href="${escapeHtml(appUrl)}">Open OpenGMB</a></p>`;
  return { subject: `OpenGMB: ${items.length} new notifications`, html, text };
}

/**
 * Daily digest. One email per (org, user) with unread notifications from the previous 24h,
 * claimed by a notification_digests row for today's date in the user's digest zone (see digestZone)
 * so it is idempotent per local day even if the job runs twice. The job runs hourly; a user's digest
 * goes out on the first sweep at or after DIGEST_LOCAL_HOUR local time. No API key: logs and writes nothing, so adding the key later still sends
 * today's digest. A failed send deletes the claim and the run throws at the end so pg-boss
 * retries. A crash between claim and send leaves a 'pending' row that blocks that user's digest
 * for the day (accepted: never double-send).
 */
export async function runDigest(db: Db, deps: DigestDeps): Promise<{ sent: number }> {
  if (!deps.apiKey) {
    console.log("[worker] digest skipped: RESEND_API_KEY not set");
    return { sent: 0 };
  }
  if (!deps.from) {
    console.log("[worker] digest skipped: EMAIL_FROM not set");
    return { sent: 0 };
  }
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      orgId: notifications.orgId,
      userId: notifications.userId,
      email: users.email,
      kind: notifications.kind,
      locationName: locations.name,
      zone: workspaces.timeZone,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(
      googleNotifications,
      and(
        eq(notifications.sourceType, "google_notification"),
        sql`${notifications.sourceId} = ${googleNotifications.id}::text`,
      ),
    )
    .leftJoin(locations, eq(locations.id, googleNotifications.locationId))
    .leftJoin(workspaces, eq(workspaces.id, locations.workspaceId))
    .where(
      and(
        isNull(notifications.readAt),
        gte(notifications.createdAt, since),
        lte(notifications.createdAt, now),
        deps.orgIds ? inArray(notifications.orgId, deps.orgIds) : undefined,
      ),
    );

  const groups = new Map<
    string,
    {
      orgId: string;
      userId: string;
      email: string;
      items: { kind: string; locationName: string | null }[];
      zones: (string | null)[];
    }
  >();
  for (const r of rows) {
    const key = `${r.orgId}/${r.userId}`;
    const g = groups.get(key) ?? { orgId: r.orgId, userId: r.userId, email: r.email, items: [], zones: [] };
    g.items.push({ kind: r.kind, locationName: r.locationName });
    g.zones.push(r.zone);
    groups.set(key, g);
  }

  const oldest = new Map<string, string>();
  if (groups.size > 0) {
    const orgs = [...new Set([...groups.values()].map((g) => g.orgId))];
    for (const w of await db
      .select({ orgId: workspaces.orgId, timeZone: workspaces.timeZone })
      .from(workspaces)
      .where(inArray(workspaces.orgId, orgs))
      .orderBy(workspaces.createdAt))
      if (!oldest.has(w.orgId)) oldest.set(w.orgId, w.timeZone);
  }

  let sent = 0;
  let failed = 0;
  let waiting = 0;
  const dates = new Set<string>();
  for (const g of groups.values()) {
    const zone = digestZone(g.zones, oldest.get(g.orgId));
    if (localParts(now, zone).hour < DIGEST_LOCAL_HOUR) {
      waiting++;
      continue;
    }
    const digestDate = dayKey(now, zone);
    dates.add(digestDate);
    const [claim] = await db
      .insert(notificationDigests)
      .values({
        orgId: g.orgId,
        userId: g.userId,
        digestDate,
        status: "pending",
        notificationCount: g.items.length,
      })
      .onConflictDoNothing()
      .returning({ userId: notificationDigests.userId });
    if (!claim) continue; // already claimed or sent today
    const pk = and(
      eq(notificationDigests.orgId, g.orgId),
      eq(notificationDigests.userId, g.userId),
      eq(notificationDigests.digestDate, digestDate),
    );
    try {
      await deps.sendEmail({
        from: deps.from,
        to: g.email,
        ...renderDigest(g.items, deps.appUrl),
        idempotencyKey: `digest-${g.orgId}-${g.userId}-${digestDate}`,
      });
    } catch (e) {
      failed++;
      await db.delete(notificationDigests).where(pk);
      console.error(`[worker] digest send failed for user ${g.userId}`, e);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.update(notificationDigests).set({ status: "sent", sentAt: new Date() }).where(pk);
      await writeAudit(tx, {
        orgId: g.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "notification.digest_sent",
        entityType: "notification_digest",
        entityId: `${g.userId}/${digestDate}`,
        after: { count: g.items.length, digestDate },
      });
    });
    sent++;
  }
  console.log(
    `[worker] digest ${[...dates].sort().join(",") || "-"}: ${groups.size} recipients, ${waiting} waiting for their morning, ${sent} sent, ${failed} failed`,
  );
  if (failed > 0) throw new Error(`digest: ${failed} send(s) failed`);
  return { sent };
}
