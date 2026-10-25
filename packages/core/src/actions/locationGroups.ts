import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locationGroupMembers, locationGroups, locations, workspaces, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { CoreError } from "../errors";
import { defineAction } from "../registry";

const groupOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  locationIds: z.array(z.string()),
});

const name = z.string().trim().min(1).max(100);

async function loadGroup(tx: Tx, actor: Actor, groupId: string) {
  const scope = workspaceScope(actor);
  const [g] = await tx
    .select()
    .from(locationGroups)
    .where(
      and(
        eq(locationGroups.id, groupId),
        eq(locationGroups.orgId, actor.orgId),
        scope === "all" ? undefined : inArray(locationGroups.workspaceId, scope),
      ),
    );
  if (!g) throw new AccessError("NOT_FOUND", "Location group not found");
  return g;
}

async function memberIds(tx: Tx, groupId: string) {
  const rows = await tx
    .select({ id: locationGroupMembers.locationId })
    .from(locationGroupMembers)
    .where(eq(locationGroupMembers.groupId, groupId));
  return rows.map((r) => r.id).sort();
}

export const locationGroupsList = defineAction({
  name: "locationGroups.list",
  description:
    "List location groups the caller can see (optionally one workspace), with member location ids. Groups are per workspace.",
  input: z.object({ workspaceId: z.uuid().optional() }),
  output: z.object({ groups: z.array(groupOut) }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const groups = await tx
      .select()
      .from(locationGroups)
      .where(
        and(
          eq(locationGroups.orgId, actor.orgId),
          scope === "all" ? undefined : inArray(locationGroups.workspaceId, scope),
          input.workspaceId ? eq(locationGroups.workspaceId, input.workspaceId) : undefined,
        ),
      )
      .orderBy(asc(locationGroups.name));
    const members = groups.length
      ? await tx
          .select()
          .from(locationGroupMembers)
          .where(
            inArray(
              locationGroupMembers.groupId,
              groups.map((g) => g.id),
            ),
          )
      : [];
    return {
      groups: groups.map((g) => ({
        id: g.id,
        workspaceId: g.workspaceId,
        name: g.name,
        locationIds: members
          .filter((m) => m.groupId === g.id)
          .map((m) => m.locationId)
          .sort(),
      })),
    };
  },
});

export const locationGroupsCreate = defineAction({
  name: "locationGroups.create",
  description: "Create a location group in a workspace. Names are unique per workspace.",
  input: z.object({ workspaceId: z.uuid(), name }),
  output: z.object({ group: groupOut }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "location:manage", { workspaceId: input.workspaceId });
    const [w] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
    const [row] = await tx
      .insert(locationGroups)
      .values({ orgId: actor.orgId, workspaceId: input.workspaceId, name: input.name })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new CoreError("CONFLICT", `Group "${input.name}" already exists`);
    await audit({
      action: "location_group.create",
      entityType: "location_group",
      entityId: row.id,
      before: null,
      after: row,
    });
    return { group: { id: row.id, workspaceId: row.workspaceId, name: row.name, locationIds: [] } };
  },
});

export const locationGroupsRename = defineAction({
  name: "locationGroups.rename",
  description: "Rename a location group. Names are unique per workspace.",
  input: z.object({ groupId: z.uuid(), name }),
  output: z.object({ group: groupOut }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const g = await loadGroup(tx, actor, input.groupId);
    const [row] = await tx
      .update(locationGroups)
      .set({ name: input.name })
      .where(
        and(
          eq(locationGroups.id, g.id),
          sql`not exists (select 1 from ${locationGroups} o where o.workspace_id = ${g.workspaceId} and o.name = ${input.name} and o.id <> ${g.id})`,
        ),
      )
      .returning();
    if (!row) throw new CoreError("CONFLICT", `Group "${input.name}" already exists`);
    await audit({
      action: "location_group.rename",
      entityType: "location_group",
      entityId: g.id,
      before: { name: g.name },
      after: { name: row.name },
    });
    return {
      group: {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        locationIds: await memberIds(tx, row.id),
      },
    };
  },
});

export const locationGroupsDelete = defineAction({
  name: "locationGroups.delete",
  description: "Delete a location group. Its locations are not deleted.",
  input: z.object({ groupId: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const g = await loadGroup(tx, actor, input.groupId);
    const members = await memberIds(tx, g.id);
    await tx.delete(locationGroups).where(eq(locationGroups.id, g.id));
    await audit({
      action: "location_group.delete",
      entityType: "location_group",
      entityId: g.id,
      before: { ...g, locationIds: members },
      after: null,
    });
    return { deleted: true };
  },
});

export const locationGroupsSetMembers = defineAction({
  name: "locationGroups.setMembers",
  description:
    "Replace a group's members with exactly these locations (empty clears it). Every location must be in the group's workspace, otherwise INVALID_INPUT and nothing changes.",
  input: z.object({ groupId: z.uuid(), locationIds: z.array(z.uuid()).max(500) }),
  output: z.object({ group: groupOut }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const g = await loadGroup(tx, actor, input.groupId);
    const wanted = [...new Set(input.locationIds)];
    if (wanted.length) {
      const ok = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            inArray(locations.id, wanted),
            eq(locations.orgId, actor.orgId),
            eq(locations.workspaceId, g.workspaceId),
          ),
        );
      if (ok.length !== wanted.length) {
        throw new CoreError("INVALID_INPUT", "Every location must exist in the group's workspace");
      }
    }
    const before = await memberIds(tx, g.id);
    await tx.delete(locationGroupMembers).where(eq(locationGroupMembers.groupId, g.id));
    if (wanted.length) {
      await tx
        .insert(locationGroupMembers)
        .values(wanted.map((locationId) => ({ groupId: g.id, locationId, orgId: actor.orgId })));
    }
    const after = wanted.slice().sort();
    await audit({
      action: "location_group.set_members",
      entityType: "location_group",
      entityId: g.id,
      before: { locationIds: before },
      after: { locationIds: after },
    });
    return { group: { id: g.id, workspaceId: g.workspaceId, name: g.name, locationIds: after } };
  },
});
