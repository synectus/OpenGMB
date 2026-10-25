import { and, eq, inArray, like } from "drizzle-orm";
import { memberships, notifications, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import { sendAlert } from "../monitoring/alert";
import { pushToUsers } from "../push";

export const GEOGRID_BUDGET_EXCEEDED_KIND = "geogrid.budget_exceeded";
const SOURCE_TYPE = "geogrid_budget";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Tell an org's owners and admins that a rank-tracking cap stopped scans: their monthly budget
 * (scope "org") or the platform's daily cap (scope "platform"). One in-app notification per person
 * per month (org) or per day (platform), so repeated refusals do not pile up. A platform refusal
 * also sends one platform alert per UTC day (the first refusal of the day, from any org). Counts
 * only in the audit row. Safe to call inside the transaction that caught the refusal.
 */
export async function notifyBudgetExceeded(
  tx: Tx,
  p: {
    orgId: string;
    scope: "org" | "platform";
    now?: Date;
    alert?: (subject: string, text: string) => Promise<unknown>;
    /** false = no audit row. The manual path runs this from a second connection while the action's own transaction may hold the org's audit chain, so it must not write one. */
    audit?: boolean;
  },
): Promise<{ notified: number }> {
  const now = p.now ?? new Date();
  const ym = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
  const day = `${ym}-${pad(now.getUTCDate())}`;
  const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const platform = p.scope === "platform";
  const sourceId = platform ? `${p.orgId}:platform:${day}` : `${p.orgId}:${ym}`;
  const title = platform
    ? "Rank scans are paused for today across the service"
    : `Rank tracking budget reached for ${month}. Scans are paused until next month or a higher budget`;

  // The first platform refusal of the day, from any org, is the one that raises the platform alert.
  const firstPlatformToday = platform
    ? (
        await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.kind, GEOGRID_BUDGET_EXCEEDED_KIND),
              eq(notifications.sourceType, SOURCE_TYPE),
              like(notifications.sourceId, `%:platform:${day}`),
            ),
          )
          .limit(1)
      ).length === 0
    : false;

  const recipients = (
    await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, p.orgId), inArray(memberships.role, ["owner", "admin"])))
  ).map((r) => r.userId);
  const link = "/geogrid?view=usage";
  const created = recipients.length
    ? await tx
        .insert(notifications)
        .values(
          recipients.map((userId) => ({
            orgId: p.orgId,
            userId,
            kind: GEOGRID_BUDGET_EXCEEDED_KIND,
            title,
            link,
            sourceType: SOURCE_TYPE,
            sourceId,
          })),
        )
        .onConflictDoNothing({
          target: [notifications.userId, notifications.sourceType, notifications.sourceId],
        })
        .returning({ userId: notifications.userId })
    : [];
  if (created.length > 0) {
    await pushToUsers(tx, p.orgId, created.map((r) => r.userId), { kind: GEOGRID_BUDGET_EXCEEDED_KIND, title, link });
    if (p.audit !== false) {
      await writeAudit(tx, {
        orgId: p.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "notification.create",
        entityType: "geogrid_budget",
        entityId: sourceId,
        after: { scope: p.scope, recipientCount: created.length },
      });
    }
  }
  if (firstPlatformToday) {
    await (p.alert ?? sendAlert)(
      "Geo-grid: the platform daily DataForSEO cap was reached",
      `A rank scan was refused on ${day} because the platform's daily DataForSEO spend cap is used up. Scans resume at 00:00 UTC. If this is expected demand, raise the DataForSEO daily cap in Settings > Integrations > Platform limits.`,
    ).catch((e: unknown) => console.error("[geogrid] platform cap alert failed", e));
  }
  return { notified: created.length };
}
