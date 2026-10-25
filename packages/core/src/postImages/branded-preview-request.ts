import type { Db } from "@opengmb/db";
import { loadActor } from "../actor";
import { brandedImageInput } from "../actions/postImages";
import { CoreError } from "../errors";
import { AuthError, requireAuthenticatedUser, type SessionResult } from "../session";
import { renderBrandedImage } from "./branded";
import { loadBrandedInputs } from "./branded-inputs";

const MAX_BODY_BYTES = 8 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
const fail = (status: number, code: string, message: string) =>
  json(status, { ok: false, error: { code, message } });

/**
 * Framework-free body of `POST /api/post-images/branded-preview` (JSON, `brandedImageInput`, at most
 * 8 KB). Same session, MFA and error shape as handlePostImageUpload. It reads inside a transaction
 * that writes nothing, renders, and answers with the image bytes. It stores nothing and writes no
 * audit row.
 */
export async function handleBrandedPreview(
  request: Request,
  deps: { db: Db; getSession: () => Promise<SessionResult | null | undefined> },
): Promise<Response> {
  try {
    const { userId } = requireAuthenticatedUser(await deps.getSession());
    if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
      return fail(413, "INVALID_INPUT", "Request is too large");
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return fail(413, "INVALID_INPUT", "Request is too large");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(400, "INVALID_INPUT", "Expected a JSON body");
    }
    const parsed = brandedImageInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(400, "INVALID_INPUT", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
    }
    const input = parsed.data;
    const actor = await loadActor(deps.db, { userId, surface: "ui", actorType: "user" });
    const { photo, logo } = await deps.db.transaction((tx) => loadBrandedInputs(tx, actor, input));
    const out = await renderBrandedImage({
      layout: input.layout,
      headline: input.headline,
      subline: input.subline,
      photo,
      logo,
    });
    return new Response(out.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": out.contentType,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.code === "MFA_REQUIRED" ? 403 : 401, e.code, e.message);
    if (e instanceof CoreError) {
      const status =
        e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : e.code === "INVALID_INPUT" ? 400 : 409;
      return fail(status, e.code, e.message);
    }
    console.error("[post-images] branded preview failed", e);
    return fail(500, "INTERNAL", "Internal error");
  }
}
