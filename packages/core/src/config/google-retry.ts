/**
 * OPS2: how worker jobs behave when Google (or our own per-org limiter) says "slow down", and how
 * long a location whose Google account is not allowed to read some data is left alone.
 * Our own choices unless a source URL says otherwise.
 */
export const GOOGLE_RETRY = {
  /**
   * First wait after a rate limit. Our per-org limiter window is 60 s (GOOGLE_LIMITS.orgFairUse), so
   * 70 s is the first moment a fresh window is certain. Each further attempt doubles it.
   */
  baseDelaySec: 70,
  backoffFactor: 2,
  /** Upper bound on one wait. */
  maxDelaySec: 1800,
  /** Re-queues of one job before it fails for real (and alerts). 70, 140, 280, 560, 1120 s. */
  maxAttempts: 5,
  /**
   * Scheduled fan-outs queue one job per location. Within one org, location number i starts i * this
   * many seconds after the first, so a 25-location account does not burst into the 150/min limiter.
   * Different orgs do not delay each other.
   */
  staggerSecondsPerLocation: 2,
  /** Longest stagger for one location. */
  maxStaggerSeconds: 3600,
} as const;

/**
 * A location whose connected Google account gets a plain 403 PERMISSION_DENIED for a data type is
 * left alone this many days, then re-checked once.
 */
export const GOOGLE_ACCESS_CONFIG = {
  recheckDays: 7,
  /** Data types that can be marked. */
  resources: ["performance", "place_actions"],
  /**
   * 403 reasons that are NOT about one location: the API is off for our project or the connection's
   * scopes are short. These must keep failing loudly, never mark a location.
   */
  notLocationSpecificReasons: ["SERVICE_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "API_KEY_SERVICE_BLOCKED", "RATE_LIMIT_EXCEEDED", "RATE_LIMIT"],
  /**
   * Source for the wording of the note. Checked 2026-10-25: the Performance API reference lists only
   * the business.manage scope and says nothing about owner, manager or verification, so the note
   * does not claim a cause; it says what we saw and what to check.
   */
  sourceUrl: "https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries",
  verifiedOn: "2026-10-25",
} as const;

export type GoogleAccessResource = (typeof GOOGLE_ACCESS_CONFIG.resources)[number];
