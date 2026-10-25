import type { ThrottledGoogleClient } from "../google/throttled-client";
import { assertHttpsUrl } from "../locationOps/access";
import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import type { GoogleMediaItem } from "../google/client";

/**
 * The ONLY place outside the Google client implementations that creates or deletes location media
 * on Google. A test (`reply-enforcement.test.ts`) fails if any other source file calls
 * `.createMedia(`, `.deleteMedia(`, `.startMediaUpload(`, `.uploadMediaBytes(` or `.uploadMedia(`. Writes go through the throttled client (per-location edit
 * bucket + idempotency key `media:<opId>`). The content check for a URL source is the URL: https, no
 * credentials, a JPG/PNG extension if there is one, and a category from Google's list; there is no
 * text to run guardrails on. A photo is sourced either by URL (Google fetches it) or from staged
 * bytes (`publishMediaUpload`: startUpload, upload, create with a dataRef, as one idempotent write).
 */
export type MediaWriter = Pick<
  ThrottledGoogleClient,
  "createMedia" | "deleteMedia" | "uploadMedia"
>;

export const mediaKey = (opId: string) => `media:${opId}`;

type Where = { orgId: string; opId: string };

export function publishMediaCreate(
  client: MediaWriter,
  where: Where & { parent: string },
  item: { sourceUrl: string; category: string },
): Promise<GoogleMediaItem> {
  assertHttpsUrl(item.sourceUrl, { maxLength: MEDIA_LIMITS.sourceUrlMaxLength, imageHint: true });
  if (!(MEDIA_LIMITS.categories.values as readonly string[]).includes(item.category)) {
    throw new CoreError("INVALID_INPUT", `Unknown media category ${item.category}`);
  }
  return client.createMedia(
    where.parent,
    {
      mediaFormat: "PHOTO",
      locationAssociation: { category: item.category },
      sourceUrl: item.sourceUrl,
    },
    { orgId: where.orgId, idempotencyKey: mediaKey(where.opId) },
  );
}

/**
 * Direct upload. Bytes were validated when staged (magic bytes, size, pixels); this only re-checks
 * the content type and category. The throttled client runs startUpload, the byte upload and create
 * under one idempotency key `media:<opId>`.
 */
export function publishMediaUpload(
  client: MediaWriter,
  where: Where & { parent: string },
  file: { bytes: Uint8Array; contentType: string; sha256: string; category: string },
): Promise<GoogleMediaItem> {
  if (!(MEDIA_LIMITS.categories.values as readonly string[]).includes(file.category)) {
    throw new CoreError("INVALID_INPUT", `Unknown media category ${file.category}`);
  }
  if (!(MEDIA_LIMITS.upload.contentTypes as readonly string[]).includes(file.contentType)) {
    throw new CoreError("INVALID_INPUT", "Only JPG and PNG photos can be uploaded");
  }
  return client.uploadMedia(
    where.parent,
    { mediaFormat: "PHOTO", locationAssociation: { category: file.category } },
    file,
    { orgId: where.orgId, idempotencyKey: mediaKey(where.opId) },
  );
}

export function publishMediaDelete(
  client: MediaWriter,
  where: Where & { parent: string },
  mediaName: string,
): Promise<void> {
  if (!mediaName.startsWith(`${where.parent}/media/`)) {
    throw new CoreError("INVALID_INPUT", "Media item belongs to another location");
  }
  return client.deleteMedia(mediaName, {
    orgId: where.orgId,
    idempotencyKey: mediaKey(where.opId),
  });
}
