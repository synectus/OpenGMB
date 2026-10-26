import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { locationWriteOps, locations, mediaUploads, type Db } from "@opengmb/db";
import { deferIfBlocked, enqueueJob } from "../jobs";
import { GoogleApiError } from "../google/errors";
import {
  publishMediaCreate,
  publishMediaDelete,
  publishMediaUpload,
  type MediaWriter,
} from "../media/publish";
import { publishFoodMenus, type FoodMenuWriter } from "../foodMenus/publish";
import {
  publishPlaceActionCreate,
  publishPlaceActionDelete,
  publishPlaceActionUpdate,
  type PlaceActionWriter,
} from "../placeActions/publish";
import { clientFor, googleFailure } from "../reviews/reply-jobs";
import { workerAudit } from "../reviews/reply-state";
import { hostOf } from "./access";
import { orgIsActive } from "../account-state";

export const LOCATION_OP_QUEUE = "location-op.apply";
/** Google errors are classified inside the job; pg-boss retries only unexpected errors. */
export const LOCATION_OP_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
} as const;

export const LOCATION_OP_SWEEP_QUEUE = "location-op.sweep";
/** Every minute, like the posts sweep. */
export const LOCATION_OP_SWEEP_CRON = "* * * * *";

export type LocationOpJob = { opId: string };
export type LocationOpWriter = MediaWriter & PlaceActionWriter & FoodMenuWriter;

export const LOCATION_OP_REASONS = {
  inactive: "location_inactive",
  unlinked: "location_not_linked_to_google",
  noConnection: "connection_removed",
  badPayload: "invalid_payload",
  uploadExpired: "upload_expired",
  unexpected: "unexpected_error",
} as const;

type Payload = Record<string, unknown>;
type Outcome = { status: "applied"; resultName?: string } | { status: "failed"; error: string };

/** Audit-safe summary of a payload: kind-specific names and ids, the URL's HOST only. */
function auditSummary(domain: string, payload: Payload): Record<string, unknown> {
  const url = (payload.sourceUrl ?? payload.uri) as string | undefined;
  return {
    ...(payload.category ? { category: payload.category } : {}),
    ...(payload.placeActionType ? { placeActionType: payload.placeActionType } : {}),
    ...(payload.isPreferred !== undefined ? { isPreferred: payload.isPreferred } : {}),
    ...(payload.uploadId ? { uploadId: payload.uploadId } : {}),
    ...(payload.mediaName ? { mediaName: payload.mediaName } : {}),
    ...(payload.name ? { linkName: payload.name } : {}),
    ...(url ? { host: hostOf(url) } : {}),
    ...(Array.isArray(payload.menus) ? { menus: payload.menus.length } : {}),
    domain,
  };
}

async function settle(db: Db, opId: string, outcome: Outcome): Promise<Outcome["status"]> {
  await db.transaction(async (tx) => {
    const [op] = await tx
      .select()
      .from(locationWriteOps)
      .where(eq(locationWriteOps.id, opId))
      .for("update");
    if (!op || op.status !== "pending") return;
    const now = new Date();
    // A direct upload: Google accepted it -> drop the bytes in the same transaction that settles
    // the op (we are not a photo store); it failed -> keep them for the retention window.
    const uploadId = (op.payload as Payload).uploadId;
    if (typeof uploadId === "string") {
      await tx
        .update(mediaUploads)
        .set(
          outcome.status === "applied"
            ? { status: "uploaded", bytes: null, purgedAt: now }
            : { status: "failed" },
        )
        .where(eq(mediaUploads.id, uploadId));
    }
    await tx
      .update(locationWriteOps)
      .set(
        outcome.status === "applied"
          ? {
              status: "applied",
              appliedAt: now,
              error: null,
              result: outcome.resultName ? { name: outcome.resultName } : null,
            }
          : { status: "failed", error: outcome.error },
      )
      .where(eq(locationWriteOps.id, op.id));
    await workerAudit(
      tx,
      op.orgId,
    )({
      action: `${op.domain}.op_${outcome.status}`,
      entityType: "location_write_op",
      entityId: op.id,
      before: { status: "pending" },
      after: {
        status: outcome.status,
        locationId: op.locationId,
        kind: op.kind,
        requestedBy: op.requestedBy,
        ...auditSummary(op.domain, op.payload as Payload),
        ...(outcome.status === "failed" ? { error: outcome.error } : {}),
        ...(outcome.status === "applied" && outcome.resultName
          ? { resultName: outcome.resultName }
          : {}),
      },
    });
  });
  return outcome.status;
}

