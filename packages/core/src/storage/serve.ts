import type { Db } from "@opengmb/db";
import { loadActor, type Actor } from "../actor";
import { AuthError, requireAuthenticatedUser, type SessionResult } from "../session";
import { getStoredFileFor } from "./store";

/**
 * Framework-free body of `GET /api/files/<id>`. A session is required; the file must belong to the
 * caller's organization, and a client-scoped caller gets only its own clients' files and the
 * agency's. Anything else is the same plain 404 as a missing id. File ids are never reused (a
 * replaced logo gets a new id), so the bytes behind an id never change and may be cached.
 */
export async function handleFileGet(
  id: string,
  deps: {
    db: Db;
    getSession: () => Promise<SessionResult | null | undefined>;
    /** Who is acting. Defaults to the person's own actor; the web app passes its session actor (a read-only view as a customer reads that customer's files). */
    actorFor?: (userId: string) => Promise<Actor>;
  },
): Promise<Response> {
  try {
    const { userId } = requireAuthenticatedUser(await deps.getSession());
    const actor = await (deps.actorFor ?? ((u) => loadActor(deps.db, { userId: u, surface: "ui", actorType: "user" })))(userId);
    const file = await getStoredFileFor(deps.db, actor, id);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.bytes.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return new Response("Unauthorized", { status: e.code === "MFA_REQUIRED" ? 403 : 401 });
    return new Response("Not found", { status: 404 });
  }
}
