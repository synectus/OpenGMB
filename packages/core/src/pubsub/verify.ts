import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verification of Pub/Sub authenticated push requests.
 * Docs: https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 * Pub/Sub sends `Authorization: Bearer <OIDC JWT>` signed by Google
 * (JWKS: https://www.googleapis.com/oauth2/v3/certs). The docs' sample checks the signature, `aud`
 * (the audience set on the subscription), `exp`, then that `email` is the push service account and
 * `email_verified` is true. Issuer is `https://accounts.google.com` (the docs' Go sample also
 * accepts `accounts.google.com`).
 */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const CLOCK_TOLERANCE_SECONDS = 30;

export type PubsubVerifyConfig = {
  /** Must equal the audience configured on the push subscription. */
  audience: string;
  /** The service account the subscription's OIDC token is minted for. */
  serviceAccountEmail: string;
  /** Key resolver. Defaults to Google's remote JWKS; tests pass a local set. */
  jwks: JWTVerifyGetKey;
};

export class PubsubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PubsubAuthError";
  }
}

let defaultJwks: JWTVerifyGetKey | undefined;
/** Lazily created remote JWKS (jose caches keys and refetches on unknown `kid`). */
export function googleJwks(): JWTVerifyGetKey {
  defaultJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return defaultJwks;
}

/** Throws PubsubAuthError unless `authorization` carries a valid Pub/Sub OIDC token. */
export async function verifyPubsubToken(
  authorization: string | undefined,
  config: PubsubVerifyConfig,
): Promise<void> {
  const token = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
  if (!token) throw new PubsubAuthError("missing bearer token");
  let payload;
  try {
    ({ payload } = await jwtVerify(token, config.jwks, {
      issuer: ISSUERS,
      audience: config.audience,
      algorithms: ["RS256", "ES256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp"],
    }));
  } catch (e) {
    throw new PubsubAuthError(`token rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (payload.email !== config.serviceAccountEmail) {
    throw new PubsubAuthError("token email is not the expected service account");
  }
  if (payload.email_verified !== true) throw new PubsubAuthError("token email is not verified");
}
