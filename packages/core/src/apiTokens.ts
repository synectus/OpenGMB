import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { apiTokens, organizations, users, type Db, type Tx } from "@opengmb/db";
import {
  AccessError,
  DEFAULT_TOKEN_MODE,
  authorize,
  loadActor,
  type Actor,
  type TokenMode,
  type TokenScope,
} from "./actor";
import { writeAudit } from "./audit";
import { CoreError } from "./errors";
import { roleHasPermission } from "./permissions";
import type { ActionAuditEntry } from "./registry";
import { AuthError, requireAuthenticatedUser } from "./session";

export const API_TOKEN_PREFIX = "sgmb_";

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

type AuditFn = (entry: ActionAuditEntry) => Promise<void>;

type TokenRow = typeof apiTokens.$inferSelect;

/** Audit/output projection of a token row. Explicit allow-list: tokenHash can never leak. */
function publicRow(r: TokenRow) {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    name: r.name,
    scopes: r.scopes,
    mode: r.mode,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  };
}

const toView = (r: TokenRow, ownerEmail: string) => ({
  id: r.id,
  name: r.name,
  ownerUserId: r.userId,
  ownerEmail,
  scopes: r.scopes as TokenScope[],
  mode: r.mode as TokenMode,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});
export type ApiTokenView = ReturnType<typeof toView>;

/**
 * Token policy (the only place it lives):
 * - every role may list/create/revoke its OWN tokens (`api_token:manage_own`);
 * - owner/admin (`api_token:manage_org`) may also list and revoke ANY token in their org,
 *   but never create tokens for another user;
 * - a caller authenticated by an API token may not create tokens: a leaked token could mint
 *   a replacement that outlives its own revocation. Revoking is allowed.
 */
