import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locationGroupMembers, locations, profileChanges, profileChangeSets, users, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { CoreError } from "../errors";
import { PROFILE_FIELDS, snapshotFromJson, touchedNames, type ProfileValues } from "../profile/fields";
import { recordChangeSet } from "../profile/propose";
import { roleHasPermission } from "../permissions";
import { defineAction, type ActionContext } from "../registry";

const statusOut = z.enum(["open", "accepted", "reverted", "dismissed"]);
const valuesOut = z.object({
  fields: z.record(z.string(), z.unknown()),
  attributes: z.record(z.string(), z.unknown()),
});

const changeOut = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  workspaceId: z.string(),
  detectedAt: z.string(),
  source: z.enum(["nightly", "push", "manual"]),
  /** Profile field names (`description`), attribute ids (`attributes/has_wifi`) or Google mask entries. */
  fieldPaths: z.array(z.string()),
  before: valuesOut,
  after: valuesOut,
  /** Google, not the merchant side, changed what consumers see: `before` is ours, `after` is Google's. */
  googleSuggested: z.boolean(),
  status: statusOut,
  resolvedBy: z.string().nullable(),
  /** The resolver's display name (users.name); null while the change is open. */
  resolvedByName: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  revertChangeSetId: z.string().nullable(),
  revertChangeSetStatus: z.string().nullable(),
  /** Where the revert change set was drafted: ui, mcp (an agent over MCP), worker or cli. */
  revertChangeSetSurface: z.string().nullable(),
  can: z.object({ accept: z.boolean(), revert: z.boolean(), dismiss: z.boolean() }),
});

type Row = typeof profileChanges.$inferSelect;
type Joined = {
  change: Row;
  locationName: string;
  workspaceId: string;
  revertStatus: string | null;
  revertSurface: string | null;
  resolvedByName: string | null;
};

/** profile_changes with the location, the revert change set and the resolver, as both readers need. */
const selectJoined = (tx: Tx) =>
  tx
    .select({
      change: profileChanges,
      locationName: locations.name,
      workspaceId: locations.workspaceId,
      revertStatus: profileChangeSets.status,
      revertSurface: profileChangeSets.createdSurface,
      resolvedByName: users.name,
    })
    .from(profileChanges)
    .innerJoin(locations, eq(locations.id, profileChanges.locationId))
    .leftJoin(profileChangeSets, eq(profileChangeSets.id, profileChanges.revertChangeSetId))
    .leftJoin(users, eq(users.id, profileChanges.resolvedBy));

const iso = (d: Date | null) => d?.toISOString() ?? null;
const NOT_FOUND = () => new AccessError("NOT_FOUND", "Change not found");
/** A reverted change whose change set died can be reverted again. */
const DEAD_SET = ["cancelled", "failed", "blocked"];

function toOut(actor: Actor, j: Joined): z.input<typeof changeOut> {
  const c = j.change;
  const edit = roleHasPermission(actor.role, "profile:edit");
  const open = c.status === "open";
  const retryable = c.status === "reverted" && DEAD_SET.includes(j.revertStatus ?? "");
  return {
    id: c.id,
    locationId: c.locationId,
    locationName: j.locationName,
    workspaceId: j.workspaceId,
    detectedAt: c.detectedAt.toISOString(),
    source: c.source,
    fieldPaths: c.fieldPaths,
    before: c.before as ProfileValues,
    after: c.after as ProfileValues,
    googleSuggested: c.googleSuggested,
    status: c.status,
    resolvedBy: c.resolvedBy,
    resolvedByName: j.resolvedByName,
    resolvedAt: iso(c.resolvedAt),
    revertChangeSetId: c.revertChangeSetId,
    revertChangeSetStatus: j.revertStatus,
    revertChangeSetSurface: j.revertSurface,
    can: {
      accept: edit && open,
      dismiss: edit && open,
      revert: edit && !c.googleSuggested && (open || retryable),
    },
  };
}

async function loadChange(
  tx: Tx,
  actor: Actor,
  id: string,
  permission: Parameters<typeof authorize>[1],
  lock = true,
): Promise<Joined> {
  const q = selectJoined(tx).where(
    and(eq(profileChanges.id, id), eq(profileChanges.orgId, actor.orgId)),
  );
  const [row] = lock ? await q.for("update", { of: profileChanges }) : await q;
  if (!row) throw NOT_FOUND();
  const scope = workspaceScope(actor);
  if (scope !== "all" && !scope.includes(row.workspaceId)) throw NOT_FOUND();
  authorize(actor, permission, { workspaceId: row.workspaceId });
  return row;
}

