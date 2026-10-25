import { desc, eq, and } from "drizzle-orm";
import { z } from "zod";
import { locationWriteOps, locations, mediaUploads, type Db } from "@opengmb/db";
import { MEDIA_LIMITS } from "../config/media-limits";
import { authorize, workspaceScope } from "../actor";
import { CoreError } from "../errors";
import type { GoogleClient, GoogleMediaItem } from "../google/client";
import { enqueueJob } from "../jobs";
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
import { listAllCustomerMedia } from "../media/customer";
import { assertPhotoLimits, inspectImage } from "../media/image";
import { MAX_SCHEDULE_AHEAD_DAYS, stageMediaUploadsTx, stageMediaUploadTx } from "../media/upload";
import { defineAction } from "../registry";

const category = z.enum(MEDIA_LIMITS.categories.values);

const mediaItemOut = z.object({
  name: z.string(),
  /** COVER, PROFILE (the logo), EXTERIOR ...; null when Google reports none. */
  category: z.string().nullable(),
  mediaFormat: z.string().nullable(),
  googleUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  /** Only for photos added by URL; Google does not keep it for profile photos. */
  sourceUrl: z.string().nullable(),
  description: z.string().nullable(),
  createTime: z.string().nullable(),
  widthPixels: z.number().nullable(),
  heightPixels: z.number().nullable(),
  /** Customer media only. Google requires showing it unaltered. */
  attribution: z
    .object({
      profileName: z.string().nullable(),
      profileUrl: z.string().nullable(),
      takedownUrl: z.string().nullable(),
    })
    .nullable(),
});

export const opOut = z.object({
  id: z.string(),
  locationId: z.string(),
  domain: z.enum(["media", "place_action", "food_menu"]),
  kind: z.enum(["add", "update", "delete"]),
  /** scheduled = waiting for scheduledFor; the minute sweep then makes it pending. */
  status: z.enum(["scheduled", "pending", "applied", "failed", "cancelled"]),
  /** A reason code (google_http_<n>, location_inactive ...), never Google's body. */
  error: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  /** When a scheduled op becomes due (an instant); null for an op sent at once. */
  scheduledFor: z.string().nullable(),
  /** Shared by the ops of one photo sent to several locations (media.uploadMany). */
  batchId: z.string().nullable(),
});

type OpRow = typeof locationWriteOps.$inferSelect;
export const toOpOut = (o: OpRow): z.input<typeof opOut> => ({
  id: o.id,
  locationId: o.locationId,
  domain: o.domain,
  kind: o.kind,
  status: o.status,
  error: o.error,
  payload: o.payload as Record<string, unknown>,
  result: (o.result as Record<string, unknown> | null) ?? null,
  createdAt: o.createdAt.toISOString(),
  appliedAt: o.appliedAt?.toISOString() ?? null,
  scheduledFor: o.scheduledFor?.toISOString() ?? null,
  batchId: o.batchId ?? null,
});

export const recentOps = async (
  db: Db,
  locationId: string,
  domain: "media" | "place_action" | "food_menu",
): Promise<z.input<typeof opOut>[]> =>
  (
    await db
      .select()
      .from(locationWriteOps)
      .where(and(eq(locationWriteOps.locationId, locationId), eq(locationWriteOps.domain, domain)))
      .orderBy(desc(locationWriteOps.createdAt), desc(locationWriteOps.id))
      .limit(MEDIA_LIMITS.recentOps)
  ).map(toOpOut);

function toItem(m: GoogleMediaItem): z.input<typeof mediaItemOut> {
  return {
    name: m.name ?? "",
    category: m.locationAssociation?.category ?? null,
    mediaFormat: m.mediaFormat ?? null,
    googleUrl: m.googleUrl ?? null,
    thumbnailUrl: m.thumbnailUrl ?? null,
    sourceUrl: m.sourceUrl ?? null,
    description: m.description ?? null,
    createTime: m.createTime ?? null,
    widthPixels: m.dimensions?.widthPixels ?? null,
    heightPixels: m.dimensions?.heightPixels ?? null,
    attribution: m.attribution
      ? {
          profileName: m.attribution.profileName ?? null,
          profileUrl: m.attribution.profileUrl ?? null,
          takedownUrl: m.attribution.takedownUrl ?? null,
        }
      : null,
  };
}

