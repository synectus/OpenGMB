import type { Db, Tx } from "@opengmb/db";

/** Community edition: the person signed in to a self-hosted server runs it, so there is no separate admin list. */
export function platformAdminEmails(_env?: string): string[] {
  return [];
}

export async function isPlatformAdmin(_db: Db | Tx, _userId: string, _env?: string): Promise<boolean> {
  return true;
}
