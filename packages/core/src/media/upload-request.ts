import { z } from "zod";
import type { Db } from "@opengmb/db";
import { loadActor } from "../actor";
import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import { AuthError, requireAuthenticatedUser, type SessionResult } from "../session";
import { toOpOut } from "../actions/media";
import { stageMediaUpload, stageMediaUploads } from "./upload";

/** Multipart framing around a file is small; this is slack on top of the 5 MB photo cap. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
const fail = (status: number, code: string, message: string) =>
  json(status, { ok: false, error: { code, message } });

/**
 * Framework-free body of `POST /api/media/upload` (multipart/form-data: locationId, category,
 * file). Order: session + MFA (requireAuthenticatedUser: 401 no session, 403 MFA not enrolled),
 * a cheap size check on Content-Length, parse, then core's stageMediaUpload, which authorizes
 * (profile:edit, workspace scope) before it validates or stores anything. The web route only
 * supplies the session and the database.
 */
export async function handleMediaUploadRequest(
  request: Request,
  deps: { db: Db; getSession: () => Promise<SessionResult | null | undefined> },
): Promise<Response> {
  try {
    const { userId } = requireAuthenticatedUser(await deps.getSession());
    const maxBody = MEDIA_LIMITS.photo.maxBytes + MULTIPART_OVERHEAD_BYTES;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > maxBody) return fail(413, "INVALID_INPUT", "Photo is larger than 5 MB");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "INVALID_INPUT", "Expected multipart/form-data");
    }
    const locationIds = form.getAll("locationId");
    const locationId = locationIds[0];
    const scheduledForRaw = form.get("scheduledFor");
    const category = form.get("category");
    const file = form.get("file");
    if (
      typeof locationId !== "string" ||
      typeof category !== "string" ||
      typeof file === "string" ||
      !file
    ) {
      return fail(400, "INVALID_INPUT", "locationId, category and file are required");
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      locationIds.length > 50 ||
      !locationIds.every((l) => typeof l === "string" && UUID.test(l))
    ) {
      return fail(400, "INVALID_INPUT", "locationId must be a UUID (at most 50)");
    }
    if (
      scheduledForRaw !== null &&
      (typeof scheduledForRaw !== "string" ||
        !z.iso.datetime({ offset: true }).safeParse(scheduledForRaw).success)
    ) {
      return fail(400, "INVALID_INPUT", "scheduledFor must be an ISO datetime with offset");
    }
    if (file.size > MEDIA_LIMITS.photo.maxBytes) {
      return fail(413, "INVALID_INPUT", "Photo is larger than 5 MB");
    }
    const actor = await loadActor(deps.db, { userId, surface: "ui", actorType: "user" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (locationIds.length > 1 || scheduledForRaw !== null) {
      // Several locations and/or a later time: one op per location, each with its own result.
      const many = await stageMediaUploads(deps.db, actor, {
        locationIds: locationIds as string[],
        category,
        file: { filename: file.name, bytes },
        scheduledFor: scheduledForRaw ? new Date(scheduledForRaw as string) : null,
      });
      return json(202, {
        ok: true,
        batchId: many.batchId,
        results: many.results.map((r) => ({
          ...r,
          operation: r.operation ? toOpOut(r.operation) : null,
        })),
      });
    }
    const staged = await stageMediaUpload(deps.db, actor, {
      locationId: locationId as string,
      category,
      file: { filename: file.name, bytes },
    });
    return json(202, { ok: true, uploadId: staged.uploadId, operation: toOpOut(staged.operation) });
  } catch (e) {
    if (e instanceof AuthError) {
      return fail(e.code === "MFA_REQUIRED" ? 403 : 401, e.code, e.message);
    }
    if (e instanceof CoreError) {
      const status =
        e.code === "NOT_FOUND"
          ? 404
          : e.code === "FORBIDDEN"
            ? 403
            : e.code === "INVALID_INPUT"
              ? 400
              : 409;
      return fail(status, e.code, e.message);
    }
    console.error("[media] upload failed", e);
    return fail(500, "INTERNAL", "Internal error");
  }
}
