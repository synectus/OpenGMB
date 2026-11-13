// Approve, send back and discard calls shared by the Approvals page and the client portal. Kept apart from
// approval-actions.tsx so the portal does not import that component's staff-only "approvals" messages.
import {
  posts_approve,
  posts_approveEdit,
  posts_cancel,
  posts_cancelEdit,
  posts_reject,
  posts_rejectEdit,
  profile_approve,
  profile_cancel,
  profile_reject,
  reviewReplies_approve,
  reviewReplies_reject,
} from "../app/_generated/actions";

export type ApprovalType = "reply" | "post" | "changeset" | "postedit";

export function decide(type: ApprovalType, kind: "approve" | "reject", id: string, reason: string) {
  if (type === "reply") {
    return kind === "approve" ? reviewReplies_approve({ id }) : reviewReplies_reject({ id, reason });
  }
  if (type === "post") {
    return kind === "approve" ? posts_approve({ id }) : posts_reject({ id, reason });
  }
  if (type === "postedit") {
    return kind === "approve" ? posts_approveEdit({ id }) : posts_rejectEdit({ id, reason });
  }
  return kind === "approve" ? profile_approve({ id }) : profile_reject({ id, reason });
}

export type DiscardType = Exclude<ApprovalType, "reply">;

/** Cancels the item for good with the action that already does it. Replies have none: they are only sent back. */
export function discard(type: DiscardType, id: string) {
  if (type === "post") return posts_cancel({ id });
  if (type === "postedit") return posts_cancelEdit({ id });
  return profile_cancel({ id });
}
