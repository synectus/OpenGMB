import { eq } from "drizzle-orm";
import { locations, profileChangeSets, profileChangeTargets, type Db } from "@opengmb/db";
import { assertPassed, guardrailSubject } from "../guardrails";
import { deferIfBlocked } from "../jobs";
import { clientFor, googleFailure } from "../reviews/reply-jobs";
import { workerAudit } from "../reviews/reply-state";
import { PROFILE_LIMITS } from "../config/profile-limits";
import {
  partState,
  snapshotFromGoogle,
  type PartState,
  type ProfileDiff,
  type ProfileValues,
} from "./fields";
import { blockedRuleIds, checkProfile } from "./guardrails";
import { publishProfileAttributes, publishProfileFields, type ProfileWriter } from "./publish";
import { transitionChangeSet, type ChangeSetRow } from "./state";

export const PROFILE_APPLY_QUEUE = "profile.apply";
/** Google errors are classified inside the job; pg-boss retries only unexpected errors. */
export const PROFILE_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 30, retryBackoff: true } as const;

export type ProfileApplyJob = { targetId: string };

/** Why a target ended as failed/skipped: a short code, never Google's body or profile text. */
export const PROFILE_REASONS = {
  conflict: "conflict",
  inactive: "location_inactive",
  unlinked: "location_not_linked_to_google",
  noConnection: "connection_removed",
  unexpected: "unexpected_error",
} as const;

type Outcome = { status: "applied" } | { status: "failed" | "skipped"; error: string };

/**
 * One short transaction: the target gets its outcome and an audit row (surface worker; names,
 * masks and reason codes only), then, if no target of the change set is pending any more, the
 * change set takes the aggregate status: applied (every changed target applied), partially_applied
 * (some did, some failed/skipped) or failed (none did).
 */
async function settleTarget(db: Db, targetId: string, outcome: Outcome): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx
      .select()
      .from(profileChangeTargets)
      .where(eq(profileChangeTargets.id, targetId))
      .for("update");
    if (!t || t.status !== "pending") return;
    const now = new Date();
    await tx
      .update(profileChangeTargets)
      .set(
        outcome.status === "applied"
          ? { status: "applied", appliedAt: now, error: null, updatedAt: now }
          : { status: outcome.status, error: outcome.error, updatedAt: now },
      )
      .where(eq(profileChangeTargets.id, t.id));
    const diff = t.diff as ProfileDiff;
    const audit = workerAudit(tx, t.orgId);
    await audit({
      action: `profile.target_${outcome.status}`,
      entityType: "profile_change_target",
      entityId: t.id,
      before: { status: "pending" },
      after: {
        status: outcome.status,
        changeSetId: t.changeSetId,
        locationId: t.locationId,
        updateMask: diff.updateMask,
        attributeMask: diff.attributeMask,
        ...("error" in outcome ? { error: outcome.error } : {}),
      },
    });

    const [cs] = await tx
      .select()
      .from(profileChangeSets)
      .where(eq(profileChangeSets.id, t.changeSetId))
      .for("update");
    if (!cs || cs.status !== "queued") return;
    const all = await tx
      .select({ status: profileChangeTargets.status })
      .from(profileChangeTargets)
      .where(eq(profileChangeTargets.changeSetId, cs.id));
    if (all.some((x) => x.status === "pending")) return;
    const counts = {
      applied: all.filter((x) => x.status === "applied").length,
      failed: all.filter((x) => x.status === "failed").length,
      skipped: all.filter((x) => x.status === "skipped").length,
      noChange: all.filter((x) => x.status === "no_change").length,
    };
    const notApplied = counts.failed + counts.skipped;
    const to: ChangeSetRow["status"] =
      counts.applied === 0 ? "failed" : notApplied === 0 ? "applied" : "partially_applied";
    await transitionChangeSet(tx, {
      changeSet: cs,
      to,
      action: to === "applied" ? "applied" : to === "failed" ? "failed" : "partially_applied",
      audit,
      extra: counts,
    });
  });
}

type Loaded = {
  cs: ChangeSetRow;
  target: typeof profileChangeTargets.$inferSelect;
  loc: typeof locations.$inferSelect;
};

async function load(db: Db, targetId: string): Promise<Loaded | null> {
  const [row] = await db
    .select({ target: profileChangeTargets, cs: profileChangeSets, loc: locations })
    .from(profileChangeTargets)
    .innerJoin(profileChangeSets, eq(profileChangeSets.id, profileChangeTargets.changeSetId))
    .innerJoin(locations, eq(locations.id, profileChangeTargets.locationId))
    .where(eq(profileChangeTargets.id, targetId));
  return row ?? null;
}

