import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { googleConnections, googleOauthStates, type Db, type Tx } from "@opengmb/db";
import { authorize, loadActor } from "../actor";
import { writeAudit } from "../audit";
import { decryptSecret, encryptSecret } from "../crypto";
import { GOOGLE_OAUTH_BRAND } from "../config/google-oauth-brand";
import { CoreError } from "../errors";

export const BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";
const REQUESTED_SCOPE = `openid email ${BUSINESS_MANAGE_SCOPE}`;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

/** Endpoints confirmed against https://accounts.google.com/.well-known/openid-configuration. */
export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  userinfoUrl: string;
  fetch: typeof fetch;
};

let overrides: Partial<GoogleOAuthConfig> = {};
/** Tests point the flow at a fake OAuth server. Pass {} to reset. */
export function setGoogleOAuthOverrides(o: Partial<GoogleOAuthConfig>) {
  overrides = o;
}

/** Env defaults merged with overrides; read per call so a changed env is picked up. */
export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    redirectUri: base ? `${base}/api/google/callback` : "",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    fetch: (...args) => fetch(...args),
    ...overrides,
  };
}

export function isGoogleConnectConfigured(cfg: GoogleOAuthConfig = getGoogleOAuthConfig()) {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

function requireConfigured(cfg: GoogleOAuthConfig) {
  if (!isGoogleConnectConfigured(cfg)) {
    throw new CoreError("NOT_CONFIGURED", "Google OAuth is not configured");
  }
}

export type GoogleOAuthReason =
  | "invalid_state"
  | "exchange_failed"
  | "missing_scope"
  | "missing_refresh_token"
  | "userinfo_failed";

/** A failed connect attempt. `reason` is safe to show; it never carries Google response bodies. */
export class GoogleOAuthError extends CoreError {
  constructor(
    public readonly reason: GoogleOAuthReason,
    message: string,
  ) {
    super("INVALID_INPUT", message);
    this.name = "GoogleOAuthError";
  }
}

const b64url = (b: Buffer) => b.toString("base64url");

export function buildAuthUrl(
  cfg: GoogleOAuthConfig,
  p: { state: string; codeChallenge: string },
): string {
  const u = new URL(cfg.authUrl);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: REQUESTED_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    state: p.state,
  }).toString();
  return u.toString();
}

/** Store a fresh single-use state for (org, user) and return the URL to send the user to. */
export async function startGoogleConnection(tx: Tx, p: { orgId: string; userId: string }) {
  const cfg = getGoogleOAuthConfig();
  requireConfigured(cfg);
  // Housekeeping: states are useless after expiry; keep a day for forensics.
  await tx
    .delete(googleOauthStates)
    .where(lt(googleOauthStates.expiresAt, new Date(Date.now() - 24 * 3600 * 1000)));
  const stateId = b64url(randomBytes(32));
  const codeVerifier = b64url(randomBytes(32));
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  await tx
    .insert(googleOauthStates)
    .values({ id: stateId, orgId: p.orgId, userId: p.userId, codeVerifier, expiresAt });
  const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());
  return { stateId, expiresAt, authUrl: buildAuthUrl(cfg, { state: stateId, codeChallenge }) };
}

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; scope?: unknown };