export const profileChangesList = defineAction({
  name: "profile.changes.list",
  description:
    "Profile changes found by the change watch, newest first: nightly snapshot diffs (someone edited the profile outside OpenGMB) and Google-suggested edits (GOOGLE_UPDATE push; googleSuggested true, `before` is the merchant value, `after` what Google shows). Without locationId it covers every location in the caller's scope (the org-wide alerts inbox). Filters: workspaceId, locationId, groupId, status (open, accepted, reverted, dismissed), googleSuggested, fields (profile field names such as regularHours or websiteUri; a change matches when it touches any of them). total counts every match, past the limit. Each change has fieldPaths, before/after values of those fields, status and can.{accept,revert,dismiss}. limit 1-200 (default 100). Each change also names who resolved it (resolvedByName) and, for a revert, where its change set was drafted (revertChangeSetSurface: ui, or mcp for an agent).",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    groupId: z.uuid().optional(),
    status: statusOut.optional(),
    googleSuggested: z.boolean().optional(),
    fields: z.array(z.enum(PROFILE_FIELDS)).min(1).max(PROFILE_FIELDS.length).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  output: z.object({ changes: z.array(changeOut), total: z.number().int() }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const where = and(
      eq(profileChanges.orgId, actor.orgId),
      scope === "all" ? undefined : inArray(locations.workspaceId, scope),
      input.workspaceId ? eq(locations.workspaceId, input.workspaceId) : undefined,
      input.locationId ? eq(profileChanges.locationId, input.locationId) : undefined,
      input.groupId
        ? sql`${profileChanges.locationId} in (select ${locationGroupMembers.locationId} from ${locationGroupMembers} where ${locationGroupMembers.groupId} = ${input.groupId} and ${locationGroupMembers.orgId} = ${actor.orgId})`
        : undefined,
      input.status ? eq(profileChanges.status, input.status) : undefined,
      input.googleSuggested === undefined ? undefined : eq(profileChanges.googleSuggested, input.googleSuggested),
      input.fields
        ? sql`${profileChanges.fieldPaths} && array[${sql.join(input.fields.map((f) => sql`${f}`), sql`, `)}]::text[]`
        : undefined,
    );
    const rows = await selectJoined(tx)
      .where(where)
      .orderBy(desc(profileChanges.detectedAt), desc(profileChanges.id))
      .limit(input.limit);
    const [n] = await tx
      .select({ n: count() })
      .from(profileChanges)
      .innerJoin(locations, eq(locations.id, profileChanges.locationId))
      .where(where);
    return { changes: rows.map((r) => toOut(actor, r)), total: n?.n ?? 0 };
  },
});

async function resolve(
  tx: Tx,
  actor: Actor,
  audit: ActionContext["audit"],
  j: Joined,
  to: "accepted" | "dismissed" | "reverted",
  set: Partial<typeof profileChanges.$inferInsert> = {},
  extra: Record<string, unknown> = {},
): Promise<Joined> {
  const [row] = await tx
    .update(profileChanges)
    // A worker-surface revert is the L8 auto-revert: nobody resolved it by hand, so no resolver.
    .set({ status: to, resolvedBy: actor.surface === "worker" ? null : actor.userId, resolvedAt: new Date(), ...set })
    .where(and(eq(profileChanges.id, j.change.id), eq(profileChanges.status, j.change.status)))
    .returning();
  if (!row) throw new CoreError("CONFLICT", "Change was resolved while it was being updated");
  await audit({
    action: `profile.change_${to}`,
    entityType: "profile_change",
    entityId: row.id,
    before: { status: j.change.status },
    after: {
      status: to,
      locationId: row.locationId,
      googleSuggested: row.googleSuggested,
      fieldNames: row.fieldPaths,
      ...(actor.surface === "worker" ? { trigger: "auto_revert" } : {}),
      ...extra,
    },
  });
  if (actor.surface === "worker") return { ...j, change: row, resolvedByName: null };
  const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
  return { ...j, change: row, resolvedByName: me?.name ?? null };
}

