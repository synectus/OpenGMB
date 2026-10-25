import { z } from "zod";
import { locationWriteOps } from "@opengmb/db";
import { PLACE_ACTION_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import { PLACE_ACTION_TYPES, type GooglePlaceActionLink } from "../google/client";
import { enqueueJob } from "../jobs";
import {
  clearGoogleAccessDenied,
  isGoogleAccessBlocked,
  isLocationAccessDenied,
  markGoogleAccessDenied,
} from "../locations/data-access";
import {
  assertHttpsUrl,
  clientForLocation,
  googleNames,
  hostOf,
  httpsUrlProblem,
  loadLocation,
  requireWritable,
} from "../locationOps/access";
import { LOCATION_OP_QUEUE } from "../locationOps/jobs";
import type { Actor } from "../actor";
import { defineAction, type ActionContext } from "../registry";
import { opOut, recentOps, toOpOut } from "./media";

const type = z.enum(PLACE_ACTION_TYPES);
const uri = z
  .string()
  .max(PLACE_ACTION_LIMITS.uriMaxLength)
  .superRefine((v, ctx) => {
    const problem = httpsUrlProblem(v, { maxLength: PLACE_ACTION_LIMITS.uriMaxLength });
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
const linkName = z.string().regex(/^locations\/[^/]+\/placeActionLinks\/[^/]+$/);

const linkOut = z.object({
  name: z.string(),
  uri: z.string(),
  placeActionType: z.string(),
  isPreferred: z.boolean(),
  /** false for links another provider manages (aggregators): they cannot be changed from here. */
  isEditable: z.boolean(),
  providerType: z.string().nullable(),
  createTime: z.string().nullable(),
  updateTime: z.string().nullable(),
});
const toLink = (l: GooglePlaceActionLink): z.input<typeof linkOut> => ({
  name: l.name ?? "",
  uri: l.uri,
  placeActionType: l.placeActionType,
  isPreferred: l.isPreferred ?? false,
  isEditable: l.isEditable ?? true,
  providerType: l.providerType ?? null,
  createTime: l.createTime ?? null,
  updateTime: l.updateTime ?? null,
});

const TYPES = PLACE_ACTION_TYPES.join(", ");

export const placeActionsList = defineAction({
  name: "placeActions.list",
  description: `List a location's place action links (booking / ordering buttons on the listing) live from Google (outside any transaction), plus the most recent link operations queued from here (status pending, applied, failed with a reason code). Types: ${TYPES}. Only one link per (uri, type) and one preferred link per type exist at a location. Links with isEditable false (managed by an aggregator) cannot be changed.`,
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    links: z.array(linkOut),
    operations: z.array(opOut),
    /** true when Google refuses to share place action links for this location with the connected account (re-checked every few days). */
    googleAccessDenied: z.boolean(),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const operations = await recentOps(db, loc.id, "place_action");
    // OPS2: Google recently refused this location's place action links: do not ask again yet.
    if (await isGoogleAccessBlocked(db, loc.id, "place_actions")) {
      return { links: [], operations, googleAccessDenied: true };
    }
    const client = await clientForLocation(db, actor, loc);
    const { locationName } = googleNames(loc);
    const links: GooglePlaceActionLink[] = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < 20; page++) {
        const res = await client.listPlaceActionLinks(locationName, {
          pageSize: PLACE_ACTION_LIMITS.listPageSize.limit,
          ...(pageToken ? { pageToken } : {}),
        });
        links.push(...res.placeActionLinks);
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
    } catch (e) {
      if (!isLocationAccessDenied(e)) throw e;
      await markGoogleAccessDenied(db, loc, "place_actions");
      return { links: [], operations, googleAccessDenied: true };
    }
    await clearGoogleAccessDenied(db, loc.id, "place_actions");
    return { links: links.map(toLink), operations, googleAccessDenied: false };
  },
});

const own = (name: string, locationName: string) => {
  if (!name.startsWith(`${locationName}/placeActionLinks/`)) {
    throw new CoreError("INVALID_INPUT", "Place action link belongs to another location");
  }
};

async function queue(
  tx: ActionContext["tx"],
  actor: Actor,
  loc: { id: string },
  kind: "add" | "update" | "delete",
  payload: Record<string, unknown>,
) {
  const [op] = await tx
    .insert(locationWriteOps)
    .values({
      orgId: actor.orgId,
      locationId: loc.id,
      domain: "place_action",
      kind,
      payload,
      requestedBy: actor.userId,
    })
    .returning();
  await enqueueJob(tx, LOCATION_OP_QUEUE, { opId: op!.id });
  return op!;
}

export const placeActionsCreate = defineAction({
  name: "placeActions.create",
  description: `Add a place action link (a booking or ordering URL) to a location. placeActionType: ${TYPES}. uri must be https. isPreferred marks it the preferred link for its type (any previous preferred link of that type loses it). Asynchronous: records the operation and queues a worker job (status pending); nothing is sent to Google inside this call. A link with the same uri and type that already exists fails with google_http_409. Needs profile:edit.`,
  input: z.object({
    locationId: z.uuid(),
    placeActionType: type,
    uri,
    isPreferred: z.boolean().optional(),
  }),
  output: z.object({ operation: opOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    requireWritable(loc);
    assertHttpsUrl(input.uri, { maxLength: PLACE_ACTION_LIMITS.uriMaxLength });
    const op = await queue(tx, actor, loc, "add", {
      placeActionType: input.placeActionType,
      uri: input.uri,
      ...(input.isPreferred !== undefined ? { isPreferred: input.isPreferred } : {}),
    });
    await audit({
      action: "place_action.create_requested",
      entityType: "location_write_op",
      entityId: op.id,
      after: {
        locationId: loc.id,
        placeActionType: input.placeActionType,
        host: hostOf(input.uri),
        status: "pending",
      },
    });
    return { operation: toOpOut(op) };
  },
});

export const placeActionsUpdate = defineAction({
  name: "placeActions.update",
  description:
    "Change a place action link (`name` as returned by placeActions.list): any of uri (https), placeActionType, isPreferred; only the fields you pass are written (Google's updateMask is exactly those). Links with isEditable false fail at Google. Asynchronous: records the operation and queues a worker job (status pending). Needs profile:edit.",
  input: z.object({
    locationId: z.uuid(),
    name: linkName,
    uri: uri.optional(),
    placeActionType: type.optional(),
    isPreferred: z.boolean().optional(),
  }),
  output: z.object({ operation: opOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    const { locationName } = requireWritable(loc);
    own(input.name, locationName);
    const patch = {
      ...(input.uri !== undefined ? { uri: input.uri } : {}),
      ...(input.placeActionType !== undefined ? { placeActionType: input.placeActionType } : {}),
      ...(input.isPreferred !== undefined ? { isPreferred: input.isPreferred } : {}),
    };
    if (Object.keys(patch).length === 0) throw new CoreError("INVALID_INPUT", "Nothing to update");
    const op = await queue(tx, actor, loc, "update", { name: input.name, ...patch });
    await audit({
      action: "place_action.update_requested",
      entityType: "location_write_op",
      entityId: op.id,
      after: {
        locationId: loc.id,
        linkName: input.name,
        fieldNames: Object.keys(patch).sort(),
        host: input.uri ? hostOf(input.uri) : null,
        status: "pending",
      },
    });
    return { operation: toOpOut(op) };
  },
});

export const placeActionsDelete = defineAction({
  name: "placeActions.delete",
  description:
    "Delete a place action link (`name` as returned by placeActions.list). Asynchronous: records the operation and queues a worker job (status pending); a link Google no longer has counts as deleted. Needs profile:edit.",
  input: z.object({ locationId: z.uuid(), name: linkName }),
  output: z.object({ operation: opOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    const { locationName } = requireWritable(loc);
    own(input.name, locationName);
    const op = await queue(tx, actor, loc, "delete", { name: input.name });
    await audit({
      action: "place_action.delete_requested",
      entityType: "location_write_op",
      entityId: op.id,
      after: { locationId: loc.id, linkName: input.name, status: "pending" },
    });
    return { operation: toOpOut(op) };
  },
});
