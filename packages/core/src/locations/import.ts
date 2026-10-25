import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { googleConnections, locationImports, locations, workspaces, type Db } from "@opengmb/db";
import { writeAudit } from "../audit";
import { requestReviewSync } from "../reviews/sync";
import { enqueueJob } from "../jobs";
import { PERFORMANCE_SNAPSHOT_QUEUE } from "../performance/snapshot";
import { tryEnqueueLocationCenter } from "./center";
import { createGoogleClient } from "../google/factory";
import type { GoogleLocation } from "../google/client";
import { addressSummary, fetchAllLocations } from "./google";
import { dateFormatForAddress, zoneForAddress } from "../time/zones";

export const LOCATION_IMPORT_QUEUE = "locations.import";

/** Most locations one `locations.import` call takes. Our choice: one worker job, one transaction. */
export const IMPORT_MAX_LOCATIONS = 100;

export const importItem = z.object({
  accountName: z.string().regex(/^accounts\/[^/\s]+$/, "accountName must look like accounts/{id}"),
  locationName: z
    .string()
    .regex(/^locations\/[^/\s]+$/, "locationName must look like locations/{id}"),
});
export type ImportItem = z.infer<typeof importItem>;

export const importResult = z.object({
  locationName: z.string(),
  result: z.enum([
    "imported",
    "already_imported",
    "relinked",
    "exists_inactive",
    "conflict",
    "not_found",
  ]),
  locationId: z.string().nullable(),
});
export type ImportResult = z.infer<typeof importResult>;

type Fetcher = {
  listLocations: Parameters<typeof fetchAllLocations>[0]["listLocations"];
};

/**
 * Worker side of `locations.import`. Phase 1 calls Google with no transaction open: the stored
 * request names accounts and locations, and the details (title, phone, address) come from Google,
 * never from the client. Phase 2 is one short transaction that claims the still-pending request,
 * inserts the locations, writes an audit row per location (surface worker, requester in `after`)
 * and stores the per-location results. A Google failure throws before phase 2, changes nothing
 * and leaves the request pending so the job can be retried. Re-running a finished request is a
 * no-op.
 *
 * Per location: `imported`; `already_imported` (active in this workspace of this org already:
 * idempotent success); `relinked` (same, but its Google connection was removed, leaving connection_id
 * NULL: re-attached to the importing connection and re-synced; a location linked to another
 * existing connection is never taken over); `exists_inactive` (this org has it, inactive: activate it instead);
 * `conflict` (active elsewhere: another workspace or another org); `not_found` (not under the
 * named account on this connection).
 */
