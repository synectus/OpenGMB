import "server-only";
import { headers } from "next/headers";
import { CoreError, executeAction, loadActor, requireAuthenticatedUser } from "@opengmb/core";
import { getAuth, getDb } from "./auth";

export type ActionResult =
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/**
 * The one place web server actions enter core: session -> requireAuthenticatedUser ->
 * loadActor(ui) -> executeAction. The generated actions file only calls this.
 */
export async function runAction(name: string, input: unknown): Promise<ActionResult> {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    const { userId } = requireAuthenticatedUser(session);
    const db = getDb();
    const actor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
    return { ok: true, data: await executeAction(db, actor, name, input) };
  } catch (e) {
    if (e instanceof CoreError) return { ok: false, error: { code: e.code, message: e.message } };
    console.error(`[web] action ${name} failed`, e);
    return { ok: false, error: { code: "INTERNAL", message: "Internal error" } };
  }
}
