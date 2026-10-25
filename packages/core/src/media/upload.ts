import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { locationWriteOps, mediaUploads, mcpProposals, type Db, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { writeAudit } from "../audit";
import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import { enqueueJob } from "../jobs";
import { loadLocation, requireWritable } from "../locationOps/access";
import { LOCATION_OP_QUEUE } from "../locationOps/jobs";
import type { ActionAuditEntry } from "../registry";
import { assertPhotoLimits, inspectImage } from "./image";

export type StageMediaUploadInput = {
  locationId: string;
  category: string;
  file: { filename: string; bytes: Uint8Array };
  /** Hold the upload until this instant (the minute sweep then queues it). Omitted = send now. */
  scheduledFor?: Date | null;
  /** Ties the ops of one photo sent to several locations together. */
  batchId?: string;
};

export type StagedMediaUpload = {
  uploadId: string;
  operation: typeof locationWriteOps.$inferSelect;
};

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A display name only: no path, no control characters, bounded. Never used to build a path. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "photo").slice(0, MEDIA_LIMITS.upload.filenameMaxLength);
}

/**
 * The one staging path for a direct photo upload; the web route and the `media.upload` action both
 * end here, inside a transaction. Authorizes (profile:edit on the location's workspace; client
 * roles FORBIDDEN, another workspace or organisation NOT_FOUND), validates the bytes (magic bytes,
 * size, pixels; the declared content type and file extension are ignored), stores the bytes in
 * `media_uploads`, writes the `location_write_ops` row and enqueues the location-op job. Nothing is
 * sent to Google here. The audit row carries a hash of the filename, size, sha256 and pixels, never
 * the bytes or the filename.
 */
export async function stageMediaUploadTx(
  tx: Tx,
  actor: Actor,
  audit: (entry: ActionAuditEntry) => Promise<void>,
  input: StageMediaUploadInput,
): Promise<StagedMediaUpload> {
  const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
  requireWritable(loc);
  if (!(MEDIA_LIMITS.categories.values as readonly string[]).includes(input.category)) {
    throw new CoreError("INVALID_INPUT", `Unknown media category ${input.category}`);
  }
  const bytes = input.file.bytes;
  const info = inspectImage(bytes);
  assertPhotoLimits(info, bytes.length, input.category);
  const filename = cleanFilename(input.file.filename);
  const digest = sha256(bytes);

  const [upload] = await tx
    .insert(mediaUploads)
    .values({
      orgId: actor.orgId,
      locationId: loc.id,
      createdBy: actor.userId,
      filename,
      contentType: info.contentType,
      byteSize: bytes.length,
      sha256: digest,
      width: info.width,
      height: info.height,
      bytes: Buffer.from(bytes),
    })
    .returning({ id: mediaUploads.id });
  const [op] = await tx
    .insert(locationWriteOps)
    .values({
      orgId: actor.orgId,
      locationId: loc.id,
      domain: "media",
      kind: "add",
      payload: { uploadId: upload!.id, category: input.category, byteSize: bytes.length },
      requestedBy: actor.userId,
      ...(input.scheduledFor
        ? { status: "scheduled" as const, scheduledFor: input.scheduledFor }
        : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    })
    .returning();
  if (!input.scheduledFor) await enqueueJob(tx, LOCATION_OP_QUEUE, { opId: op!.id });
  await audit({
    action: "media.upload_requested",
    entityType: "location_write_op",
    entityId: op!.id,
    after: {
      locationId: loc.id,
      uploadId: upload!.id,
      category: input.category,
      filenameHash: sha256(filename),
      contentType: info.contentType,
      byteSize: bytes.length,
      sha256: digest,
      width: info.width,
      height: info.height,
      status: op!.status,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor.toISOString() } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    },
  });
  return { uploadId: upload!.id, operation: op! };
}

/** The longest a photo may wait: its staged bytes must outlive the wait (see the purge below). */
export const MAX_SCHEDULE_AHEAD_DAYS = 90;
const SCHEDULE_GRACE_MS = 60_000;

export type MediaBatchResult = {
  locationId: string;
  uploadId: string | null;
  operation: typeof locationWriteOps.$inferSelect | null;
  /** A CoreError code (NOT_FOUND, FORBIDDEN, INVALID_INPUT ...) when this location was skipped. */
  error: string | null;
  errorMessage: string | null;
};

/**
 * One photo to several locations, optionally for a later instant. Each location gets its own
 * upload row and op (its own result); a location the actor cannot write, or that is not linked,
 * is reported in its result and does not stop the others. Checks run before any insert, so a
 * CoreError never leaves a half-written location behind.
 */
