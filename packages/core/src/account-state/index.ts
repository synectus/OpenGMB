/** Community edition: no admin panel, so no account is ever suspended or deleted. Same names as the full module. */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db, Tx } from "@opengmb/db";

export type BlockedReason = "user_disabled" | "org_suspended";

export const BLOCKED_MESSAGES: Record<BlockedReason, string> = {
  org_suspended: "This account is suspended. Contact support.",
  user_disabled: "Sign-in is turned off for this user.",
};

export async function isOrgBlocked(_db: Db | Tx, _orgId: string): Promise<boolean> {
  return false;
}

export async function isOrgPurged(_db: Db | Tx, _orgId: string): Promise<boolean> {
  return false;
}

export async function blockedReason(_db: Db | Tx, _userId: string): Promise<BlockedReason | null> {
  return null;
}

export async function isUserBlocked(_db: Db | Tx, _userId: string): Promise<boolean> {
  return false;
}

export function orgIsActive(_orgIdColumn: AnyColumn): SQL {
  return sql`true`;
}
