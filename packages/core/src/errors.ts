export type CoreErrorCode =
  | "UNAUTHENTICATED"
  | "MFA_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED";

/** Base of every typed error thrown by packages/core. Surfaces map `code` to their own transport. */
export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CoreError";
  }
}