export async function stageMediaUploadsTx(
  tx: Tx,
  actor: Actor,
  audit: (entry: ActionAuditEntry) => Promise<void>,
  input: Omit<StageMediaUploadInput, "locationId" | "batchId"> & {
    locationIds: string[];
    now?: Date;
  },
): Promise<{ batchId: string; results: MediaBatchResult[] }> {
  const now = input.now ?? new Date();
  if (input.scheduledFor) {
    if (input.scheduledFor.getTime() < now.getTime() - SCHEDULE_GRACE_MS) {
      throw new CoreError("INVALID_INPUT", "scheduledFor is in the past");
    }
    if (input.scheduledFor.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 86_400_000) {
      throw new CoreError(
        "INVALID_INPUT",
        `scheduledFor is more than ${MAX_SCHEDULE_AHEAD_DAYS} days ahead`,
      );
    }
  }
  const batchId = randomUUID();
  const results: MediaBatchResult[] = [];
  for (const locationId of [...new Set(input.locationIds)]) {
    try {
      const staged = await stageMediaUploadTx(tx, actor, audit, {
        locationId,
        category: input.category,
        file: input.file,
        scheduledFor: input.scheduledFor ?? null,
        batchId,
      });
      results.push({
        locationId,
        uploadId: staged.uploadId,
        operation: staged.operation,
        error: null,
        errorMessage: null,
      });
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      results.push({
        locationId,
        uploadId: null,
        operation: null,
        error: e.code,
        errorMessage: e.message,
      });
    }
  }
  // Nothing was queued: refuse like a single upload would (no access, not found ...), so the
  // action is not a write that wrote nothing.
  const first = results[0];
  if (first && results.every((r) => r.error !== null)) {
    throw new CoreError(
      first.error as ConstructorParameters<typeof CoreError>[0],
      first.errorMessage ?? undefined,
    );
  }
  return { batchId, results };
}

/** `stageMediaUploadTx` in its own transaction, for callers that are not an action (the web route). */
export function stageMediaUpload(
  db: Db,
  actor: Actor,
  input: StageMediaUploadInput,
): Promise<StagedMediaUpload> {
  return db.transaction((tx) =>
    stageMediaUploadTx(
      tx,
      actor,
      async (entry) => {
        await writeAudit(tx, {
          ...entry,
          orgId: actor.orgId,
          actorUserId: actor.userId,
          actorType: actor.actorType,
          surface: actor.surface,
        });
      },
      input,
    ),
  );
}

/** `stageMediaUploadsTx` in its own transaction, for the web route. */
export function stageMediaUploads(
  db: Db,
  actor: Actor,
  input: Parameters<typeof stageMediaUploadsTx>[3],
): ReturnType<typeof stageMediaUploadsTx> {
  return db.transaction((tx) =>
    stageMediaUploadsTx(
      tx,
      actor,
      async (entry) => {
        await writeAudit(tx, {
          ...entry,
          orgId: actor.orgId,
          actorUserId: actor.userId,
          actorType: actor.actorType,
          surface: actor.surface,
        });
      },
      input,
    ),
  );
}

/**
 * Retention. (1) Bytes of an upload that FAILED (or was abandoned `pending`) are dropped after
 * `failedRetentionDays`. (2) MCP two-phase proposals for media.upload carry the base64 photo in
 * their stored input: once the proposal has expired the input is replaced by a marker, so
 * mcp_proposals does not become a photo store either. Run nightly by the worker.
 */
export async function purgeStaleMediaUploads(
  db: Db,
  now: Date = new Date(),
): Promise<{ uploads: number; proposals: number }> {
  const cutoff = new Date(now.getTime() - MEDIA_LIMITS.upload.failedRetentionDays * 86_400_000);
  const uploads = await db
    .update(mediaUploads)
    .set({ bytes: null, status: "purged", purgedAt: now })
    .where(
      and(
        isNotNull(mediaUploads.bytes),
        ne(mediaUploads.status, "uploaded"),
        lt(mediaUploads.createdAt, cutoff),
        // A photo still waiting for its send time is not abandoned.
        sql`not exists (select 1 from location_write_ops o where o.status = 'scheduled' and o.payload->>'uploadId' = ${mediaUploads.id}::text)`,
      ),
    )
    .returning({ id: mediaUploads.id });
  const proposals = await db
    .update(mcpProposals)
    .set({ input: { purged: true } })
    .where(
      and(
        eq(mcpProposals.action, "media.upload"),
        lt(mcpProposals.expiresAt, now),
        sql`${mcpProposals.input} <> '{"purged": true}'::jsonb`,
      ),
    )
    .returning({ id: mcpProposals.id });
  return { uploads: uploads.length, proposals: proposals.length };
}