export async function listApiTokens(tx: Tx, actor: Actor): Promise<ApiTokenView[]> {
  authorize(actor, "api_token:manage_own");
  const all = roleHasPermission(actor.role, "api_token:manage_org");
  const rows = await tx
    .select({ token: apiTokens, email: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      all
        ? eq(apiTokens.orgId, actor.orgId)
        : and(eq(apiTokens.orgId, actor.orgId), eq(apiTokens.userId, actor.userId)),
    )
    .orderBy(desc(apiTokens.createdAt));
  return rows.map((r) => toView(r.token, r.email));
}

/** Also called by apiTokens.create's preview, so an MCP caller is refused before a proposal exists. */
export function assertNotApiTokenCaller(actor: Pick<Actor, "actorType">) {
  if (actor.actorType === "api_token") {
    throw new AccessError(
      "FORBIDDEN",
      "API tokens cannot create API tokens; create one in the web app or with pnpm token:create",
    );
  }
}

/**
 * Scopes a new token gets. `read` is always present; omitted means read+write, except for a
 * client_viewer, whose tokens are read-only: asking a viewer for `write` is FORBIDDEN, not silently
 * downgraded.
 */
export function resolveNewTokenScopes(
  actor: Pick<Actor, "role">,
  requested?: readonly TokenScope[],
): TokenScope[] {
  if (actor.role === "client_viewer") {
    if (requested?.includes("write")) {
      throw new AccessError("FORBIDDEN", "client_viewer API tokens are read-only");
    }
    return ["read"];
  }
  return requested?.includes("write") || !requested ? ["read", "write"] : ["read"];
}

/** Scopes a token really has: a client_viewer's are read-only whatever the row says. */
export function effectiveScopes(role: Actor["role"], stored: readonly string[]): TokenScope[] {
  if (role === "client_viewer" || !stored.includes("write")) return ["read"];
  return ["read", "write"];
}

/** Mint a token for the actor themselves. The plaintext is returned once; only its hash is stored. */
export async function createApiTokenFor(
  tx: Tx,
  actor: Actor,
  name: string,
  audit: AuditFn,
  requestedScopes?: readonly TokenScope[],
  mode: TokenMode = DEFAULT_TOKEN_MODE,
) {
  authorize(actor, "api_token:manage_own");
  assertNotApiTokenCaller(actor);
  const [owner] = await tx.select().from(users).where(eq(users.id, actor.userId));
  if (!owner) throw new CoreError("NOT_FOUND", "User not found");
  const scopes = resolveNewTokenScopes(actor, requestedScopes);
  const token = generateApiToken();
  const [created] = await tx
    .insert(apiTokens)
    .values({
      orgId: actor.orgId,
      userId: actor.userId,
      name,
      scopes,
      mode,
      tokenHash: hashApiToken(token),
    })
    .returning();
  await audit({
    action: "api_token.create",
    entityType: "api_token",
    entityId: created!.id,
    before: null,
    after: publicRow(created!),
  });
  return { token, apiToken: toView(created!, owner.email) };
}

export async function revokeApiTokenFor(tx: Tx, actor: Actor, id: string, audit: AuditFn) {
  authorize(actor, "api_token:manage_own");
  const [found] = await tx
    .select({ token: apiTokens, email: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.id, id));
  // Another org's token looks exactly like a missing one.
  if (!found || found.token.orgId !== actor.orgId) {
    throw new AccessError("NOT_FOUND", "API token not found");
  }
  if (
    found.token.userId !== actor.userId &&
    !roleHasPermission(actor.role, "api_token:manage_org")
  ) {
    throw new AccessError("FORBIDDEN", "You can only revoke your own API tokens");
  }
  if (found.token.revokedAt) throw new CoreError("CONFLICT", "API token is already revoked");
  const [revoked] = await tx
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning();
  if (!revoked) throw new CoreError("CONFLICT", "API token is already revoked");
  await audit({
    action: "api_token.revoke",
    entityType: "api_token",
    entityId: id,
    before: publicRow(found.token),
    after: publicRow(revoked),
  });
  return { apiToken: toView(revoked, found.email) };
}

/** Audit writer for code that bypasses the action registry (CLI): surface 'cli', actor_type 'user'. */
function cliAudit(tx: Tx, actor: Actor): AuditFn {
  return async (entry) => {
    await writeAudit(tx, {
      ...entry,
      orgId: actor.orgId,
      actorUserId: actor.userId,
      actorType: "user",
      surface: "cli",
    });
  };
}

/** `pnpm token:create`: same core function as the action, audited as surface 'cli'. */
export async function createApiToken(
  db: Db,
  input: { email: string; name?: string; readOnly?: boolean; mode?: TokenMode },
) {
  const [user] = await db.select().from(users).where(eq(users.email, input.email));
  if (!user) throw new CoreError("NOT_FOUND", `No user with email ${input.email}`);
  // Throws FORBIDDEN (no membership) or INVALID_INPUT (several orgs) rather than guessing.
  const actor = await loadActor(db, { userId: user.id, surface: "ui", actorType: "user" });
  const name = input.name?.trim() || "mcp";
  if (name.length > 100) throw new CoreError("INVALID_INPUT", "name: at most 100 characters");
  const { token, apiToken } = await db.transaction((tx) =>
    createApiTokenFor(tx, actor, name, cliAudit(tx, actor), input.readOnly ? ["read"] : undefined, input.mode),
  );
  return { token, row: apiToken };
}

export type ActiveTokenMatch = {
  id: string;
  name: string;
  ownerUserId: string;
  orgId: string;
  ownerEmail: string;
  orgName: string;
  createdAt: Date;
};

/** Every ACTIVE (not revoked) token with this exact name, across all orgs. */
export async function findActiveTokensByName(db: Db, name: string): Promise<ActiveTokenMatch[]> {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      ownerUserId: apiTokens.userId,
      orgId: apiTokens.orgId,
      ownerEmail: users.email,
      orgName: organizations.name,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .innerJoin(organizations, eq(organizations.id, apiTokens.orgId))
    .where(and(eq(apiTokens.name, name), isNull(apiTokens.revokedAt)))
    .orderBy(asc(apiTokens.createdAt));
}

export type RevokeResolution =
  | { kind: "none" }
  | { kind: "one"; match: ActiveTokenMatch }
  | { kind: "ambiguous"; matches: ActiveTokenMatch[]; next: "email" | "id" };

/**
 * Pure disambiguation for `pnpm token:revoke`. Narrow by --id, then --email; exactly one left
 * is the target. Several left asks for --email first, and for --id once --email was given.
 */
export function resolveRevokeTarget(
  matches: readonly ActiveTokenMatch[],
  opts: { email?: string; id?: string } = {},
): RevokeResolution {
  let left = [...matches];
  if (opts.id) left = left.filter((m) => m.id === opts.id);
  if (opts.email) {
    const email = opts.email.trim().toLowerCase();
    left = left.filter((m) => m.ownerEmail.toLowerCase() === email);
  }
  if (left.length === 0) return { kind: "none" };
  if (left.length === 1) return { kind: "one", match: left[0]! };
  return { kind: "ambiguous", matches: left, next: opts.email ? "id" : "email" };
}

/** `pnpm token:revoke`: revoke as the token's owner through the same core function, surface 'cli'. */
export async function revokeApiTokenAsCli(db: Db, match: ActiveTokenMatch) {
  const actor = await loadActor(db, {
    userId: match.ownerUserId,
    orgId: match.orgId,
    surface: "ui",
    actorType: "user",
  });
  return db.transaction((tx) => revokeApiTokenFor(tx, actor, match.id, cliAudit(tx, actor)));
}

/**
 * Bearer token -> Actor for the MCP surface. Throws AuthError('UNAUTHENTICATED') for an
 * unknown or revoked token; the owner must still pass the same 2FA gate as a web session.
 */
export async function verifyApiToken(db: Db, token: string): Promise<Actor> {
  if (!token.startsWith(API_TOKEN_PREFIX)) throw new AuthError("UNAUTHENTICATED", "Invalid token");
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hashApiToken(token)), isNull(apiTokens.revokedAt)));
  if (!row) throw new AuthError("UNAUTHENTICATED", "Invalid token");

  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  if (!user) throw new AuthError("UNAUTHENTICATED", "Invalid token");
  // Reuse the session gate: a token is not a session, so present a fresh synthetic one and
  // let requireAuthenticatedUser enforce what it owns (2FA enrolment).
  const now = new Date();
  requireAuthenticatedUser({
    session: { createdAt: now, expiresAt: new Date(now.getTime() + 60_000) },
    user: { id: user.id, email: user.email, twoFactorEnabled: user.twoFactorEnabled },
  });

  await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
  const actor = await loadActor(db, {
    userId: row.userId,
    orgId: row.orgId,
    surface: "mcp",
    actorType: "api_token",
    apiTokenId: row.id,
  });
  return {
    ...actor,
    scopes: effectiveScopes(actor.role, row.scopes),
    tokenMode: row.mode as TokenMode,
  };
}