export async function processLocationImport(
  db: Db,
  importId: string,
  deps: { client?: Fetcher } = {},
): Promise<ImportResult[] | null> {
  const [req] = await db.select().from(locationImports).where(eq(locationImports.id, importId));
  if (!req) {
    console.warn(`[locations.import] request ${importId} not found, skipping`);
    return null;
  }
  if (req.status !== "pending") return null;
  const items = z.array(importItem).parse(req.items);

  const fail = async (reason: string) => {
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(locationImports)
        .set({ status: "failed", results: { error: reason }, completedAt: new Date() })
        .where(and(eq(locationImports.id, importId), eq(locationImports.status, "pending")))
        .returning({ id: locationImports.id });
      if (!claimed) return;
      await writeAudit(tx, {
        orgId: req.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "location_import.failed",
        entityType: "location_import",
        entityId: importId,
        after: { reason, requestedBy: req.requestedBy },
      });
    });
    return null;
  };

  const [conn] = req.connectionId
    ? await db
        .select()
        .from(googleConnections)
        .where(
          and(eq(googleConnections.id, req.connectionId), eq(googleConnections.orgId, req.orgId)),
        )
    : [];
  if (!conn) return fail("connection_removed");

  // Phase 1: Google, no transaction.
  const client = deps.client ?? createGoogleClient({ db, connection: conn });
  const byAccount = new Map<string, Map<string, GoogleLocation>>();
  for (const account of new Set(items.map((i) => i.accountName))) {
    const { locations: found } = await fetchAllLocations(client, account);
    byAccount.set(account, new Map(found.map((l) => [l.name, l])));
  }

  // Phase 2: one short transaction.
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(locationImports)
      .set({ status: "done", completedAt: new Date() })
      .where(and(eq(locationImports.id, importId), eq(locationImports.status, "pending")))
      .returning({ id: locationImports.id });
    if (!claimed) return null; // another run finished it first

    const ids = [...new Set(items.map((i) => i.locationName))];
    const active = await tx
      .select({
        id: locations.id,
        orgId: locations.orgId,
        workspaceId: locations.workspaceId,
        googleLocationId: locations.googleLocationId,
        connectionId: locations.connectionId,
      })
      .from(locations)
      .where(and(inArray(locations.googleLocationId, ids), eq(locations.status, "active")));
    const linked = new Set(
      (
        await tx
          .select({ id: googleConnections.id })
          .from(googleConnections)
          .where(eq(googleConnections.orgId, req.orgId))
      ).map((c) => c.id),
    );
    const inactiveHere = await tx
      .select({ id: locations.id, googleLocationId: locations.googleLocationId })
      .from(locations)
      .where(
        and(
          inArray(locations.googleLocationId, ids),
          eq(locations.status, "inactive"),
          eq(locations.orgId, req.orgId),
        ),
      );

    // First reviews sync + performance backfill for a new or re-linked location, in this same
    // transaction: the jobs exist iff the change does. The worker (not this transaction) talks to Google.
    const queueInitialSyncs = async (locationId: string, trigger: string) => {
      await requestReviewSync(tx, {
        orgId: req.orgId,
        locationId,
        requestedBy: req.requestedBy,
        reason: { trigger, importId },
        audit: async (e) => {
          await writeAudit(tx, {
            ...e,
            orgId: req.orgId,
            actorUserId: null,
            actorType: "system",
            surface: "worker",
          });
        },
      });
      // Otherwise the Performance page stays empty until the nightly snapshot (03:00 UTC).
      const perfJobId = await enqueueJob(tx, PERFORMANCE_SNAPSHOT_QUEUE, {
        locationId,
        backfill: true,
      });
      // Coordinates are looked up once, as their own job, so a slow or failing lookup never touches the import.
      await tryEnqueueLocationCenter(tx, { locationId, reason: "onboarding" });
      await writeAudit(tx, {
        orgId: req.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "performance.backfill_requested",
        entityType: "location",
        entityId: locationId,
        before: null,
        after: { jobId: perfJobId, trigger, importId },
      });
    };

    const results: ImportResult[] = [];
    let firstImported: GoogleLocation | null = null;
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.locationName)) continue; // duplicate entry in the request
      seen.add(item.locationName);
      const out = (result: ImportResult["result"], locationId: string | null = null) =>
        results.push({ locationName: item.locationName, result, locationId });

      const g = byAccount.get(item.accountName)?.get(item.locationName);
      if (!g) {
        out("not_found");
        continue;
      }
      const act = active.find((a) => a.googleLocationId === item.locationName);
      if (act) {
        if (act.orgId !== req.orgId || act.workspaceId !== req.workspaceId) out("conflict");
        else if (act.connectionId && linked.has(act.connectionId)) out("already_imported", act.id);
        else {
          // Orphaned: its connection was disconnected. Re-attach it to this one.
          await tx
            .update(locations)
            .set({
              connectionId: conn.id,
              googleAccountName: item.accountName,
              updatedAt: new Date(),
            })
            .where(eq(locations.id, act.id));
          await writeAudit(tx, {
            orgId: req.orgId,
            actorUserId: null,
            actorType: "system",
            surface: "worker",
            action: "location.relinked",
            entityType: "location",
            entityId: act.id,
            before: { connectionId: act.connectionId },
            after: {
              connectionId: conn.id,
              googleAccountName: item.accountName,
              importId,
              requestedBy: req.requestedBy,
            },
          });
          await queueInitialSyncs(act.id, "location_relink");
          out("relinked", act.id);
        }
        continue;
      }
      const inactive = inactiveHere.find((a) => a.googleLocationId === item.locationName);
      if (inactive) {
        out("exists_inactive", inactive.id);
        continue;
      }
      const [row] = await tx
        .insert(locations)
        .values({
          orgId: req.orgId,
          workspaceId: req.workspaceId,
          name: g.title,
          title: g.title,
          googleLocationId: item.locationName,
          googleAccountName: item.accountName,
          connectionId: conn.id,
          phone: g.phoneNumbers?.primaryPhone ?? null,
          addressSummary: addressSummary(g),
          status: "active",
          importedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        out("conflict"); // lost a race with another import; the partial unique index decided
        continue;
      }
      await writeAudit(tx, {
        orgId: req.orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        action: "location.import",
        entityType: "location",
        entityId: row.id,
        before: null,
        after: {
          googleLocationId: row.googleLocationId,
          googleAccountName: row.googleAccountName,
          title: row.title,
          workspaceId: row.workspaceId,
          connectionId: conn.id,
          importId,
          requestedBy: req.requestedBy,
        },
      });
      await queueInitialSyncs(row.id, "location_import");
      firstImported ??= g;
      out("imported", row.id);
    }
    // F4: the workspace's time zone and date format default from its first location's address,
    // once each, and only while nobody has chosen them (a manual choice or an earlier derivation
    // is never overwritten).
    const region = firstImported?.storefrontAddress?.regionCode;
    const zone = zoneForAddress(region, firstImported?.storefrontAddress?.administrativeArea);
    const format = dateFormatForAddress(region);
    for (const [field, value] of [
      ["timeZone", zone],
      ["dateFormat", format],
    ] as const) {
      if (!value) continue;
      const [set] = await tx
        .update(workspaces)
        .set(
          field === "timeZone"
            ? { timeZone: value, timeZoneSource: "derived" }
            : { dateFormat: value as NonNullable<typeof format>, dateFormatSource: "derived" },
        )
        .where(
          and(
            eq(workspaces.id, req.workspaceId),
            eq(field === "timeZone" ? workspaces.timeZoneSource : workspaces.dateFormatSource, "default"),
          ),
        )
        .returning({ id: workspaces.id });
      if (set) {
        await writeAudit(tx, {
          orgId: req.orgId,
          actorUserId: null,
          actorType: "system",
          surface: "worker",
          action: field === "timeZone" ? "workspace.time_zone_derived" : "workspace.date_format_derived",
          entityType: "workspace",
          entityId: req.workspaceId,
          before: null,
          after: { [field]: value, importId },
        });
      }
    }
    await tx.update(locationImports).set({ results }).where(eq(locationImports.id, importId));
    await writeAudit(tx, {
      orgId: req.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "worker",
      action: "location_import.completed",
      entityType: "location_import",
      entityId: importId,
      after: { requestedBy: req.requestedBy, results },
    });
    return results;
  });
}
