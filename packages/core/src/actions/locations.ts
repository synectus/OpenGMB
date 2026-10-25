import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  googleConnections,
  locationGroupMembers,
  locationGroups,
  locationImports,
  locations,
  locationStatus,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { createGoogleClient } from "../google/factory";
import { enqueueJob } from "../jobs";
import { fetchAllLocations, addressSummary } from "../locations/google";
import { IMPORT_MAX_LOCATIONS, LOCATION_IMPORT_QUEUE, importItem, importResult } from "../locations/import";
import { locationStats } from "../locations/stats";
import { defineAction } from "../registry";

const statusEnum = z.enum(locationStatus);

const locationOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  phone: z.string().nullable(),
  addressSummary: z.string().nullable(),
  googleLocationId: z.string().nullable(),
  googleAccountName: z.string().nullable(),
  status: statusEnum,
  importedAt: z.string().nullable(),
  /** Google was disconnected (connection_id cleared) and the location has not been re-imported yet. */
  needsRelink: z.boolean(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** Where-clause fragment limiting a locations query to the org and the actor's workspaces. */
export function locationScope(actor: Actor) {
  const scope = workspaceScope(actor);
  return scope === "all"
    ? eq(locations.orgId, actor.orgId)
    : and(eq(locations.orgId, actor.orgId), inArray(locations.workspaceId, scope));
}

async function requireWorkspace(tx: Tx, actor: Actor, workspaceId: string) {
  authorize(actor, "location:manage", { workspaceId });
  const [w] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
}

export const locationsList = defineAction({
  name: "locations.list",
  description:
    "List locations the caller can see, newest first, with their groups. needsRelink is true when Google was disconnected and the location must be re-imported to re-link it. Optional filters: workspaceId, groupId, status (active|inactive). Optional locationIds (up to 500) for specific locations. Client roles only see their own workspaces.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    groupId: z.uuid().optional(),
    status: statusEnum.optional(),
    locationIds: z.array(z.uuid()).min(1).max(500).optional(),
  }),
  output: z.object({ locations: z.array(locationOut) }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const rows = await tx
      .select()
      .from(locations)
      .where(
        and(
          locationScope(actor),
          input.workspaceId ? eq(locations.workspaceId, input.workspaceId) : undefined,
          input.status ? eq(locations.status, input.status) : undefined,
          input.locationIds ? inArray(locations.id, input.locationIds) : undefined,
          input.groupId
            ? sql`${locations.id} in (select ${locationGroupMembers.locationId} from ${locationGroupMembers} where ${locationGroupMembers.groupId} = ${input.groupId} and ${locationGroupMembers.orgId} = ${actor.orgId})`
            : undefined,
        ),
      )
      .orderBy(asc(locations.name), asc(locations.id));
    const memberships = rows.length
      ? await tx
          .select({
            locationId: locationGroupMembers.locationId,
            id: locationGroups.id,
            name: locationGroups.name,
          })
          .from(locationGroupMembers)
          .innerJoin(locationGroups, eq(locationGroups.id, locationGroupMembers.groupId))
          .where(
            and(
              eq(locationGroupMembers.orgId, actor.orgId),
              inArray(
                locationGroupMembers.locationId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(locationGroups.name))
      : [];
    return {
      locations: rows.map((l) => ({
        id: l.id,
        workspaceId: l.workspaceId,
        name: l.name,
        title: l.title,
        phone: l.phone,
        addressSummary: l.addressSummary,
        googleLocationId: l.googleLocationId,
        googleAccountName: l.googleAccountName,
        status: l.status,
        importedAt: l.importedAt?.toISOString() ?? null,
        needsRelink: l.connectionId === null && l.googleLocationId !== null,
        groups: memberships
          .filter((m) => m.locationId === l.id)
          .map((m) => ({ id: m.id, name: m.name })),
      })),
    };
  },
});

const statsOut = z.object({
  locationId: z.string(),
  reviews: z.object({
    total: z.number(),
    avgRating: z.number().nullable(),
    unreplied: z.number(),
    /** Reviews whose approved reply is not yet on Google. */
    waitingToPublish: z.number(),
  }),
  openChanges: z.number(),
  suspensionOpen: z.boolean(),
});

export const locationsStats = defineAction({
  name: "locations.stats",
  description:
    "Per-location counts from OpenGMB's own tables, no Google call: synced reviews (total, average star rating, unreplied = reviews that need you: no visible reply and none waiting for approval or publish, or a reply that is blocked or failed, with the workspace reply policy applied, any age; waitingToPublish = approved reply not yet on Google), open profile changes (the alerts the change watch raised: snapshot diffs and Google-suggested edits) and whether a suspension case is open or appealed. Same order as locations.list (by name). Filters: workspaceId, locationIds (up to 500). Inactive locations are included. Client roles only see their own workspaces; ids outside the caller's scope are left out.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).min(1).max(500).optional(),
  }),
  output: z.object({ locations: z.array(statsOut) }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const rows = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          locationScope(actor),
          input.workspaceId ? eq(locations.workspaceId, input.workspaceId) : undefined,
          input.locationIds ? inArray(locations.id, input.locationIds) : undefined,
        ),
      )
      .orderBy(asc(locations.name), asc(locations.id));
    return { locations: await locationStats(tx, actor.orgId, rows.map((r) => r.id)) };
  },
});

