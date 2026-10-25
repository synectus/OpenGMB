import { and, eq, gt, notInArray } from "drizzle-orm";
import {
  locationAutoRevert,
  profileChangeSets,
  profileChanges,
  type Db,
  type Tx,
} from "@opengmb/db";
import { loadActor } from "../actor";
import { assertWritable } from "../billing";
import { CoreError } from "../errors";
import { roleHasPermission } from "../permissions";
import { workerAudit } from "../reviews/reply-state";
import { describeVoiceOfMerchant } from "../verification/state";
import type { GoogleClient } from "../google/client";
import { same, type ProfileValues } from "./fields";

/** L8: the three switches and the profile fields each one protects (serviceArea/businessType is not one). */
export const AUTO_REVERT_FIELDS = {
  name: "title",
  phone: "phoneNumbers",
  address: "storefrontAddress",
} as const;
export const AUTO_REVERT_WINDOW_MS = 24 * 3_600_000;

export type AutoRevertPlan = { fields: ReadonlySet<string>; enabledBy: string };
export type AutoRevertReader = Pick<GoogleClient, "getVoiceOfMerchantState">;

/**
 * Before the snapshot transaction (it reads Google): the protected fields this location may undo
 * tonight, or null. Null when nothing is switched on, nobody is recorded as having enabled it, or the
 * location is not in good standing (suspended, under review, unverified, ownership conflict) or its
 * standing cannot be read: a profile in that state is not touched.
 */
export async function planAutoRevert(
  db: Db,
  loc: { id: string; googleLocationId: string },
  client: AutoRevertReader,
): Promise<AutoRevertPlan | null> {
  const [s] = await db.select().from(locationAutoRevert).where(eq(locationAutoRevert.locationId, loc.id));
  if (!s || !s.enabledBy) return null;
  const fields = new Set<string>();
  for (const k of Object.keys(AUTO_REVERT_FIELDS) as (keyof typeof AUTO_REVERT_FIELDS)[]) {
    if (s[k]) fields.add(AUTO_REVERT_FIELDS[k]);
  }
  if (fields.size === 0) return null;
  try {
    const standing = describeVoiceOfMerchant(await client.getVoiceOfMerchantState(loc.googleLocationId));
    if (standing.standing !== "good_standing") return null;
  } catch {
    return null;
  }
  return { fields, enabledBy: s.enabledBy };
}

/**
 * Inside the snapshot transaction: of `candidates` (enabled fields that just changed), those that may
 * be undone now. Dropped: a field already auto-reverted in the last 24 h (stops a fight with another
 * tool; a revert whose change set died wrote nothing and does not count), and a field whose new value
 * is the one Google is suggesting in an open suggestion (Google's own edit, which the owner decides on).
 */
export async function eligibleFields(
  tx: Tx,
  locationId: string,
  candidates: { path: string; after: unknown }[],
  now: Date,
): Promise<Set<string>> {
  const since = new Date(now.getTime() - AUTO_REVERT_WINDOW_MS);
  const recent = await tx
    .select({ fieldPaths: profileChanges.fieldPaths })
    .from(profileChanges)
    .innerJoin(profileChangeSets, eq(profileChangeSets.id, profileChanges.revertChangeSetId))
    .where(
      and(
        eq(profileChanges.locationId, locationId),
        eq(profileChangeSets.createdSurface, "worker"),
        gt(profileChangeSets.createdAt, since),
        notInArray(profileChangeSets.status, ["cancelled", "failed", "blocked"]),
      ),
    );
  const used = new Set(recent.flatMap((r) => r.fieldPaths));
  const suggested = await tx
    .select({ after: profileChanges.after })
    .from(profileChanges)
    .where(
      and(
        eq(profileChanges.locationId, locationId),
        eq(profileChanges.googleSuggested, true),
        eq(profileChanges.status, "open"),
      ),
    );
  const out = new Set<string>();
  for (const c of candidates) {
    if (used.has(c.path)) continue;
    const isGoogles = suggested.some((g) => {
      const f = (g.after as ProfileValues).fields as Record<string, unknown>;
      return c.path in f && same(f[c.path], c.after);
    });
    if (!isGoogles) out.add(c.path);
  }
  return out;
}

/**
 * After the snapshot transaction committed: undo `changeId` through the existing actions
 * (profile.changes.revert -> profile.approve -> profile.apply) as a worker-surface actor loaded for
 * the person who enabled the setting, whose approval stands in. Nothing here throws: any failure
 * leaves the Changes alert open for a person, and a `profile.auto_revert_*` audit row says why
 * (reason codes and field names only).
 */
export async function runAutoRevert(
  db: Db,
  p: { orgId: string; locationId: string; changeId: string; enabledBy: string; fieldNames: string[] },
): Promise<"reverted" | "not_reverted"> {
  const note = async (action: string, extra: Record<string, unknown>) => {
    await db.transaction((tx) =>
      workerAudit(tx, p.orgId)({
        action,
        entityType: "profile_change",
        entityId: p.changeId,
        after: {
          locationId: p.locationId,
          trigger: "auto_revert",
          enabledBy: p.enabledBy,
          fieldNames: p.fieldNames,
          ...extra,
        },
      }),
    );
  };
  try {
    // actorType "system" is exempt from the read-only plan check, so make it explicitly.
    await db.transaction((tx) =>
      assertWritable(tx, { actorType: "user", orgId: p.orgId }, "profile.changes.revert", new Date()),
    );
    const actor = await loadActor(db, {
      userId: p.enabledBy,
      orgId: p.orgId,
      surface: "worker",
      actorType: "system",
    }).catch(() => null);
    if (
      !actor ||
      !roleHasPermission(actor.role, "profile:edit") ||
      !roleHasPermission(actor.role, "review:approve")
    ) {
      await note("profile.auto_revert_skipped", { reason: "enabler_cannot_approve" });
      return "not_reverted";
    }
    // Dynamic: the executor imports every action, and the actions import this file's callers.
    const { executeAction } = await import("../executor");
    const rev = (await executeAction(db, actor, "profile.changes.revert", { id: p.changeId })) as {
      changeSetId: string;
      changeSetStatus: string;
    };
    if (rev.changeSetStatus !== "pending_approval") {
      await note("profile.auto_revert_skipped", {
        reason: `change_set_${rev.changeSetStatus}`,
        changeSetId: rev.changeSetId,
      });
      return "not_reverted";
    }
    await executeAction(db, actor, "profile.approve", { id: rev.changeSetId });
    await executeAction(db, actor, "profile.apply", { id: rev.changeSetId });
    await note("profile.change_auto_reverted", { changeSetId: rev.changeSetId });
    return "reverted";
  } catch (e) {
    await note("profile.auto_revert_failed", {
      reason: e instanceof CoreError ? e.code : "unexpected_error",
    }).catch(() => undefined);
    return "not_reverted";
  }
}