export async function listAllMedia(client: Pick<GoogleClient, "listMedia">, parent: string) {
  const out: GoogleMediaItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MEDIA_LIMITS.maxPages; page++) {
    const res = await client.listMedia(parent, {
      pageSize: MEDIA_LIMITS.listPageSize.limit,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...res.mediaItems);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

const sourceUrl = z
  .string()
  .max(MEDIA_LIMITS.sourceUrlMaxLength)
  .superRefine((v, ctx) => {
    const problem = httpsUrlProblem(v, {
      maxLength: MEDIA_LIMITS.sourceUrlMaxLength,
      imageHint: true,
    });
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const mediaList = defineAction({
  name: "media.list",
  description: `List a location's photos live from Google (the mock, today) with their category (COVER, PROFILE = the logo, EXTERIOR, INTERIOR, PRODUCT, AT_WORK, FOOD_AND_DRINK, MENU, COMMON_AREA, ROOMS, TEAMS, ADDITIONAL), plus the most recent photo operations queued from here (media.add / media.delete are asynchronous: status pending, applied or failed with a reason code). Calls Google, so it runs outside any database transaction. Photo requirements: JPG or PNG, 10 KB to 5 MB, at least ${MEDIA_LIMITS.photo.minShortEdgePx}px on the short edge, ${MEDIA_LIMITS.photo.recommendedPx}px recommended (${MEDIA_LIMITS.photo.sourceUrl}).`,
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    location: z.object({ id: z.string(), name: z.string(), workspaceId: z.string() }),
    items: z.array(mediaItemOut),
    operations: z.array(opOut),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const client = await clientForLocation(db, actor, loc);
    const items = await listAllMedia(client, googleNames(loc).parent);
    return {
      location: { id: loc.id, name: loc.name, workspaceId: loc.workspaceId },
      items: items.map(toItem),
      operations: await recentOps(db, loc.id, "media"),
    };
  },
});

export const mediaCustomerList = defineAction({
  name: "media.customer.list",
  description:
    "List photos contributed by customers at a location, live from Google (outside any transaction). Each item carries the contributor attribution, which Google requires to be shown unaltered, and the takedown URL to report an inappropriate photo. The nightly job notifies (media.customer_photo) once per new photo.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ items: z.array(mediaItemOut) }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const client = await clientForLocation(db, actor, loc);
    return { items: (await listAllCustomerMedia(client, googleNames(loc).parent)).map(toItem) };
  },
});

export const mediaAdd = defineAction({
  name: "media.add",
  description:
    "Add a photo to a location from a public https image URL (JPG or PNG; to send the file itself use media.upload) in a category: COVER (the cover photo, one per location), PROFILE (the logo, one per location; LOGO is a deprecated alias and is not accepted), EXTERIOR, INTERIOR, PRODUCT, AT_WORK, FOOD_AND_DRINK, MENU, COMMON_AREA, ROOMS, TEAMS or ADDITIONAL. Setting the cover or logo is simply adding with category COVER or PROFILE; Google replaces the previous one. Asynchronous: records the operation and queues a worker job (returns status pending); nothing is sent to Google inside this call and the URL is never fetched by OpenGMB. Poll media.list for the outcome. Needs profile:edit.",
  input: z.object({ locationId: z.uuid(), sourceUrl, category }),
  output: z.object({ operation: opOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    requireWritable(loc);
    assertHttpsUrl(input.sourceUrl, {
      maxLength: MEDIA_LIMITS.sourceUrlMaxLength,
      imageHint: true,
    });
    const [op] = await tx
      .insert(locationWriteOps)
      .values({
        orgId: actor.orgId,
        locationId: loc.id,
        domain: "media",
        kind: "add",
        payload: { sourceUrl: input.sourceUrl, category: input.category },
        requestedBy: actor.userId,
      })
      .returning();
    await enqueueJob(tx, LOCATION_OP_QUEUE, { opId: op!.id });
    await audit({
      action: "media.add_requested",
      entityType: "location_write_op",
      entityId: op!.id,
      after: {
        locationId: loc.id,
        category: input.category,
        host: hostOf(input.sourceUrl),
        status: "pending",
      },
    });
    return { operation: toOpOut(op!) };
  },
});

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Strict base64 (Buffer.from would silently skip bad characters) -> bytes. */
function decodePhoto(b64: string): Uint8Array {
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) {
    throw new CoreError("INVALID_INPUT", "contentBase64 is not valid base64");
  }
  return Buffer.from(b64, "base64");
}

export const mediaUpload = defineAction({
  name: "media.upload",
  description: `Upload a photo FILE to a location (base64 content, JPG or PNG, at most 5 MB, so at most ${MEDIA_LIMITS.upload.maxBase64Chars} base64 characters) in a category: COVER, PROFILE (the logo), EXTERIOR, INTERIOR, PRODUCT, AT_WORK, FOOD_AND_DRINK, MENU, COMMON_AREA, ROOMS, TEAMS or ADDITIONAL. The format is detected from the bytes (GIF, HEIC and WebP are rejected) and the size and pixels are checked against Google's rules (${MEDIA_LIMITS.photo.minBytes / 1024} KB to 5 MB and ${MEDIA_LIMITS.photo.minShortEdgePx}px on the short edge, except COVER and PROFILE). Asynchronous like media.add: records the operation and queues a worker job (status pending); the bytes are kept only until Google accepts them, then deleted. Poll media.list. Needs profile:edit. Over MCP this is a two-phase write: the proposal preview shows file facts only, never the image.`,
  input: z.object({
    locationId: z.uuid(),
    category,
    filename: z.string().min(1).max(MEDIA_LIMITS.upload.filenameMaxLength),
    contentBase64: z.string().min(1).max(MEDIA_LIMITS.upload.maxBase64Chars),
  }),
  output: z.object({ operation: opOut, uploadId: z.string() }),
  permission: "profile:edit",
  kind: "write",
  async preview({ actor, readTx }, input) {
    return readTx(async (tx) => {
      const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
      requireWritable(loc);
      const bytes = decodePhoto(input.contentBase64);
      const info = inspectImage(bytes);
      assertPhotoLimits(info, bytes.length, input.category);
      return {
        summary: `Would upload photo "${input.filename}" (${info.format.toUpperCase()}, ${info.width}x${info.height}px, ${Math.ceil(bytes.length / 1024)} KB) to ${loc.name} as ${input.category}. The image itself is not shown here.`,
        diff: {
          locationId: loc.id,
          category: input.category,
          filename: input.filename,
          contentType: info.contentType,
          byteSize: bytes.length,
          width: info.width,
          height: info.height,
        },
      };
    });
  },
  async handler({ tx, actor, audit }, input) {
    const staged = await stageMediaUploadTx(tx, actor, audit, {
      locationId: input.locationId,
      category: input.category,
      file: { filename: input.filename, bytes: decodePhoto(input.contentBase64) },
    });
    return { operation: toOpOut(staged.operation), uploadId: staged.uploadId };
  },
});

export const mediaDelete = defineAction({
  name: "media.delete",
  description:
    "Delete a photo from a location (`mediaName` as returned by media.list, accounts/{a}/locations/{l}/media/{id}). Asynchronous: records the operation and queues a worker job (status pending); a photo Google no longer has counts as deleted. Poll media.list. Needs profile:edit.",
  input: z.object({
    locationId: z.uuid(),
    mediaName: z.string().regex(/^accounts\/[^/]+\/locations\/[^/]+\/media\/[^/]+$/),
  }),
  output: z.object({ operation: opOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    const { parent } = requireWritable(loc);
    if (!input.mediaName.startsWith(`${parent}/media/`)) {
      throw new CoreError("INVALID_INPUT", "Media item belongs to another location");
    }
    const [op] = await tx
      .insert(locationWriteOps)
      .values({
        orgId: actor.orgId,
        locationId: loc.id,
        domain: "media",
        kind: "delete",
        payload: { mediaName: input.mediaName },
        requestedBy: actor.userId,
      })
      .returning();
    await enqueueJob(tx, LOCATION_OP_QUEUE, { opId: op!.id });
    await audit({
      action: "media.delete_requested",
      entityType: "location_write_op",
      entityId: op!.id,
      after: { locationId: loc.id, mediaName: input.mediaName, status: "pending" },
    });
    return { operation: toOpOut(op!) };
  },
});

const scheduledFor = z.iso.datetime({ offset: true });

export const mediaUploadMany = defineAction({
  name: "media.uploadMany",
  description: `Upload ONE photo FILE (base64, same rules as media.upload) to several locations at once, now or at a later time. Each location gets its own operation (its own result): a location you cannot edit, or that is not linked to Google, is reported in its own result (error code) and does not stop the others. scheduledFor (optional, ISO datetime with offset = an instant, not in the past, at most ${MAX_SCHEDULE_AHEAD_DAYS} days ahead; the web app converts the location's local wall time) holds the photo until then: its operations have status scheduled, and a worker sweeps every minute and sends the due ones (so a send can be up to about a minute late). Without scheduledFor the operations are queued at once (status pending). The photo is kept only until Google accepts it. Poll media.batch with the returned batchId for per-location results. Needs profile:edit on each location. Over MCP this is a two-phase write.`,
  input: z.object({
    locationIds: z.array(z.uuid()).min(1).max(50),
    category,
    filename: z.string().min(1).max(MEDIA_LIMITS.upload.filenameMaxLength),
    contentBase64: z.string().min(1).max(MEDIA_LIMITS.upload.maxBase64Chars),
    scheduledFor: scheduledFor.optional(),
  }),
  output: z.object({
    batchId: z.string(),
    results: z.array(
      z.object({
        locationId: z.string(),
        uploadId: z.string().nullable(),
        operation: opOut.nullable(),
        error: z.string().nullable(),
        errorMessage: z.string().nullable(),
      }),
    ),
  }),
  permission: "profile:edit",
  kind: "write",
  async preview({ actor, readTx }, input) {
    return readTx(async (tx) => {
      const bytes = decodePhoto(input.contentBase64);
      const info = inspectImage(bytes);
      assertPhotoLimits(info, bytes.length, input.category);
      const names: string[] = [];
      for (const id of new Set(input.locationIds)) {
        const loc = await loadLocation(tx, actor, id, "profile:edit");
        requireWritable(loc);
        names.push(loc.name);
      }
      return {
        summary: `Would upload photo "${input.filename}" (${info.format.toUpperCase()}, ${info.width}x${info.height}px, ${Math.ceil(bytes.length / 1024)} KB) to ${names.length} location(s) as ${input.category}: ${names.join(", ")}${input.scheduledFor ? `, scheduled for ${input.scheduledFor}` : ", now"}. The image itself is not shown here.`,
        diff: {
          locationIds: [...new Set(input.locationIds)],
          category: input.category,
          filename: input.filename,
          contentType: info.contentType,
          byteSize: bytes.length,
          ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
        },
      };
    });
  },
  async handler({ tx, actor, audit }, input) {
    const out = await stageMediaUploadsTx(tx, actor, audit, {
      locationIds: input.locationIds,
      category: input.category,
      file: { filename: input.filename, bytes: decodePhoto(input.contentBase64) },
      scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
    });
    return {
      batchId: out.batchId,
      results: out.results.map((r) => ({
        ...r,
        operation: r.operation ? toOpOut(r.operation) : null,
      })),
    };
  },
});

export const mediaBatch = defineAction({
  name: "media.batch",
  description:
    "Per-location results of one photo sent to several locations (the batchId media.uploadMany returned) of one workspace (client): for each location its operation status (scheduled, pending, applied or failed with a reason code such as google_http_<n>), the scheduled time and the Google media name once applied. Only locations you can read are listed.",
  input: z.object({ workspaceId: z.uuid(), batchId: z.uuid() }),
  output: z.object({
    items: z.array(
      z.object({
        locationId: z.string(),
        locationName: z.string(),
        operation: opOut,
      }),
    ),
  }),
  permission: "location:read",
  kind: "read",
  async handler({ db, actor }, input) {
    authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const rows = await db
      .select({ op: locationWriteOps, name: locations.name })
      .from(locationWriteOps)
      .innerJoin(locations, eq(locations.id, locationWriteOps.locationId))
      .where(
        and(
          eq(locationWriteOps.batchId, input.batchId),
          eq(locationWriteOps.orgId, actor.orgId),
          eq(locations.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(locations.name, locationWriteOps.id);
    return {
      items: rows.map((r) => ({
        locationId: r.op.locationId,
        locationName: r.name,
        operation: toOpOut(r.op),
      })),
    };
  },
});

export const mediaCancelScheduled = defineAction({
  name: "media.cancelScheduled",
  description:
    "Cancel a photo that is still waiting for its scheduled time (the operation id from media.list or media.batch, status scheduled) in one workspace (client). Moves the operation to the terminal status cancelled and deletes the staged photo bytes. Only works while the status is scheduled: if the minute sweep already took it, nothing changes and cancelled is false (already sent or being sent). Needs profile:edit.",
  input: z.object({ workspaceId: z.uuid(), opId: z.uuid() }),
  output: z.object({
    /** false = the operation was no longer scheduled (already sent, failed or cancelled); nothing changed. */
    cancelled: z.boolean(),
    operation: opOut,
  }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "profile:edit", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    if (scope !== "all" && !scope.includes(input.workspaceId)) {
      throw new CoreError("NOT_FOUND", "Operation not found");
    }
    const [found] = await tx
      .select({ op: locationWriteOps })
      .from(locationWriteOps)
      .innerJoin(locations, eq(locations.id, locationWriteOps.locationId))
      .where(
        and(
          eq(locationWriteOps.id, input.opId),
          eq(locationWriteOps.orgId, actor.orgId),
          eq(locations.workspaceId, input.workspaceId),
          eq(locationWriteOps.domain, "media"),
        ),
      );
    if (!found) throw new CoreError("NOT_FOUND", "Operation not found");
    // Conditional update: a sweep that claimed the op first leaves nothing for this to change.
    const [cancelled] = await tx
      .update(locationWriteOps)
      .set({ status: "cancelled" })
      .where(and(eq(locationWriteOps.id, found.op.id), eq(locationWriteOps.status, "scheduled")))
      .returning();
    if (!cancelled) {
      const [current] = await tx.select().from(locationWriteOps).where(eq(locationWriteOps.id, found.op.id));
      const op = current ?? found.op;
      await audit({
        action: "media.upload_cancel_ignored",
        entityType: "location_write_op",
        entityId: op.id,
        after: { locationId: op.locationId, status: op.status },
      });
      return { cancelled: false, operation: toOpOut(op) };
    }
    const uploadId = (cancelled.payload as { uploadId?: unknown }).uploadId;
    if (typeof uploadId === "string") {
      await tx
        .update(mediaUploads)
        .set({ bytes: null, status: "purged", purgedAt: new Date() })
        .where(and(eq(mediaUploads.id, uploadId), eq(mediaUploads.orgId, actor.orgId)));
    }
    await audit({
      action: "media.upload_cancelled",
      entityType: "location_write_op",
      entityId: cancelled.id,
      before: { status: "scheduled" },
      after: {
        locationId: cancelled.locationId,
        status: "cancelled",
        ...(cancelled.batchId ? { batchId: cancelled.batchId } : {}),
      },
    });
    return { cancelled: true, operation: toOpOut(cancelled) };
  },
});
