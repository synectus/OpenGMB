/**
 * OPS3: a customer can remove our access on Google's side. The next token refresh then fails with OAuth
 * `invalid_grant` and retrying never helps. This file holds the flag that records it (`google_connections.access_lost_at`),
 * the filter every scheduled fan-out uses to leave such a connection alone, and the one notification that tells the
 * org's owners and admins. Shared code (the community edition keeps it too).
 *
 * Like admin-capture: the writers take the ROOT db, never a Tx, and never throw. No audit row is written here: this can
 * run while an action transaction holds the org's audit chain.
 */
import { and, eq, inArray, isNotNull, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { googleConnections, memberships, notifications, type Db, type Tx } from "@opengmb/db";

export const GOOGLE_ACCESS_LOST_KIND = "google.access_lost";
const SOURCE_TYPE = "google_connection";
const noticeTitle = (email: string) =>
  `Google access was removed for ${email}. Reviews, posts and stats have stopped updating until you reconnect`;

/** A WHERE condition for scheduled fan-outs: the connection (by its id column) has not lost Google access. A null column passes. */
export function googleAccessKept(connectionIdColumn: AnyColumn): SQL {
  return sql`not exists (select 1 from ${googleConnections} where ${googleConnections.id} = ${connectionIdColumn} and ${googleConnections.accessLostAt} is not null)`;
}

/**
 * Record that this connection's access is gone. `refreshTokenEnc` is the stored token that just failed: if the customer has
 * reconnected since (new token), a late failure of the old one must not flag the fresh connection. Returns true only on the
 * first flip (null to set), which is the one time owners and admins are notified; a repeat leaves the original timestamp.
 * The flag and the notification commit together.
 */
export async function markGoogleAccessLost(db: Db, connectionId: string, refreshTokenEnc: string, now = new Date()): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(googleConnections)
        .set({ accessLostAt: now })
        .where(
          and(
            eq(googleConnections.id, connectionId),
            eq(googleConnections.refreshTokenEnc, refreshTokenEnc),
            isNull(googleConnections.accessLostAt),
          ),
        )
        .returning({ orgId: googleConnections.orgId, email: googleConnections.googleAccountEmail });
      if (!row) return false;
      await notifyAccessLost(tx, row.orgId, connectionId, row.email, now);
      return true;
    });
  } catch (e) {
    console.error("[google-access] could not record lost access", e instanceof Error ? e.message : e);
    return false;
  }
}

/** A refresh worked: the flag clears. Writes only when it is currently set. */
export async function clearGoogleAccessLost(db: Db, connectionId: string): Promise<void> {
  try {
    await db
      .update(googleConnections)
      .set({ accessLostAt: null })
      .where(and(eq(googleConnections.id, connectionId), isNotNull(googleConnections.accessLostAt)));
  } catch (e) {
    console.error("[google-access] could not clear lost access", e instanceof Error ? e.message : e);
  }
}

/** One in-app notification per owner and admin. The loss time is in the source id, so a second loss after a reconnect notifies again. */
async function notifyAccessLost(db: Tx, orgId: string, connectionId: string, email: string, at: Date): Promise<void> {
  const recipients = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.role, ["owner", "admin"])));
  if (recipients.length === 0) return;
  await db
    .insert(notifications)
    .values(
      [...new Set(recipients.map((r) => r.userId))].map((userId) => ({
        orgId,
        userId,
        kind: GOOGLE_ACCESS_LOST_KIND,
        title: noticeTitle(email),
        link: "/settings/google",
        sourceType: SOURCE_TYPE,
        sourceId: `${connectionId}:${at.toISOString()}`,
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.sourceType, notifications.sourceId] });
}
