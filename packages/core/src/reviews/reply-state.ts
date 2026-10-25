import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { reviewReplies, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import type { Actor } from "../actor";
import { CoreError } from "../errors";
import type { GuardrailResult } from "../guardrails";
import { roleHasPermission } from "../permissions";
import type { ActionAuditEntry } from "../registry";

export type ReplyStatus = typeof reviewReplies.$inferSelect.status;
export type ReplyRow = typeof reviewReplies.$inferSelect;

/** Statuses that count as the review's single open revision (mirrors the partial unique index). */
export const OPEN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "blocked",
  "failed",
] as const;

/**
 * The reply state machine, the only place that says which status may follow which. Every status
 * change in the codebase goes through `transitionReply`, which checks this table.
 *   draft            -> blocked (submit, guardrail block) | pending_approval | approved (auto)
 *   blocked          -> draft (edit)
 *   pending_approval -> approved (approve) | draft (reject)
 *   approved         -> published | failed | blocked (publish job; guardrails run again)
 *                       | conflict (publish job found Google's reply changed since the draft)
 *   failed           -> approved (publish retry)
 *   published        -> superseded (a newer revision published) | deleted (Google reply removed)
 *   conflict         -> (terminal, NOT an open status: resolve by opening a new revision, which
 *                       snapshots Google's current reply as its base)
 */
export const TRANSITIONS: Record<ReplyStatus, readonly ReplyStatus[]> = {
  draft: ["blocked", "pending_approval", "approved"],
  blocked: ["draft"],
  pending_approval: ["approved", "draft"],
  approved: ["published", "failed", "blocked", "conflict"],
  failed: ["approved"],
  published: ["superseded", "deleted"],
  superseded: [],
  deleted: [],
  conflict: [],
};

export type AuditFn = (entry: ActionAuditEntry) => Promise<void>;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Audit rows for the worker (surface worker, system actor); the requesting user goes in `after`. */
export function workerAudit(tx: Tx, orgId: string): AuditFn {
  return async (entry) => {
    await writeAudit(tx, {
      ...entry,
      orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
    });
  };
}

/**
 * What an audit row may say about a reply: ids, statuses, revision, rule ids and severities, body
 * length and hash. NEVER the body, the review text, violation messages or matched text (blocked
 * drafts may contain patient details).
 */
export function replyAuditFields(
  reply: Pick<ReplyRow, "id" | "reviewId" | "revision" | "body">,
  guardrail?: GuardrailResult | null,
): Record<string, unknown> {
  return {
    replyId: reply.id,
    reviewId: reply.reviewId,
    revision: reply.revision,
    bodyLength: reply.body.length,
    bodySha256: sha256(reply.body),
    ...(guardrail
      ? {
          guardrail: {
            ok: guardrail.ok,
            violations: guardrail.violations.map((v) => ({
              ruleId: v.ruleId,
              severity: v.severity,
            })),
          },
        }
      : {}),
  };
}

/**
 * Move a reply from its current status to `to`: checks TRANSITIONS, updates the row only if it
 * still has the status we read (a concurrent change gives CONFLICT) and writes the
 * `review_reply.<action>` audit row. Returns the updated row.
 */
export async function transitionReply(
  tx: Tx,
  p: {
    reply: ReplyRow;
    to: ReplyStatus;
    /** Audit action suffix: `review_reply.<action>`. */
    action: string;
    set?: Partial<typeof reviewReplies.$inferInsert>;
    audit: AuditFn;
    guardrail?: GuardrailResult | null;
    /** Extra audit fields (ids, flags; never reply or review text). */
    extra?: Record<string, unknown>;
  },
): Promise<ReplyRow> {
  const from = p.reply.status;
  if (!TRANSITIONS[from].includes(p.to)) {
    throw new CoreError("CONFLICT", `Reply cannot move from ${from} to ${p.to}`);
  }
  const [row] = await tx
    .update(reviewReplies)
    .set({ ...p.set, status: p.to, updatedAt: new Date() })
    .where(and(eq(reviewReplies.id, p.reply.id), eq(reviewReplies.status, from)))
    .returning();
  if (!row) throw new CoreError("CONFLICT", "Reply changed while it was being updated");
  await p.audit({
    action: `review_reply.${p.action}`,
    entityType: "review_reply",
    entityId: row.id,
    before: { status: from, revision: row.revision },
    after: {
      status: row.status,
      ...replyAuditFields(row, p.guardrail ?? (row.guardrailResult as GuardrailResult | null)),
      ...p.extra,
    },
  });
  return row;
}

export type ReplyCapabilities = {
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canReject: boolean;
  canPublish: boolean;
};

/**
 * What `actor` may do with this reply right now, so the UI never decides from roles. Scope
 * (org, workspace, active location) is already enforced by the query that returned the reply.
 */
export function replyCapabilities(actor: Actor, status: ReplyStatus): ReplyCapabilities {
  const draft = roleHasPermission(actor.role, "review:draft");
  const approve = roleHasPermission(actor.role, "review:approve");
  const publish = roleHasPermission(actor.role, "review:publish");
  return {
    canEdit: draft && (status === "draft" || status === "blocked"),
    canSubmit: draft && status === "draft",
    canApprove: approve && status === "pending_approval",
    canReject: approve && status === "pending_approval",
    canPublish: publish && (status === "approved" || status === "failed"),
  };
}
