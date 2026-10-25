import { and, eq } from "drizzle-orm";
import {
  locations,
  memberships,
  notifications,
  reviewReplies,
  reviews,
  users,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { loadBranding } from "./branding";
import { pushToUsers } from "./push";
import { emailFromFor, originForRole } from "./custom-domains";
import { getEmailSender, renderBrandedEmail } from "./email";
import type { ActionAuditEntry } from "./registry";

export const APPROVAL_REQUESTED_KIND = "approval.requested";

export type ApprovalItemType = "reply" | "post" | "changeset" | "postedit";

/** Path of the portal page for one approval item. A deep link only: it still needs sign-in and TOTP. */
export const approvalPath = (type: ApprovalItemType, id: string) =>
  `/portal/approvals/${type}/${id}`;

/**
 * Tell the client approvers of a workspace that something entered pending_approval: one in-app
 * notification and one email each, inside the submitting action's transaction (the notification
 * rows commit with the status change; the email goes out through the injectable sender).
 *
 * Titles and emails name the location or workspace only, never review or post text. `source_id`
 * carries the submission time so a resubmit after a rejection notifies again, while a retry of the
 * same submission cannot duplicate. An email failure is logged and never fails the submit: the
 * in-app notification and the daily digest still reach the approver.
 */
export async function notifyApprovalRequested(
  tx: Tx,
  audit: (entry: ActionAuditEntry) => Promise<void>,
  item: {
    orgId: string;
    workspaceId: string;
    type: ApprovalItemType;
    id: string;
    submittedAt: Date;
  },
): Promise<number> {
  const approvers = await tx
    .select({ userId: memberships.userId, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.orgId, item.orgId),
        eq(memberships.workspaceId, item.workspaceId),
        eq(memberships.role, "client_approver"),
      ),
    );
  if (approvers.length === 0) return 0;

  const [ws] = await tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, item.workspaceId));
  let where = ws?.name ?? "your workspace";
  if (item.type === "reply") {
    const [loc] = await tx
      .select({ name: locations.name })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(eq(reviewReplies.id, item.id));
    if (loc) where = loc.name;
  }
  const title =
    item.type === "reply"
      ? `Reply awaiting your approval at ${where}`
      : item.type === "post"
        ? `Post awaiting your approval for ${where}`
        : item.type === "postedit"
          ? `Post edit awaiting your approval for ${where}`
          : `Profile change awaiting your approval for ${where}`;
  const link = approvalPath(item.type, item.id);

  const created = await tx
    .insert(notifications)
    .values(
      approvers.map((a) => ({
        orgId: item.orgId,
        userId: a.userId,
        kind: APPROVAL_REQUESTED_KIND,
        title,
        link,
        sourceType: `approval_${item.type}`,
        sourceId: `${item.id}:${item.submittedAt.toISOString()}`,
      })),
    )
    .onConflictDoNothing({
      target: [notifications.userId, notifications.sourceType, notifications.sourceId],
    })
    .returning({ id: notifications.id, userId: notifications.userId });
  if (created.length === 0) return 0;

  await audit({
    action: "notification.create",
    entityType:
      item.type === "reply"
        ? "review_reply"
        : item.type === "post"
          ? "post"
          : item.type === "postedit"
            ? "post_edit"
            : "profile_change_set",
    entityId: item.id,
    before: null,
    after: { kind: APPROVAL_REQUESTED_KIND, recipientCount: created.length },
  });

  await pushToUsers(
    tx,
    item.orgId,
    created.map((c) => c.userId),
    { kind: APPROVAL_REQUESTED_KIND, title, link },
  );

  const brand = await loadBranding(tx, item.orgId);
  const url = `${await originForRole(tx, item.orgId, "client_approver")}${link}`;
  const from = await emailFromFor(tx, item.orgId);
  const body = renderBrandedEmail(brand, {
    heading: title,
    paragraphs: [
      `${brand.agencyName} has submitted something for your approval. Sign in to review it; you will be asked for your two-factor code.`,
    ],
    cta: { label: "Review and approve", url },
  });
  const send = getEmailSender();
  for (const n of created) {
    const to = approvers.find((a) => a.userId === n.userId)?.email;
    if (!to) continue;
    try {
      await send({
        from,
        to,
        subject: title,
        html: body.html,
        text: body.text,
        idempotencyKey: `approval-${n.id}`,
      });
    } catch (e) {
      console.error("[core] approval email failed", e instanceof Error ? e.message : e);
    }
  }
  return created.length;
}
