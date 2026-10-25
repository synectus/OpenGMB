import { and, eq } from "drizzle-orm";
import { posts, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { CoreError } from "../errors";
import type { GuardrailResult } from "../guardrails";
import { roleHasPermission } from "../permissions";
import { postAuditFields, type PostRow } from "./content";
import type { AuditFn } from "../reviews/reply-state";

export type PostStatus = PostRow["status"];

/**
 * The post state machine; every status change goes through `transitionPost`, which checks this.
 *   draft            -> blocked (submit, guardrail block) | pending_approval | cancelled
 *   blocked          -> draft (edit) | cancelled
 *   pending_approval -> approved | draft (reject) | cancelled
 *   approved         -> scheduled (schedule) | publishing (schedule, due now) | cancelled
 *   scheduled        -> publishing (the sweep claims a due post) | cancelled
 *   publishing       -> published | failed | scheduled (a recurring post's next occurrence)
 *   published, failed, cancelled: terminal
 * Approval is always manual for posts (there is no rating to auto-approve on).
 */
export const POST_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ["blocked", "pending_approval", "cancelled"],
  blocked: ["draft", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"],
  approved: ["scheduled", "publishing", "cancelled"],
  scheduled: ["publishing", "cancelled"],
  publishing: ["published", "failed", "scheduled"],
  published: [],
  failed: [],
  cancelled: [],
};

export async function transitionPost(
  tx: Tx,
  p: {
    post: PostRow;
    to: PostStatus;
    /** Audit action suffix: `post.<action>`. */
    action: string;
    set?: Partial<typeof posts.$inferInsert>;
    audit: AuditFn;
    guardrail?: GuardrailResult | null;
    extra?: Record<string, unknown>;
  },
): Promise<PostRow> {
  const from = p.post.status;
  if (!POST_TRANSITIONS[from].includes(p.to)) {
    throw new CoreError("CONFLICT", `Post cannot move from ${from} to ${p.to}`);
  }
  const [row] = await tx
    .update(posts)
    .set({ ...p.set, status: p.to, updatedAt: new Date() })
    .where(and(eq(posts.id, p.post.id), eq(posts.status, from)))
    .returning();
  if (!row) throw new CoreError("CONFLICT", "Post changed while it was being updated");
  await p.audit({
    action: `post.${p.action}`,
    entityType: "post",
    entityId: row.id,
    before: { status: from, occurrence: p.post.occurrence },
    after: {
      status: row.status,
      ...postAuditFields(row, p.guardrail ?? (row.guardrailResult as GuardrailResult | null)),
      ...p.extra,
    },
  });
  return row;
}

export type PostCapabilities = {
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canReject: boolean;
  canSchedule: boolean;
  canCancel: boolean;
};

/** What `actor` may do with a post in this status; the UI shows buttons from these, not roles. */
export function postCapabilities(actor: Actor, status: PostStatus): PostCapabilities {
  const draft = roleHasPermission(actor.role, "review:draft");
  const approve = roleHasPermission(actor.role, "review:approve");
  const publish = roleHasPermission(actor.role, "review:publish");
  return {
    canEdit: draft && (status === "draft" || status === "blocked"),
    canSubmit: draft && status === "draft",
    canApprove: approve && status === "pending_approval",
    canReject: approve && status === "pending_approval",
    canSchedule: publish && status === "approved",
    canCancel:
      publish &&
      (status === "draft" ||
        status === "blocked" ||
        status === "pending_approval" ||
        status === "approved" ||
        status === "scheduled"),
  };
}
