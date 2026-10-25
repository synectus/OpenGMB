import type { Db } from "@opengmb/db";
import { loadActor } from "../actor";
import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import { AuthError, requireAuthenticatedUser, type SessionResult } from "../session";
import { createPostImage, publicPostImageUrl } from "./store";

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
const fail = (status: number, code: string, message: string) =>
  json(status, { ok: false, error: { code, message } });

/**
 * Framework-free body of `POST /api/post-images` (multipart/form-data: workspaceId, file). Same
 * order as handleMediaUploadRequest: session + MFA, a cheap Content-Length check, parse, then
 * core's createPostImage, which authorizes (review:draft on the workspace) before it validates.
 */
export async function handlePostImageUpload(
  request: Request,
  deps: { db: Db; getSession: () => Promise<SessionResult | null | undefined> },
): Promise<Response> {
  try {
    const { userId } = requireAuthenticatedUser(await deps.getSession());
    const maxBody = MEDIA_LIMITS.photo.maxBytes + MULTIPART_OVERHEAD_BYTES;
    if (Number(request.headers.get("content-length") ?? "0") > maxBody) {
      return fail(413, "INVALID_INPUT", "Photo is larger than 5 MB");
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "INVALID_INPUT", "Expected multipart/form-data");
    }
    const workspaceId = form.get("workspaceId");
    const file = form.get("file");
    if (typeof workspaceId !== "string" || typeof file === "string" || !file) {
      return fail(400, "INVALID_INPUT", "workspaceId and file are required");
    }
    if (!UUID.test(workspaceId)) return fail(400, "INVALID_INPUT", "workspaceId must be a UUID");
    if (file.size > MEDIA_LIMITS.photo.maxBytes) {
      return fail(413, "INVALID_INPUT", "Photo is larger than 5 MB");
    }
    const actor = await loadActor(deps.db, { userId, surface: "ui", actorType: "user" });
    const row = await createPostImage(deps.db, actor, {
      workspaceId,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json(201, {
      ok: true,
      image: {
        id: row.id,
        name: row.name,
        url: publicPostImageUrl(row.token),
        contentType: row.contentType,
        byteSize: row.byteSize,
        width: row.width,
        height: row.height,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.code === "MFA_REQUIRED" ? 403 : 401, e.code, e.message);
    if (e instanceof CoreError) {
      const status =
        e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : e.code === "INVALID_INPUT" ? 400 : 409;
      return fail(status, e.code, e.message);
    }
    console.error("[post-images] upload failed", e);
    return fail(500, "INTERNAL", "Internal error");
  }
}
