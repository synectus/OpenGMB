import { CoreError } from "../errors";

/** Business Profile API returned HTTP 429. `retryAfterMs` is parsed from Retry-After when present. */
export class GoogleRateLimitError extends Error {
  constructor(
    public readonly retryAfterMs?: number,
    public readonly body?: unknown,
  ) {
    super("Google API rate limit exceeded (429)");
    this.name = "GoogleRateLimitError";
  }
}

/** Any other non-2xx from Google. `body` is Google's parsed error body (or raw text). */
export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Google API error ${status}`);
    this.name = "GoogleApiError";
  }
}

/** A refresh-token exchange at Google's token endpoint failed. `body` is `{ error: <OAuth code> }` or null; never a token. */
export class GoogleTokenRefreshError extends GoogleApiError {
  constructor(status: number, body: unknown) {
    super(status, body, "Google token refresh failed");
    this.name = "GoogleTokenRefreshError";
  }
}

/** Thrown by the throttled client once 429 retries are used up. `cause` is the last 429. */
export class GoogleRetriesExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(`Google API still rate limited after ${attempts} attempts`, { cause });
    this.name = "GoogleRetriesExhaustedError";
  }
}

/**
 * A write refused by `ReadOnlyGoogleClient` before any request: live mode with
 * `GOOGLE_BUSINESS_WRITES` not `live`. Still a `CoreError` NOT_CONFIGURED; the class lets jobs
 * tell it from a transient failure and fail at once instead of retrying.
 */
export class GoogleWritesDisabledError extends CoreError {
  constructor(method: string) {
    super("NOT_CONFIGURED", `Google write ${method} refused: GOOGLE_BUSINESS_WRITES is not "live"`);
    this.name = "GoogleWritesDisabledError";
  }
}

/**
 * H8: this org used up its fair share of our shared Google quota. Typed so surfaces show the
 * message and jobs defer (pg-boss retries unclassified errors) instead of failing the work.
 */
export class GoogleOrgLimitError extends CoreError {
  constructor(public readonly retryAfterMs: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
    super(
      "RATE_LIMITED",
      `Google request limit for your account reached, try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
    this.name = "GoogleOrgLimitError";
  }
}

/**
 * OPS2: true when Google, or our own per-org limiter, said "too many requests". Follows `cause`,
 * because the throttled client wraps the last 429 in `GoogleRetriesExhaustedError`.
 */
export function isGoogleRateLimit(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 3) return false;
  if (e instanceof GoogleOrgLimitError || e instanceof GoogleRateLimitError) return true;
  if (e instanceof GoogleRetriesExhaustedError) return true;
  if (e instanceof CoreError && e.code === "RATE_LIMITED") return true;
  if (e instanceof GoogleApiError) {
    if (e.status === 429) return true;
    if (googleErrorStatus(e.body) === "RESOURCE_EXHAUSTED") return true;
  }
  return isGoogleRateLimit((e as { cause?: unknown }).cause, depth + 1);
}

/** Wait Google or the limiter asked for, when the error carries one. */
export function googleRetryAfterMs(e: unknown, depth = 0): number | undefined {
  if (!e || typeof e !== "object" || depth > 3) return undefined;
  const ms = (e as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof ms === "number" && ms > 0) return ms;
  return googleRetryAfterMs((e as { cause?: unknown }).cause, depth + 1);
}

function googleErrorStatus(body: unknown): string | undefined {
  const s = (body as { error?: { status?: unknown } } | null)?.error?.status;
  return typeof s === "string" ? s : undefined;
}

/**
 * OPS2: a plain 403 PERMISSION_DENIED: Google will not share this location's data with the
 * connected account. NOT a 403 that is about the whole project or connection (API disabled, missing
 * scope): those carry an ErrorInfo reason from `notLocationSpecific` and must stay loud.
 */
export function isGooglePermissionDenied(e: unknown, notLocationSpecific: readonly string[]): boolean {
  if (!(e instanceof GoogleApiError) || e.status !== 403) return false;
  const err = (e.body as { error?: { status?: unknown; message?: unknown; details?: { reason?: unknown }[] } } | null)?.error;
  const reasons = (err?.details ?? []).map((d) => d?.reason).filter((r): r is string => typeof r === "string");
  if (reasons.some((r) => notLocationSpecific.includes(r))) return false;
  return err?.status === "PERMISSION_DENIED" || /does not have permission/i.test(String(err?.message ?? e.message));
}

/**
 * OPS3: the connection's refresh token no longer works because the customer removed our access (OAuth
 * `invalid_grant`). Classified by the OAuth code, not the HTTP status. Retrying never helps; only a reconnect does.
 */
export function isGoogleAccessLost(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 3) return false;
  if (e instanceof GoogleTokenRefreshError) return (e.body as { error?: unknown } | null)?.error === "invalid_grant";
  return isGoogleAccessLost((e as { cause?: unknown }).cause, depth + 1);
}

/** OPS3: Google answered 404 to a call about a location (not a token refresh failure). */
export function isGoogleNotFound(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 3) return false;
  if (e instanceof GoogleApiError) return !(e instanceof GoogleTokenRefreshError) && e.status === 404;
  return isGoogleNotFound((e as { cause?: unknown }).cause, depth + 1);
}

/**
 * OPS3 for scheduled per-location reads: why retrying a Google error cannot help, or null when the error is something else
 * (500, 403, rate limit, a bug) and the job must keep failing loudly. Returns a code only, never the error text.
 */
export function googleGoneReason(e: unknown): "google_access_lost" | "google_location_not_found" | null {
  if (isGoogleAccessLost(e)) return "google_access_lost";
  if (isGoogleNotFound(e)) return "google_location_not_found";
  return null;
}
