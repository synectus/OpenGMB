import { decryptSecret } from "../crypto";
import { GoogleApiError } from "./errors";
import { getGoogleOAuthConfig } from "./oauth";

const HTTP_TIMEOUT_MS = 10_000;
/** Refresh this long before Google says the token expires. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * Exchanges a connection's stored (encrypted) refresh token for access tokens at the token endpoint
 * from oauth.ts (grant_type=refresh_token) and caches the access token until ~60s before expiry.
 * Concurrent callers share one in-flight refresh. The OAuth config is read per refresh, so test
 * overrides (setGoogleOAuthOverrides) apply.
 */
export function createAccessTokenProvider(
  connection: { refreshTokenEnc: string },
  opts: {
    now?: () => number;
    /** Called after a refresh succeeds / fails (`code` is the OAuth error code, never a token). Must not throw. */
    onRefreshOk?: () => Promise<void>;
    onRefreshError?: (code: string) => Promise<void>;
  } = {},
): () => Promise<string> {
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    try {
      const token = await exchange();
      await opts.onRefreshOk?.();
      return token;
    } catch (e) {
      await opts.onRefreshError?.(errorCode(e));
      throw e;
    }
  }

  async function exchange(): Promise<string> {
    const cfg = getGoogleOAuthConfig();
    const res = await cfg.fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: decryptSecret(connection.refreshTokenEnc),
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    const b = (body ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof b.access_token !== "string" || !b.access_token) {
      // Only the OAuth error code is kept; the body never carries our secrets.
      const err = (body as { error?: unknown } | null)?.error;
      throw new GoogleApiError(
        res.ok ? 502 : res.status,
        typeof err === "string" ? { error: err } : null,
        "Google token refresh failed",
      );
    }
    const ttlMs = (typeof b.expires_in === "number" ? b.expires_in : 3600) * 1000;
    cached = { token: b.access_token, expiresAt: now() + ttlMs };
    return b.access_token;
  }

  return async () => {
    if (cached && now() < cached.expiresAt - ACCESS_TOKEN_SKEW_MS) return cached.token;
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

/** The OAuth error code of a failed refresh, else "refresh_failed". Never the message, which could carry more than a code. */
function errorCode(e: unknown): string {
  if (e instanceof GoogleApiError) {
    const code = (e.body as { error?: unknown } | null)?.error;
    return typeof code === "string" && code ? code : `http_${e.status}`;
  }
  return "refresh_failed";
}
