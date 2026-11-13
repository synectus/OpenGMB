import { and, eq, isNull } from "drizzle-orm";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { apiTokens, jwks, type Db } from "@opengmb/db";
import type { Actor } from "../actor";
import { actorFromTokenRow } from "../apiTokens";
import { AuthError } from "../session";
import type { OAuthAddresses } from "./addresses";

/** The plugin's access-token type header (Phase 0 flow test: `typ: "at+jwt"`). */
const ACCESS_TOKEN_TYP = "at+jwt";
const KEY_CACHE_MS = 10 * 60 * 1000;
const keyCache = new Map<string, { key: Awaited<ReturnType<typeof importJWK>>; alg: string; at: number }>();

const invalid = () => new AuthError("UNAUTHENTICATED", "Invalid token");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Signing key ids written by the jwt plugin are short url-safe ids; anything else is refused before the lookup. */
const KID = /^[A-Za-z0-9_-]{1,128}$/;

/** Allowed clock difference between the database (api_tokens.created_at) and the web container (JWT iat). */
export const IAT_SKEW_SECONDS = 5;

// A key's expiresAt is not checked: the jwt plugin keeps rotated keys for verification, and every token carries its own
// exp (an hour). Only keys that exist in the table can verify.
async function publicKey(db: Db, kid: string, now: number) {
  const hit = keyCache.get(kid);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit;
  const [row] = await db.select({ publicKey: jwks.publicKey, alg: jwks.alg }).from(jwks).where(eq(jwks.id, kid));
  if (!row) return null;
  const alg = row.alg ?? "EdDSA"; // the jwt plugin's default
  const entry = { key: await importJWK(JSON.parse(row.publicKey), alg), alg, at: now };
  keyCache.set(kid, entry);
  return entry;
}

const audienceIs = (aud: JWTPayload["aud"], resource: string) =>
  aud === resource || (Array.isArray(aud) && aud.length === 1 && aud[0] === resource);

/**
 * Spec step 7: verify the JWT against the signing keys in the shared database (no call to the web app), require the
 * audience to be exactly the MCP URL, then load the connection's api_tokens row by (user, app, org). A revoked or
 * missing row is refused at once, so Disconnect does not wait for the token to expire, and a token issued before the row was
 * created (`iat` earlier than `created_at`, in whole seconds) is refused, so reconnecting does not revive an older token.
 * Access comes from the row (step 8), never from the token's scope claim.
 */
export async function verifyOAuthAccessToken(db: Db, token: string, addresses: OAuthAddresses | null, now: Date = new Date()): Promise<Actor> {
  if (!addresses) throw invalid();
  let kid: unknown;
  try {
    const h = decodeProtectedHeader(token);
    if (h.typ !== ACCESS_TOKEN_TYP) throw invalid();
    kid = h.kid;
  } catch {
    throw invalid();
  }
  // kid is attacker-controlled and unsigned at this point: only a plain id may reach the key lookup (a NUL byte or a
  // non-string there is a database error, a 500 that skips the auth-failure limit).
  if (typeof kid !== "string" || !KID.test(kid)) throw invalid();
  let key: Awaited<ReturnType<typeof publicKey>>;
  try {
    key = await publicKey(db, kid, now.getTime());
  } catch {
    throw invalid();
  }
  if (!key) throw invalid();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key.key, {
      issuer: addresses.issuer,
      audience: addresses.resource,
      typ: ACCESS_TOKEN_TYP,
      algorithms: [key.alg],
      currentDate: now,
    }));
  } catch {
    throw invalid();
  }
  if (!audienceIs(payload.aud, addresses.resource)) throw invalid();
  const userId = payload.sub;
  const clientId = typeof payload.azp === "string" ? payload.azp : payload.client_id;
  const orgId = payload.org_id;
  if (typeof userId !== "string" || typeof clientId !== "string" || typeof orgId !== "string") throw invalid();
  // api_tokens.org_id is a uuid: a non-uuid claim (such as the "unchosen" sentinel) would make Postgres throw (a 500).
  if (!UUID.test(orgId)) throw invalid();
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), eq(apiTokens.orgId, orgId), eq(apiTokens.oauthClientId, clientId), isNull(apiTokens.revokedAt)));
  if (!row) throw invalid();
  // The row is matched by (user, app, org) only, so an old unexpired token would match a row made by a later reconnect
  // (Disconnect or member removal, then connect again inside the token's hour). A token minted before this row existed is not its token.
  // created_at comes from the database clock and iat from the web container's clock; allow IAT_SKEW_SECONDS so a
  // database clock running slightly ahead does not refuse a token issued right after consent.
  if (typeof payload.iat !== "number" || payload.iat + IAT_SKEW_SECONDS < Math.floor(row.createdAt.getTime() / 1000)) throw invalid();
  return actorFromTokenRow(db, row, now);
}
