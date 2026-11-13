import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  apiTokens,
  memberships,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  organizations,
  users,
  type Db,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, loadActor, type Actor, type TokenMode } from "../actor";
import { assertNotApiTokenCaller, hashApiToken, resolveNewTokenScopes } from "../apiTokens";
import { writeAudit } from "../audit";
import { CoreError } from "../errors";
import { roleHasPermission } from "../permissions";
import type { ActionAuditEntry } from "../registry";

export type ConnectionAccess = "read" | "write";
export type ConnectableOrg = { orgId: string; name: string; readOnly: boolean };

const auditView = (r: typeof apiTokens.$inferSelect) => ({
  id: r.id,
  name: r.name,
  oauthClientId: r.oauthClientId,
  redirectHost: r.redirectHost,
  scopes: r.scopes,
  mode: r.mode,
  revokedAt: r.revokedAt,
});

/** The registered name of an OAuth app (what the consent page shows), or null when the client id is unknown. apps/web has no drizzle-orm, so the lookup lives here. */
export async function oauthClientName(db: Db, clientId: string): Promise<{ name: string | null } | null> {
  const [row] = await db.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return row ?? null;
}

/** The organizations a person may connect an app to, for the consent page. */
export async function connectableOrgs(db: Db, userId: string): Promise<ConnectableOrg[]> {
  const ids = (
    await db
      .selectDistinct({ orgId: memberships.orgId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
  ).map((r) => r.orgId);
  if (ids.length === 0) return [];
  const names = new Map(
    (
      await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, ids))
    ).map((o) => [o.id, o.name]),
  );
  const out: ConnectableOrg[] = [];
  for (const orgId of ids) {
    try {
      const actor = await loadActor(db, { userId, orgId, surface: "ui", actorType: "user" });
      if (!roleHasPermission(actor.role, "api_token:manage_own")) continue;
      out.push({
        orgId,
        name: names.get(orgId) ?? orgId,
        readOnly: actor.role === "client_viewer",
      });
    } catch (e) {
      if (e instanceof AccessError) continue; // blocked org
      throw e;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Consent step 5: create or update the connection's api_tokens row. One live row per person, org and app; reconnecting
 * updates it; a revoked row is never revived (a new one is inserted). The row's token_hash is the hash of a random
 * secret that is thrown away, so no sgmb_ token can match it (the pattern of the assistant's row, ai/assistant.ts).
 */
export async function approveConnection(
  db: Db,
  input: {
    userId: string;
    orgId: string;
    clientId: string;
    clientName: string;
    redirectHost: string;
    access: ConnectionAccess;
    fullAutonomy: boolean;
  },
): Promise<{ id: string; created: boolean }> {
  const actor = await loadActor(db, {
    userId: input.userId,
    orgId: input.orgId,
    surface: "ui",
    actorType: "user",
  });
  if (!roleHasPermission(actor.role, "api_token:manage_own")) {
    throw new AccessError("FORBIDDEN", `Role ${actor.role} cannot connect apps`);
  }
  const scopes = resolveNewTokenScopes(
    actor,
    input.access === "write" ? ["read", "write"] : ["read"],
  );
  const mode: TokenMode =
    input.fullAutonomy && scopes.includes("write") ? "full_autonomy" : "human_in_the_loop";
  const name = input.clientName.trim().slice(0, 100) || input.redirectHost;
  return db.transaction(async (tx) => {
    const [live] = await tx
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, input.userId),
          eq(apiTokens.orgId, input.orgId),
          eq(apiTokens.oauthClientId, input.clientId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .for("update");
    const values = { name, scopes, mode, redirectHost: input.redirectHost };
    const [row] = live
      ? await tx.update(apiTokens).set(values).where(eq(apiTokens.id, live.id)).returning()
      : await tx
          .insert(apiTokens)
          .values({
            ...values,
            orgId: input.orgId,
            userId: input.userId,
            oauthClientId: input.clientId,
            tokenHash: hashApiToken(randomBytes(32).toString("base64url")),
          })
          .returning();
    await writeAudit(tx, {
      orgId: input.orgId,
      actorUserId: input.userId,
      actorType: "user",
      surface: "ui",
      action: "oauth_app.connect",
      entityType: "api_token",
      entityId: row!.id,
      before: live ? auditView(live) : null,
      after: auditView(row!),
    });
    return { id: row!.id, created: !live };
  });
}

/**
 * End the plugin-side grants of a person in an org (optionally one app): delete consents so the next authorize shows
 * our consent page again (and creates a new row), and revoke refresh and opaque access tokens. Called by member removal
 * (PR 1) and Disconnect (PR 2). Purge does not call it: it erases every OAuth api_tokens row of the org and clears the
 * grants of anonymised people only; a retained shared member keeps consents and refresh tokens whose reference is the
 * purged org, which is harmless because the org is blocked and MCP finds no row (401).
 */
export async function endOAuthGrants(
  tx: Tx,
  scope: { userId: string; orgId: string; clientId?: string | null },
) {
  const now = new Date();
  const consents = await tx
    .delete(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, scope.userId),
        eq(oauthConsents.referenceId, scope.orgId),
        scope.clientId ? eq(oauthConsents.clientId, scope.clientId) : undefined,
      ),
    )
    .returning({ id: oauthConsents.id });
  const refresh = await tx
    .update(oauthRefreshTokens)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthRefreshTokens.userId, scope.userId),
        eq(oauthRefreshTokens.referenceId, scope.orgId),
        isNull(oauthRefreshTokens.revoked),
        scope.clientId ? eq(oauthRefreshTokens.clientId, scope.clientId) : undefined,
      ),
    )
    .returning({ id: oauthRefreshTokens.id });
  const access = await tx
    .update(oauthAccessTokens)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthAccessTokens.userId, scope.userId),
        eq(oauthAccessTokens.referenceId, scope.orgId),
        isNull(oauthAccessTokens.revoked),
        scope.clientId ? eq(oauthAccessTokens.clientId, scope.clientId) : undefined,
      ),
    )
    .returning({ id: oauthAccessTokens.id });
  return { consents: consents.length, refreshTokens: refresh.length, accessTokens: access.length };
}

