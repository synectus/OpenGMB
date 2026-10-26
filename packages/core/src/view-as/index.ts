/** Community edition: no admin panel, so no session is ever viewing as an admin. Same names as the full module. */
import type { Db } from "@opengmb/db";

export type ActiveViewAs = { orgId: string; orgName: string; adminUserId: string; expiresAt: Date };

export async function activeViewAs(_db: Db, _sessionId: string, _now?: Date, _env?: string): Promise<ActiveViewAs | null> {
  return null;
}
