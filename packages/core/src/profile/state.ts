import { and, eq } from "drizzle-orm";
import { profileChangeSets, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { canonicalJson } from "../audit";
import { CoreError } from "../errors";
import type { GuardrailResult } from "../guardrails";
import { roleHasPermission } from "../permissions";
import type { AuditFn } from "../reviews/reply-state";
import { sha256 } from "../reviews/reply-state";
import { touchedNames, type ProfileValues } from "./fields";

export type ChangeSetRow = typeof profileChangeSets.$inferSelect;
export type ChangeSetStatus = ChangeSetRow["status"];

/**
 * The change set state machine; every status change goes through `transitionChangeSet`.
 *   draft            -> blocked | pending_approval | cancelled   (propose uses blocked / pending_approval)
 *   blocked          -> cancelled
 *   pending_approval -> approved | cancelled                      (reject = cancelled with a reason)
 *   approved         -> queued (apply) | cancelled
 *   queued           -> applied | partially_applied | failed      (aggregated from the targets)
 *   applied, partially_applied, failed, cancelled: terminal
 */
export const CHANGE_SET_TRANSITIONS: Record<ChangeSetStatus, readonly ChangeSetStatus[]> = {
  draft: ["blocked", "pending_approval", "cancelled"],
  blocked: ["cancelled"],
  pending_approval: ["approved", "cancelled"],
  approved: ["queued", "cancelled"],
  queued: ["applied", "partially_applied", "failed"],
  applied: [],
  partially_applied: [],
  failed: [],
  cancelled: [],
};

/**
 * What an audit row may say about a change set: ids, status, field and attribute NAMES, the mask,
 * counts, a sha256 of the desired values and rule ids. DECISION: never the values themselves.
 * Profile text is business information, not patient data, and the values are kept in
 * `profile_change_sets.fields` and the targets; but the audit log is append-only and hash-chained,
 * so nothing in it can ever be redacted, and keeping values out matches reply and post audits.
 */
export function profileAuditFields(
  cs: Pick<ChangeSetRow, "id" | "workspaceId" | "fields" | "updateMask">,
  guardrail?: GuardrailResult | null,
): Record<string, unknown> {
  const values = cs.fields as ProfileValues;
  return {
    changeSetId: cs.id,
    workspaceId: cs.workspaceId,
    fieldNames: touchedNames(values),
    updateMask: cs.updateMask,
    fieldsSha256: sha256(canonicalJson(values)),
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

export async function transitionChangeSet(
  tx: Tx,
  p: {
    changeSet: ChangeSetRow;
    to: ChangeSetStatus;
    /** Audit action suffix: `profile.<action>`. */
    action: string;
    set?: Partial<typeof profileChangeSets.$inferInsert>;
    audit: AuditFn;
    guardrail?: GuardrailResult | null;
    extra?: Record<string, unknown>;
  },
): Promise<ChangeSetRow> {
  const from = p.changeSet.status;
  if (!CHANGE_SET_TRANSITIONS[from].includes(p.to)) {
    throw new CoreError("CONFLICT", `Change set cannot move from ${from} to ${p.to}`);
  }
  const [row] = await tx
    .update(profileChangeSets)
    .set({ ...p.set, status: p.to, updatedAt: new Date() })
    .where(and(eq(profileChangeSets.id, p.changeSet.id), eq(profileChangeSets.status, from)))
    .returning();
  if (!row) throw new CoreError("CONFLICT", "Change set changed while it was being updated");
  await p.audit({
    action: `profile.${p.action}`,
    entityType: "profile_change_set",
    entityId: row.id,
    before: { status: from },
    after: {
      status: row.status,
      ...profileAuditFields(row, p.guardrail ?? (row.guardrailResult as GuardrailResult | null)),
      ...p.extra,
    },
  });
  return row;
}

export type ChangeSetCapabilities = {
  canApprove: boolean;
  canReject: boolean;
  canApply: boolean;
  canCancel: boolean;
};

/** What `actor` may do with a change set in this status; the UI shows buttons from these. */
export function changeSetCapabilities(
  actor: Actor,
  status: ChangeSetStatus,
): ChangeSetCapabilities {
  const edit = roleHasPermission(actor.role, "profile:edit");
  const approve = roleHasPermission(actor.role, "review:approve");
  return {
    canApprove: approve && status === "pending_approval",
    canReject: approve && status === "pending_approval",
    canApply: edit && status === "approved",
    canCancel:
      edit &&
      (status === "draft" ||
        status === "blocked" ||
        status === "pending_approval" ||
        status === "approved"),
  };
}