function mustBeOpen(j: Joined) {
  if (j.change.status !== "open") {
    throw new CoreError(
      "CONFLICT",
      `Only an open change can be resolved (this one is ${j.change.status})`,
    );
  }
}

export const profileChangesAccept = defineAction({
  name: "profile.changes.accept",
  description:
    "Accept an open profile change: record that the new value is fine (open -> accepted). Nothing is written to Google. For a Google-suggested change this means keeping Google's value; note that Google keeps showing its own value as a difference from the merchant's profile until the profile is patched, which this build does not do on accept.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ change: changeOut }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const j = await loadChange(tx, actor, input.id, "profile:edit");
    mustBeOpen(j);
    return { change: toOut(actor, await resolve(tx, actor, audit, j, "accepted")) };
  },
});

export const profileChangesDismiss = defineAction({
  name: "profile.changes.dismiss",
  description:
    "Dismiss an open profile change without acting on it (open -> dismissed). Nothing is written to Google.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ change: changeOut }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const j = await loadChange(tx, actor, input.id, "profile:edit");
    mustBeOpen(j);
    return { change: toOut(actor, await resolve(tx, actor, audit, j, "dismissed")) };
  },
});

export const profileChangesRevert = defineAction({
  name: "profile.changes.revert",
  description:
    "Revert a profile change found by the nightly snapshot: creates a profile change set that restores the previous values of the changed fields (profile.changeSets.get shows it) and marks the change reverted. Nothing is written to Google here: the change set waits for approval (review:approve) and is applied by profile.apply with the usual conflict check, so if the field changed again on Google since the change was detected, that location fails with `conflict` and nothing is written. Not available for Google-suggested changes (the merchant value already equals the restored value): accept or dismiss those. A reverted change whose change set was cancelled, blocked or failed can be reverted again.",
  input: z.object({ id: z.uuid() }),
  output: z.object({
    change: changeOut,
    changeSetId: z.string(),
    changeSetStatus: z.string(),
  }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const j = await loadChange(tx, actor, input.id, "profile:edit");
    const c = j.change;
    if (c.googleSuggested) {
      throw new CoreError(
        "INVALID_INPUT",
        "A Google-suggested change cannot be reverted here: the profile already has the previous value. Accept or dismiss it.",
      );
    }
    if (!(
      c.status === "open" ||
      (c.status === "reverted" && DEAD_SET.includes(j.revertStatus ?? ""))
    )) {
      throw new CoreError("CONFLICT", `A ${c.status} change cannot be reverted`);
    }
    const [loc] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.id, c.locationId), eq(locations.orgId, actor.orgId)));
    if (!loc || loc.status !== "active") {
      throw new CoreError("INVALID_INPUT", "Unknown or inactive location for this workspace");
    }
    const restore = c.before as ProfileValues;
    const desired: ProfileValues = {
      fields: Object.fromEntries(
        c.fieldPaths.flatMap((p) => (p in restore.fields ? [[p, restore.fields[p as never]]] : [])),
      ),
      attributes: Object.fromEntries(
        c.fieldPaths.flatMap((p) => (p in restore.attributes ? [[p, restore.attributes[p]]] : [])),
      ),
    };
    if (touchedNames(desired).length === 0) {
      throw new CoreError(
        "INVALID_INPUT",
        "This change has no field that can be restored from here",
      );
    }
    // The baseline is what was on Google when the change was detected: the apply job's live read
    // must still match it, otherwise the location fails with `conflict` and nothing is written.
    const { row } = await recordChangeSet(tx, actor, audit, {
      workspaceId: loc.workspaceId,
      locs: [loc],
      desired,
      baseline: () => snapshotFromJson(c.after),
      auditExtra: { revertOfChangeId: c.id, ...(actor.surface === "worker" ? { trigger: "auto_revert" } : {}) },
    });
    const done = await resolve(
      tx,
      actor,
      audit,
      j,
      "reverted",
      { revertChangeSetId: row.id },
      { changeSetId: row.id },
    );
    return {
      change: toOut(actor, { ...done, revertStatus: row.status, revertSurface: row.createdSurface }),
      changeSetId: row.id,
      changeSetStatus: row.status,
    };
  },
});