const availableLocation = z.object({
  locationName: z.string(),
  title: z.string(),
  phone: z.string().nullable(),
  addressSummary: z.string().nullable(),
  /** Active in this org (workspace shown) or in some other org (workspace never shown). */
  alreadyImported: z.boolean(),
  importedWorkspace: z.object({ id: z.string(), name: z.string() }).nullable(),
  activeInAnotherOrg: z.boolean(),
  /** Imported here but its Google connection was removed: select it to re-link. */
  needsRelink: z.boolean(),
});

export const locationsListAvailable = defineAction({
  name: "locations.listAvailable",
  description:
    "List the Google accounts and locations reachable through one of the organization's Google connections, each marked alreadyImported (with the workspace when it is in this organization; activeInAnotherOrg when another organization holds it active). Calls Google, so it runs outside any database transaction. Follows up to 20 pages of 100 per account; truncated is true if there were more.",
  input: z.object({ connectionId: z.uuid() }),
  output: z.object({
    accounts: z.array(
      z.object({
        accountName: z.string(),
        displayName: z.string(),
        truncated: z.boolean(),
        locations: z.array(availableLocation),
      }),
    ),
  }),
  permission: "location:manage",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const [conn] = await db
      .select()
      .from(googleConnections)
      .where(
        and(eq(googleConnections.id, input.connectionId), eq(googleConnections.orgId, actor.orgId)),
      );
    if (!conn) throw new AccessError("NOT_FOUND", "Google connection not found");

    const client = createGoogleClient({ db, connection: conn });
    const { accounts } = await client.listAccounts();
    const fetched = [];
    for (const a of accounts) {
      fetched.push({ account: a, ...(await fetchAllLocations(client, a.name)) });
    }

    const ids = fetched.flatMap((f) => f.locations.map((l) => l.name));
    const active = ids.length
      ? await db
          .select({
            googleLocationId: locations.googleLocationId,
            orgId: locations.orgId,
            workspaceId: workspaces.id,
            workspaceName: workspaces.name,
            connectionId: locations.connectionId,
          })
          .from(locations)
          .innerJoin(workspaces, eq(workspaces.id, locations.workspaceId))
          .where(and(inArray(locations.googleLocationId, ids), eq(locations.status, "active")))
      : [];

    return {
      accounts: fetched.map((f) => ({
        accountName: f.account.name,
        displayName: f.account.accountName,
        truncated: f.truncated,
        locations: f.locations.map((l) => {
          const mine = active.find((a) => a.googleLocationId === l.name && a.orgId === actor.orgId);
          const other = active.some(
            (a) => a.googleLocationId === l.name && a.orgId !== actor.orgId,
          );
          return {
            locationName: l.name,
            title: l.title,
            phone: l.phoneNumbers?.primaryPhone ?? null,
            addressSummary: addressSummary(l),
            alreadyImported: !!mine || other,
            importedWorkspace: mine ? { id: mine.workspaceId, name: mine.workspaceName } : null,
            activeInAnotherOrg: other,
            needsRelink: !!mine && !mine.connectionId,
          };
        }),
      })),
    };
  },
});

