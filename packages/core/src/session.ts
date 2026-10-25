import { SESSION_ABSOLUTE_MAX_SECONDS } from "./auth";
import { CoreError } from "./errors";

export type AuthErrorCode = "UNAUTHENTICATED" | "MFA_REQUIRED";

export class AuthError extends CoreError {
  declare readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message?: string) {
    super(code, message);
    this.name = "AuthError";
  }
}

/** Structural subset of the Better-Auth getSession() result that the check needs. */
export interface SessionResult {
  session: { createdAt: Date | string; expiresAt: Date | string };
  user: { id: string; email: string; twoFactorEnabled?: boolean | null };
}

/**
 * The single authentication gate. Later layers (action executor, MCP, UI guards)
 * call this with the result of `auth.api.getSession` and only react to its outcome.
 * UNAUTHENTICATED: no session, idle-expired, or older than the 12h absolute cap.
 * MFA_REQUIRED: signed in but TOTP is not enrolled.
 */
export function requireAuthenticatedUser(
  result: SessionResult | null | undefined,
  now: Date = new Date(),
): { userId: string; email: string } {
  if (!result) throw new AuthError("UNAUTHENTICATED", "No session");
  const created = new Date(result.session.createdAt).getTime();
  const expires = new Date(result.session.expiresAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(expires)) {
    throw new AuthError("UNAUTHENTICATED", "Malformed session");
  }
  if (expires <= now.getTime()) throw new AuthError("UNAUTHENTICATED", "Session expired");
  if (now.getTime() - created >= SESSION_ABSOLUTE_MAX_SECONDS * 1000) {
    throw new AuthError("UNAUTHENTICATED", "Session exceeded absolute lifetime");
  }
  if (!result.user.twoFactorEnabled) throw new AuthError("MFA_REQUIRED", "MFA not enrolled");
  return { userId: result.user.id, email: result.user.email };
}
