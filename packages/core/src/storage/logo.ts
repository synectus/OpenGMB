import type { Db } from "@opengmb/db";
import { authorize, loadActor, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { STORED_FILE_MAX_BYTES } from "../config/storage-limits";
import { CoreError } from "../errors";
import { AuthError, requireAuthenticatedUser, type SessionResult } from "../session";
import { putStoredFile, StorageQuotaError } from "./store";

/**
 * Upload or replace a logo: the organization's (workspaceId null) or one client's. Needs
 * branding:manage (owner, admin). The old logo is deleted in the same transaction.
 */
export async function uploadLogo(db: Db, actor: Actor, input: { workspaceId: string | null; bytes: Uint8Array }) {
  authorize(actor, "branding:manage", input.workspaceId ? { workspaceId: input.workspaceId } : {});
  return db.transaction(async (tx) => {
    const file = await putStoredFile(tx, actor, { kind: "logo", workspaceId: input.workspaceId, bytes: input.bytes });
    if (!file.deduped) {
      await writeAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        actorType: actor.actorType,
        surface: actor.surface,
        action: "storage.logo_uploaded",
        entityType: "stored_file",
        entityId: file.id,
        before: file.replacedId ? { replacedFileId: file.replacedId } : null,
        after: {
          workspaceId: input.workspaceId,
          contentType: file.contentType,
          byteSize: file.byteSize,
          sha256: file.sha256,
        },
      });
    }
    return file;
  });
}

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
const fail = (status: number, code: string, message: string, extra: object = {}) =>
  json(status, { ok: false, error: { code, message, ...extra } });

/**
 * Framework-free body of `POST /api/files/logo` (multipart/form-data: file, optional workspaceId;
 * no workspaceId means the agency logo). Session + MFA, a cheap Content-Length check, parse, then
 * uploadLogo, which authorizes before it validates.
 */
export async function handleLogoUpload(
  request: Request,
  deps: { db: Db; getSession: () => Promise<SessionResult | null | undefined> },
): Promise<Response> {
  try {
    const { userId } = requireAuthenticatedUser(await deps.getSession());
    const max = STORED_FILE_MAX_BYTES.logo;
    const tooBig = () => fail(413, "INVALID_INPUT", `File is larger than ${max / 1024 / 1024} MB`);
    if (Number(request.headers.get("content-length") ?? "0") > max + MULTIPART_OVERHEAD_BYTES) return tooBig();
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "INVALID_INPUT", "Expected multipart/form-data");
    }
    const file = form.get("file");
    const ws = form.get("workspaceId");
    if (typeof file === "string" || !file) return fail(400, "INVALID_INPUT", "file is required");
    if (ws !== null && (typeof ws !== "string" || !UUID.test(ws))) {
      return fail(400, "INVALID_INPUT", "workspaceId must be a UUID");
    }
    if (file.size > max) return tooBig();
    const actor = await loadActor(deps.db, { userId, surface: "ui", actorType: "user" });
    const row = await uploadLogo(deps.db, actor, {
      workspaceId: ws,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json(201, { ok: true, file: { id: row.id, contentType: row.contentType, byteSize: row.byteSize } });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.code === "MFA_REQUIRED" ? 403 : 401, e.code, e.message);
    if (e instanceof StorageQuotaError) {
      return fail(413, e.code, e.message, { usedBytes: e.usedBytes, limitBytes: e.limitBytes });
    }
    if (e instanceof CoreError) {
      const status =
        e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : e.code === "INVALID_INPUT" ? 400 : 409;
      return fail(status, e.code, e.message);
    }
    console.error("[files] logo upload failed", e);
    return fail(500, "INTERNAL", "Internal error");
  }
}