/**
 * Worker side of every `location_write_ops` row (a photo added or deleted, a place action link
 * created, updated or deleted). No Google call ever happens in an action: the action stored the
 * op and enqueued this job in one transaction. Steps, none inside a long transaction: load the op
 * (ignore unless pending), skip an inactive or unlinked location, call the guarded publish module
 * through the throttled client (per-location edit bucket, idempotency key `<domain>:<opId>`), then
 * one short transaction records the outcome and an audit row. A delete of something Google no
 * longer has (404) counts as applied. A direct upload (payload.uploadId) loads its bytes from
 * `media_uploads`, uploads them in one idempotent write (startUpload, bytes, create with a
 * dataRef), and the settling transaction purges the bytes; a failure keeps them until the
 * nightly retention purge. A Google 4xx/429 fails only this op (`google_http_<n>`);
 * other errors leave it pending and throw so pg-boss retries (the idempotency key prevents a
 * second write), and on the final attempt the op fails. Safe to re-run.
 */
export async function processLocationOp(
  db: Db,
  job: LocationOpJob,
  deps: { client?: LocationOpWriter; isFinalAttempt?: boolean } = {},
): Promise<"applied" | "failed" | "ignored"> {
  const [row] = await db
    .select({ op: locationWriteOps, loc: locations })
    .from(locationWriteOps)
    .innerJoin(locations, eq(locations.id, locationWriteOps.locationId))
    .where(eq(locationWriteOps.id, job.opId));
  if (!row || row.op.status !== "pending") return "ignored";
  const { op, loc } = row;
  // AP3b: suspended or deleted. The op stays `pending`; the job is re-queued for later.
  if (await deferIfBlocked(db, op.orgId, LOCATION_OP_QUEUE, job)) return "ignored";
  const fail = (error: string) => settle(db, op.id, { status: "failed", error });
  if (loc.status !== "active") return fail(LOCATION_OP_REASONS.inactive);
  if (!loc.googleLocationId || !loc.googleAccountName) {
    return fail(LOCATION_OP_REASONS.unlinked);
  }
  const client = deps.client ?? (await clientFor(db, op.orgId, loc.connectionId));
  if (!client) return fail(LOCATION_OP_REASONS.noConnection);

  const p = op.payload as Payload;
  const where = { orgId: op.orgId, opId: op.id };
  const parent = `${loc.googleAccountName}/${loc.googleLocationId}`;
  const locationName = loc.googleLocationId;
  try {
    let resultName: string | undefined;
    if (op.domain === "media" && op.kind === "add" && typeof p.uploadId === "string") {
      const [up] = await db.select().from(mediaUploads).where(eq(mediaUploads.id, p.uploadId));
      if (!up || up.orgId !== op.orgId || up.locationId !== op.locationId) {
        return fail(LOCATION_OP_REASONS.badPayload);
      }
      if (!up.bytes) return fail(LOCATION_OP_REASONS.uploadExpired);
      const m = await publishMediaUpload(
        client,
        { ...where, parent },
        {
          bytes: new Uint8Array(up.bytes),
          contentType: up.contentType,
          sha256: up.sha256,
          category: String(p.category),
        },
      );
      resultName = m.name;
    } else if (op.domain === "media" && op.kind === "add") {
      const m = await publishMediaCreate(
        client,
        { ...where, parent },
        {
          sourceUrl: String(p.sourceUrl),
          category: String(p.category),
        },
      );
      resultName = m.name;
    } else if (op.domain === "media" && op.kind === "delete") {
      await publishMediaDelete(client, { ...where, parent }, String(p.mediaName));
    } else if (op.domain === "place_action" && op.kind === "add") {
      const l = await publishPlaceActionCreate(
        client,
        { ...where, locationName },
        {
          uri: String(p.uri),
          placeActionType: String(p.placeActionType),
          ...(p.isPreferred !== undefined ? { isPreferred: Boolean(p.isPreferred) } : {}),
        },
      );
      resultName = l.name;
    } else if (op.domain === "place_action" && op.kind === "update") {
      await publishPlaceActionUpdate(client, { ...where, locationName }, String(p.name), {
        ...(p.uri !== undefined ? { uri: String(p.uri) } : {}),
        ...(p.placeActionType !== undefined ? { placeActionType: String(p.placeActionType) } : {}),
        ...(p.isPreferred !== undefined ? { isPreferred: Boolean(p.isPreferred) } : {}),
      });
      resultName = String(p.name);
    } else if (op.domain === "place_action" && op.kind === "delete") {
      await publishPlaceActionDelete(client, { ...where, locationName }, String(p.name));
    } else if (op.domain === "food_menu" && op.kind === "update") {
      await publishFoodMenus(client, { ...where, parent }, p.menus);
    } else {
      return fail(LOCATION_OP_REASONS.badPayload);
    }
    return settle(db, op.id, { status: "applied", ...(resultName ? { resultName } : {}) });
  } catch (e) {
    if (op.kind === "delete" && e instanceof GoogleApiError && e.status === 404) {
      return settle(db, op.id, { status: "applied" });
    }
    const reason = googleFailure(e);
    if (reason) return fail(reason);
    // Our own validation (CoreError INVALID_INPUT) cannot improve with a retry.
    if ((e as { code?: string })?.code === "INVALID_INPUT") {
      return fail(LOCATION_OP_REASONS.badPayload);
    }
    if (deps.isFinalAttempt) return fail(LOCATION_OP_REASONS.unexpected);
    throw e;
  }
}

