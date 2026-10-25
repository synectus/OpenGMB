/**
 * Externally-owned numbers (Google limits, the reply playbook's windows). Logic must read these,
 * never repeat the literals. Re-verify against the source URL and bump `verifiedOn` when you do.
 */
export const GOOGLE_LIMITS = {
  /**
   * Business Profile APIs: 300 queries per minute.
   * Source: https://developers.google.com/my-business/content/limits (each API lists 300 QPM).
   * Checked on our production project after approval (2026-10-18, Service Usage consumerQuotaMetrics):
   * the limit is 300 requests/min PER API per project (each v1 API has its own 300; v4
   * mybusiness.googleapis.com has 600/min). We still budget all APIs together in one 300 bucket:
   * stricter than Google, so safe, only slower for a large fleet.
   */
  projectQpm: {
    limit: 300,
    windowMs: 60_000,
    sourceUrl: "https://developers.google.com/my-business/content/limits",
    verifiedOn: "2026-10-18",
  },
  /**
   * H8 per-account (org) fair-use share of the project quota, fail-fast (the caller gets a typed
   * error, it does not sleep). DERIVED, not a Google number: Google's 300 QPM
   * (re-read 2026-10-24 at the source URL: Business Information, Account Management, Performance,
   * Verifications, Lodging, Place Actions and Notifications APIs each list "300 QPM") is shared by
   * every org on our Cloud project, and we budget all APIs in one 300 bucket. We split it so that
   * `minOrgsAtFullRate` orgs can run flat out at the same time without one starving another:
   * limit = floor(projectQpm / minOrgsAtFullRate). Change `minOrgsAtFullRate` (our policy,
   * decided 2026-10-24: Google calls are free but fair-use limited) or raise the project
   * quota via Google's Quota Increase Request form, then the limit follows.
   * Why 2 (150 per minute, half the project's 300 QPM; the other half stays for everyone else):
   * 10 (30 per minute) broke health and overview loads on 2026-10-24, because each location
   * costs about 6 Google reads per load and a 5-location org hit the cap within a minute.
   */
  orgFairUse: {
    minOrgsAtFullRate: 2,
    limit: Math.floor(300 / 2),
    windowMs: 60_000,
    sourceUrl: "https://developers.google.com/my-business/content/limits",
    verifiedOn: "2026-10-24",
  },
  /**
   * Edits per minute per Business Profile location (quoted: "10 per minute per Google Business
   * Profile (cannot be increased)").
   * Source: https://developers.google.com/my-business/content/limits
   */
  locationEditsPerMinute: {
    limit: 10,
    windowMs: 60_000,
    sourceUrl: "https://developers.google.com/my-business/content/limits",
    verifiedOn: "2026-10-12",
  },
  /**
   * ReviewReply.comment: "The maximum length is 4096 bytes." (UTF-8 bytes, not characters).
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
   */
  replyMaxBytes: {
    limit: 4096,
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews",
    verifiedOn: "2026-10-12",
  },
  /**
   * accounts.locations.list page size: "maximum page size is 100" (default 10).
   * Source: https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list
   */
  locationsListPageSize: {
    limit: 100,
    sourceUrl:
      "https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list",
    verifiedOn: "2026-10-12",
  },
  /**
   * v4 accounts.locations.reviews.list pageSize: "The maximum is 50" (no default documented).
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list
   */
  reviewsListPageSize: {
    limit: 50,
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list",
    verifiedOn: "2026-10-12",
  },
  /**
   * Duplicate-reply window: compare a new reply with the location's last 30 replies. NOT a Google
   * number. Source: our reply playbook, rule U3 (v1
   * 2026-09-27); no public URL.
   */
  duplicateWindowReplies: {
    limit: 30,
    sourceUrl: "none: our own policy, not a Google number",
    verifiedOn: "2026-10-12",
  },
} as const;

export const REPLY_MAX_BYTES = GOOGLE_LIMITS.replyMaxBytes.limit;
export const DUPLICATE_WINDOW_REPLIES = GOOGLE_LIMITS.duplicateWindowReplies.limit;