/**
 * Worker side of `profile.apply` for ONE target (one location of a change set). Steps, none of them
 * inside a long transaction:
 *   1. load the target; skip unless it is `pending` and the change set `queued`; an inactive or
 *      unlinked location is skipped;
 *   2. Google reads (location fields and/or attributes, only the parts this target changes) and the
 *      CONFLICT check, per part: live values equal the stored `after` -> already applied (a retry
 *      after Google applied our write; nothing is sent); equal the stored `before` -> clear to
 *      write; anything else -> the target fails `conflict` and NOTHING is written (someone edited
 *      the profile on Google since the preview);
 *   3. guardrails again on the stored `after`, then `assertPassed` (a block fails the target);
 *   4. the guarded writes in `publish.ts` through the throttled client (per-location edit bucket,
 *      idempotency keys `profile:<changeSetId>:<locationId>[:attributes]`), minimal masks from the
 *      stored diff;
 *   5. one short transaction: target outcome + audit + change set aggregate.
 * A Google 4xx/429 fails only this target (`google_http_<n>`; `attributes_failed:<code>` if the
 * location fields were already written); other errors leave it pending and the job throws so
 * pg-boss retries (idempotency keys and the already-applied check prevent a second write), and on
 * the final attempt the target fails. Safe to re-run.
 */
export async function processProfileApply(
  db: Db,
  job: ProfileApplyJob,
  deps: { client?: ProfileWriter; isFinalAttempt?: boolean } = {},
): Promise<"applied" | "failed" | "skipped" | "ignored"> {
  const loaded = await load(db, job.targetId);
  if (!loaded || loaded.target.status !== "pending" || loaded.cs.status !== "queued") {
    return "ignored";
  }
  const { target, loc, cs } = loaded;
  // AP3b: suspended or deleted. The target stays `pending` and the change set `queued`; the job is re-queued for later.
  if (await deferIfBlocked(db, target.orgId, PROFILE_APPLY_QUEUE, job)) return "ignored";
  const settle = async (o: Outcome) => {
    await settleTarget(db, target.id, o);
    return o.status;
  };
  if (loc.status !== "active")
    return settle({ status: "skipped", error: PROFILE_REASONS.inactive });
  if (!loc.googleLocationId) {
    return settle({ status: "skipped", error: PROFILE_REASONS.unlinked });
  }
  const client = deps.client ?? (await clientFor(db, target.orgId, loc.connectionId));
  if (!client) return settle({ status: "failed", error: PROFILE_REASONS.noConnection });

  const diff = target.diff as ProfileDiff;
  const before = target.before as ProfileValues;
  const after = target.after as ProfileValues;
  const where = {
    orgId: target.orgId,
    changeSetId: cs.id,
    locationId: loc.id,
    locationName: loc.googleLocationId,
  };

  let step = "read";
  try {
    // 2. live values and the conflict check, per part
    const needFields = diff.updateMask.length > 0;
    const needAttrs = diff.attributeMask.length > 0;
    const liveLoc = needFields
      ? await client.getLocation(loc.googleLocationId, { readMask: PROFILE_LIMITS.readMask })
      : null;
    const liveAttrs = needAttrs
      ? await client.getAttributes(`${loc.googleLocationId}/attributes`)
      : null;
    const live = snapshotFromGoogle(
      liveLoc ?? { name: loc.googleLocationId, title: "" },
      liveAttrs,
    );
    const states: Record<"fields" | "attributes", PartState | "none"> = {
      fields: needFields ? partState(live, before, after, "fields") : "none",
      attributes: needAttrs ? partState(live, before, after, "attributes") : "none",
    };
    if (states.fields === "conflict" || states.attributes === "conflict") {
      return settle({ status: "failed", error: PROFILE_REASONS.conflict });
    }
    const todo = {
      fields: states.fields === "clear",
      attributes: states.attributes === "clear",
    };
    if (!todo.fields && !todo.attributes) return settle({ status: "applied" });

    // 3. guardrails again, on exactly what will be sent
    const { ctx, result } = checkProfile(after, { name: loc.title ?? loc.name, phone: loc.phone }, before);
    if (!result.ok) {
      return settle({
        status: "failed",
        error: `guardrail_blocked:${blockedRuleIds(result).join(",")}`,
      });
    }
    const passed = assertPassed(result, guardrailSubject(ctx));

    // 4. the guarded writes
    step = "fields";
    if (todo.fields) await publishProfileFields(client, where, after, diff.updateMask, passed);
    step = "attributes";
    if (todo.attributes) {
      await publishProfileAttributes(client, where, after, diff.attributeMask, passed);
    }
    return settle({ status: "applied" });
  } catch (e) {
    const reason = googleFailure(e);
    if (reason) {
      return settle({
        status: "failed",
        error:
          step === "attributes" && diff.updateMask.length > 0
            ? `attributes_failed:${reason}`
            : reason,
      });
    }
    if (deps.isFinalAttempt) return settle({ status: "failed", error: PROFILE_REASONS.unexpected });
    throw e;
  }
}