type AuditFn = (entry: ActionAuditEntry) => Promise<void>;

const appView = (r: typeof apiTokens.$inferSelect, ownerEmail: string) => ({
  id: r.id,
  name: r.name,
  redirectHost: r.redirectHost,
  ownerUserId: r.userId,
  ownerEmail,
  access: (r.scopes.includes("write") ? "write" : "read") as ConnectionAccess,
  fullAutonomy: r.mode === "full_autonomy",
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});
export type ConnectedAppView = ReturnType<typeof appView>;

/** Live OAuth connections in the caller's org: their own, or everyone's for an owner or admin. Ordinary tokens are apiTokens.list. */
export async function listConnectedApps(tx: Tx, actor: Actor): Promise<ConnectedAppView[]> {
  authorize(actor, "api_token:manage_own");
  const all = roleHasPermission(actor.role, "api_token:manage_org");
  const rows = await tx
    .select({ t: apiTokens, email: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.orgId, actor.orgId),
        isNotNull(apiTokens.oauthClientId),
        isNull(apiTokens.revokedAt),
        all ? undefined : eq(apiTokens.userId, actor.userId),
      ),
    )
    .orderBy(desc(apiTokens.createdAt));
  return rows.map((r) => appView(r.t, r.email));
}

/** One OAuth connection of the caller's org, locked. An ordinary token or another org's row looks like a missing one. */
async function lockedApp(tx: Tx, actor: Actor, id: string) {
  const [found] = await tx
    .select({ t: apiTokens, email: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.id, id), eq(apiTokens.orgId, actor.orgId), isNotNull(apiTokens.oauthClientId)))
    .for("update", { of: apiTokens });
  if (!found) throw new AccessError("NOT_FOUND", "Connected app not found");
  return found;
}

/** Change a connection's access and autonomy. Only its owner, in the web app: an API-token or connected-app caller must not raise its own rights. */
export async function updateConnectedApp(
  tx: Tx,
  actor: Actor,
  input: { id: string; access: ConnectionAccess; fullAutonomy: boolean },
  audit: AuditFn,
) {
  authorize(actor, "api_token:manage_own");
  assertNotApiTokenCaller(actor);
  const found = await lockedApp(tx, actor, input.id);
  if (found.t.userId !== actor.userId) throw new AccessError("NOT_FOUND", "Connected app not found");
  if (found.t.revokedAt) throw new CoreError("CONFLICT", "This app is disconnected");
  const scopes = resolveNewTokenScopes(actor, input.access === "write" ? ["read", "write"] : ["read"]);
  const mode: TokenMode = input.fullAutonomy && scopes.includes("write") ? "full_autonomy" : "human_in_the_loop";
  const [row] = await tx.update(apiTokens).set({ scopes, mode }).where(eq(apiTokens.id, input.id)).returning();
  await audit({ action: "oauth_app.update", entityType: "api_token", entityId: input.id, before: auditView(found.t), after: auditView(row!) });
  return { app: appView(row!, found.email) };
}

/** Disconnect: revoke the row (verify refuses at once), end the plugin-side grants, audit. Owner or admin may do it for anyone in the org. */
export async function disconnectConnectedApp(tx: Tx, actor: Actor, id: string, audit: AuditFn) {
  authorize(actor, "api_token:manage_own");
  const found = await lockedApp(tx, actor, id);
  if (found.t.userId !== actor.userId && !roleHasPermission(actor.role, "api_token:manage_org")) {
    throw new AccessError("FORBIDDEN", "You can only disconnect your own apps");
  }
  if (found.t.revokedAt) throw new CoreError("CONFLICT", "This app is already disconnected");
  const [row] = await tx
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning();
  if (!row) throw new CoreError("CONFLICT", "This app is already disconnected");
  // Revoking the row is what cuts access; this also stops refreshes and forces consent next time.
  await endOAuthGrants(tx, { userId: row.userId, orgId: row.orgId, clientId: row.oauthClientId });
  await audit({ action: "oauth_app.disconnect", entityType: "api_token", entityId: id, before: auditView(found.t), after: auditView(row) });
  return { disconnected: true };
}
