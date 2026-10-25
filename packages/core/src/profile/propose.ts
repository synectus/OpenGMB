import { profileChangeSets, profileChangeTargets, type locations, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { notifyApprovalRequested } from "../approvals";
import { CoreError } from "../errors";
import type { GuardrailResult } from "../guardrails";
import type { ActionContext } from "../registry";
import { computeDiff, type ProfileSnapshot, type ProfileValues } from "./fields";
import { checkProfile, mergeResults } from "./guardrails";
import { transitionChangeSet, type ChangeSetRow } from "./state";

type LocRow = typeof locations.$inferSelect;

/**
 * The write half of profile.propose, shared with profile.changes.revert: diff `desired` against the
 * baseline snapshot of each location, run the guardrails on every changing location, store the
 * change set with one target per location and move it to `pending_approval` (or `blocked` on a
 * block-severity violation). Nothing is sent to Google. The caller has already checked access and
 * that all `locs` are active locations of `workspaceId`.
 */
export async function recordChangeSet(
  tx: Tx,
  actor: Actor,
  audit: ActionContext["audit"],
  p: {
    workspaceId: string;
    locs: LocRow[];
    desired: ProfileValues;
    baseline: (loc: LocRow) => ProfileSnapshot;
    /** Per-location desired values (e.g. a merged list); `desired` is still what the change set stores. */
    desiredFor?: (snapshot: ProfileSnapshot, loc: LocRow) => ProfileValues;
    /** Extra audit fields for the proposal row (ids, counts; never values). */
    auditExtra?: Record<string, unknown>;
  },
): Promise<{ row: ChangeSetRow; result: GuardrailResult }> {
  const planned = p.locs.map((loc) => {
    const baseline = p.baseline(loc);
    const diff = computeDiff(baseline, p.desiredFor ? p.desiredFor(baseline, loc) : p.desired);
    const guard =
      diff.changes.length > 0
        ? checkProfile(diff.after, { name: loc.title ?? loc.name, phone: loc.phone }, diff.before).result
        : null;
    return { loc, diff, guard };
  });
  if (planned.every((x) => x.diff.changes.length === 0)) {
    throw new CoreError("INVALID_INPUT", "No location would change; nothing to propose");
  }
  const result = mergeResults(planned.flatMap((x) => (x.guard ? [x.guard] : [])));
  const mask = [
    ...new Set(planned.flatMap((x) => [...x.diff.updateMask, ...x.diff.attributeMask])),
  ];
  const now = new Date();
  const [cs] = await tx
    .insert(profileChangeSets)
    .values({
      orgId: actor.orgId,
      workspaceId: p.workspaceId,
      createdBy: actor.userId,
      createdSurface: actor.surface === "worker" ? "worker" : actor.surface,
      status: "draft",
      fields: p.desired,
      updateMask: mask.sort(),
      guardrailResult: result,
      updatedAt: now,
    })
    .returning();
  await tx.insert(profileChangeTargets).values(
    planned.map(({ loc, diff }) => ({
      changeSetId: cs!.id,
      orgId: actor.orgId,
      locationId: loc.id,
      status: diff.changes.length === 0 ? ("no_change" as const) : ("pending" as const),
      before: diff.before,
      after: diff.after,
      diff,
      updatedAt: now,
    })),
  );
  const row = await transitionChangeSet(tx, {
    changeSet: cs!,
    to: result.ok ? "pending_approval" : "blocked",
    action: result.ok ? "proposed" : "blocked",
    set: result.ok ? { submittedAt: now } : {},
    audit,
    guardrail: result,
    extra: {
      stage: "propose",
      locationCount: planned.length,
      changingLocations: planned.filter((x) => x.diff.changes.length > 0).length,
      ...p.auditExtra,
    },
  });
  if (row.status === "pending_approval") {
    await notifyApprovalRequested(tx, audit, {
      orgId: actor.orgId,
      workspaceId: p.workspaceId,
      type: "changeset",
      id: row.id,
      submittedAt: now,
    });
  }
  return { row, result };
}
