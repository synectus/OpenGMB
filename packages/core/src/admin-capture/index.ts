/** Community edition: no admin panel, so nothing is recorded. Same names as the full module. */
import type { Db } from "@opengmb/db";

export async function touchUserActive(_db: Db, _userId: string, _now?: Date): Promise<void> {}

export async function recordConnectionOk(_db: Db, _c: { connectionId: string; orgId: string }, _now?: Date): Promise<void> {}

export async function recordConnectionError(
  _db: Db,
  _c: { connectionId: string; orgId: string },
  _code: string,
  _now?: Date,
): Promise<void> {}

export async function recordOrgGoogleCall(_db: Db, _orgId: string, _now?: Date): Promise<void> {}

export async function recordFailedSignIn(_db: Db, _now?: Date): Promise<void> {}
