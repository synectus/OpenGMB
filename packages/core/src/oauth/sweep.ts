import { and, inArray, lt, sql } from "drizzle-orm";
import { oauthClients, type Db } from "@opengmb/db";

export const OAUTH_CLIENT_SWEEP = { queue: "oauth.client_sweep", cron: "23 3 * * *", unusedDays: 30 } as const;

/**
 * Spec, Security: open registration means anyone can create clients. A client that no api_tokens row names (it never
 * completed consent) and that is older than 30 days is deleted; its consents, refresh tokens and resource links go with
 * it (foreign keys cascade). A client any row names, live or revoked, is kept: Connected apps and the audit refer to it.
 * `clientIds` narrows the sweep for tests; production sweeps every client.
 */
export async function sweepUnusedOAuthClients(
  db: Db,
  opts: { now?: Date; clientIds?: string[] } = {},
): Promise<{ checked: number; deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - OAUTH_CLIENT_SWEEP.unusedDays * 86_400_000);
  const scope = opts.clientIds ? inArray(oauthClients.clientId, opts.clientIds) : undefined;
  const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(oauthClients).where(scope);
  const gone = await db
    .delete(oauthClients)
    .where(
      and(
        scope,
        lt(sql`coalesce(${oauthClients.createdAt}, now())`, sql`${cutoff.toISOString()}::timestamptz`),
        sql`not exists (select 1 from api_tokens t where t.oauth_client_id = ${oauthClients.clientId})`,
      ),
    )
    .returning({ id: oauthClients.id });
  return { checked: counted?.n ?? 0, deleted: gone.length };
}