async function postForm(cfg: GoogleOAuthConfig, url: string, body: Record<string, string>) {
  return cfg.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/** Explicit allow-list: the only connection fields that may enter audit rows or action output. */
function connectionAuditView(r: typeof googleConnections.$inferSelect) {
  return {
    id: r.id,
    googleAccountId: r.googleAccountId,
    email: r.googleAccountEmail,
    scopes: r.scopes,
    connectedByUserId: r.userId,
  };
}
export { connectionAuditView as googleConnectionAuditView };

/**
 * Finish the connect flow. The state row is consumed first and in its own statement, so a
 * failed exchange still burns it (the authorization code is single-use at Google anyway), and
 * no database transaction is held open across the network calls. Persisting the connection and
 * its audit row then happen in one transaction.
 */
export async function completeGoogleConnection(
  db: Db,
  input: { stateId: string; code: string; sessionUserId: string },
) {
  const cfg = getGoogleOAuthConfig();
  requireConfigured(cfg);

  const [state] = await db
    .update(googleOauthStates)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(googleOauthStates.id, input.stateId),
        eq(googleOauthStates.userId, input.sessionUserId),
        isNull(googleOauthStates.usedAt),
        gt(googleOauthStates.expiresAt, sql`now()`),
      ),
    )
    .returning();
  if (!state) {
    throw new GoogleOAuthError(
      "invalid_state",
      "This connection request is invalid, expired or already used. Start again.",
    );
  }

  // The user may have lost the role since they started.
  const actor = await loadActor(db, {
    userId: state.userId,
    orgId: state.orgId,
    surface: "ui",
    actorType: "user",
  });
  authorize(actor, "google:manage");

  let tokens: TokenResponse;
  try {
    const res = await postForm(cfg, cfg.tokenUrl, {
      code: input.code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: state.codeVerifier,
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    tokens = (await res.json()) as TokenResponse;
  } catch {
    throw new GoogleOAuthError("exchange_failed", "Google rejected the sign-in. Start again.");
  }

  const granted = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  if (!granted.includes(BUSINESS_MANAGE_SCOPE)) {
    throw new GoogleOAuthError(
      "missing_scope",
      "Missing permission: tick the Business Profile box on Google's consent screen and try again.",
    );
  }
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
    throw new GoogleOAuthError(
      "missing_refresh_token",
      `Google did not return a refresh token. Remove ${GOOGLE_OAUTH_BRAND.appName.value} at https://myaccount.google.com/permissions and try again.`,
    );
  }
  const refreshToken = tokens.refresh_token;

  let sub: string;
  let email: string;
  try {
    if (typeof tokens.access_token !== "string") throw new Error("no access token");
    const res = await cfg.fetch(cfg.userinfoUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`userinfo ${res.status}`);
    const info = (await res.json()) as { sub?: unknown; email?: unknown };
    if (
      typeof info.sub !== "string" ||
      !info.sub ||
      typeof info.email !== "string" ||
      !info.email
    ) {
      throw new Error("userinfo missing sub or email");
    }
    sub = info.sub;
    email = info.email;
  } catch {
    throw new GoogleOAuthError(
      "userinfo_failed",
      "Could not read the Google account. Start again.",
    );
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(googleConnections)
      .where(
        and(eq(googleConnections.orgId, state.orgId), eq(googleConnections.googleAccountId, sub)),
      );
    const values = {
      userId: state.userId,
      googleAccountEmail: email,
      refreshTokenEnc: encryptSecret(refreshToken),
      scopes: granted,
    };
    const [row] = await tx
      .insert(googleConnections)
      .values({ orgId: state.orgId, googleAccountId: sub, ...values })
      .onConflictDoUpdate({
        target: [googleConnections.orgId, googleConnections.googleAccountId],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    await writeAudit(tx, {
      orgId: state.orgId,
      actorUserId: state.userId,
      actorType: "user",
      surface: "ui",
      action: existing ? "google_connection.update" : "google_connection.create",
      entityType: "google_connection",
      entityId: row!.id,
      before: existing ? connectionAuditView(existing) : null,
      after: connectionAuditView(row!),
    });
    return { connectionId: row!.id, email, created: !existing };
  });
}

/**
 * Best-effort revoke of a stored refresh token at Google. Never throws; false means the caller
 * must tell the user to remove access at https://myaccount.google.com/permissions.
 */
export async function revokeStoredRefreshToken(refreshTokenEnc: string): Promise<boolean> {
  try {
    const cfg = getGoogleOAuthConfig();
    const res = await postForm(cfg, cfg.revokeUrl, { token: decryptSecret(refreshTokenEnc) });
    return res.ok;
  } catch {
    return false;
  }
}