export const locationsImport = defineAction({
  name: "locations.import",
  description:
    "Import Google locations into a workspace. Asynchronous: records the request and queues a worker job that fetches the details from Google itself (client-supplied details are never trusted) and creates the locations. Returns importId; poll locations.importStatus for per-location results (imported, already_imported, relinked, exists_inactive, conflict, not_found). A location already active in this workspace whose Google connection was removed is re-linked to the importing connection (relinked). A location already active in another organization or workspace is reported as conflict.",
  input: z.object({
    connectionId: z.uuid(),
    workspaceId: z.uuid(),
    locations: z.array(importItem).min(1).max(IMPORT_MAX_LOCATIONS),
  }),
  output: z.object({ importId: z.string(), jobId: z.string(), queued: z.boolean() }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    await requireWorkspace(tx, actor, input.workspaceId);
    const [conn] = await tx
      .select({ id: googleConnections.id })
      .from(googleConnections)
      .where(
        and(eq(googleConnections.id, input.connectionId), eq(googleConnections.orgId, actor.orgId)),
      );
    if (!conn) throw new AccessError("NOT_FOUND", "Google connection not found");

    const [req] = await tx
      .insert(locationImports)
      .values({
        orgId: actor.orgId,
        workspaceId: input.workspaceId,
        connectionId: conn.id,
        requestedBy: actor.userId,
        items: input.locations,
      })
      .returning();
    const jobId = await enqueueJob(tx, LOCATION_IMPORT_QUEUE, { importId: req!.id });
    await audit({
      action: "location_import.requested",
      entityType: "location_import",
      entityId: req!.id,
      before: null,
      after: {
        workspaceId: input.workspaceId,
        connectionId: conn.id,
        locations: input.locations,
        jobId,
      },
    });
    return { importId: req!.id, jobId, queued: true };
  },
});

export const locationsImportStatus = defineAction({
  name: "locations.importStatus",
  description:
    "Status of a locations.import request: pending, done (with per-location results) or failed (with a reason).",
  input: z.object({ importId: z.uuid() }),
  output: z.object({
    status: z.enum(["pending", "done", "failed"]),
    results: z.array(importResult).nullable(),
    error: z.string().nullable(),
  }),
  permission: "location:manage",
  kind: "read",
  async handler({ tx, actor }, input) {
    const [req] = await tx
      .select()
      .from(locationImports)
      .where(and(eq(locationImports.id, input.importId), eq(locationImports.orgId, actor.orgId)));
    if (!req) throw new AccessError("NOT_FOUND", "Import not found");
    const failed = req.status === "failed";
    return {
      status: req.status,
      results: req.status === "done" ? z.array(importResult).parse(req.results) : null,
      error: failed ? String((req.results as { error?: unknown } | null)?.error ?? "failed") : null,
    };
  },
});

export const locationsSetStatus = defineAction({
  name: "locations.setStatus",
  description:
    "Activate or deactivate up to 100 locations. Returns a result per location: updated, unchanged, conflict (activating a location whose Google location is active elsewhere, in any organization) or not_found. Inactive locations are excluded from sync, webhook processing, the inbox and the bulk tool.",
  input: z.object({ locationIds: z.array(z.uuid()).min(1).max(100), status: statusEnum }),
  output: z.object({
    results: z.array(
      z.object({
        locationId: z.string(),
        result: z.enum(["updated", "unchanged", "conflict", "not_found"]),
      }),
    ),
  }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const rows = await tx
      .select()
      .from(locations)
      .where(and(locationScope(actor), inArray(locations.id, input.locationIds)));
    const results: {
      locationId: string;
      result: "updated" | "unchanged" | "conflict" | "not_found";
    }[] = [];
    for (const id of [...new Set(input.locationIds)]) {
      const row = rows.find((r) => r.id === id);
      let result: (typeof results)[number]["result"];
      if (!row) result = "not_found";
      else if (row.status === input.status) result = "unchanged";
      else {
        result = "updated";
        if (input.status === "active" && row.googleLocationId) {
          const [other] = await tx
            .select({ id: locations.id })
            .from(locations)
            .where(
              and(
                eq(locations.googleLocationId, row.googleLocationId),
                eq(locations.status, "active"),
                ne(locations.id, row.id),
              ),
            );
          if (other) result = "conflict";
        }
        if (result === "updated") {
          try {
            // Savepoint: losing a race to the unique index must not abort the whole batch.
            await tx.transaction(async (sp) => {
              await sp
                .update(locations)
                .set({ status: input.status, updatedAt: new Date() })
                .where(eq(locations.id, row.id));
            });
          } catch (e) {
            if (
              (e as { code?: string }).code === "23505" ||
              (e as { cause?: { code?: string } }).cause?.code === "23505"
            )
              result = "conflict";
            else throw e;
          }
        }
      }
      results.push({ locationId: id, result });
      await audit({
        action:
          result === "updated"
            ? input.status === "active"
              ? "location.activate"
              : "location.deactivate"
            : `location.set_status_${result}`,
        entityType: "location",
        entityId: id,
        before: row ? { status: row.status } : null,
        after: { requestedStatus: input.status, result },
      });
    }
    return { results };
  },
});