/**
 * Scheduled photo uploads: a minute-level sweep (the database is the schedule, as for posts).
 * Moves every `scheduled` op whose `scheduled_for` is at or before `now` to `pending` and enqueues
 * its apply job in the same transaction, oldest first, `FOR UPDATE SKIP LOCKED`. `orgIds`
 * restricts the sweep (tests only).
 */
export async function sweepDueLocationOps(
  db: Db,
  deps: { now?: Date; limit?: number; orgIds?: string[] } = {},
): Promise<{ claimed: number }> {
  const now = deps.now ?? new Date();
  const due = await db
    .select({ id: locationWriteOps.id })
    .from(locationWriteOps)
    .where(
      and(
        eq(locationWriteOps.status, "scheduled"),
        lte(locationWriteOps.scheduledFor, now),
        deps.orgIds ? inArray(locationWriteOps.orgId, deps.orgIds) : undefined,
        orgIsActive(locationWriteOps.orgId),
      ),
    )
    .orderBy(asc(locationWriteOps.scheduledFor), asc(locationWriteOps.id))
    .limit(deps.limit ?? 200);
  let claimed = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [op] = await tx
        .update(locationWriteOps)
        .set({ status: "pending" })
        .where(
          and(
            eq(locationWriteOps.id, id),
            eq(locationWriteOps.status, "scheduled"),
            lte(locationWriteOps.scheduledFor, now),
          ),
        )
        .returning({ id: locationWriteOps.id });
      if (!op) return;
      await enqueueJob(tx, LOCATION_OP_QUEUE, { opId: op.id });
      claimed++;
    });
  }
  return { claimed };
}
