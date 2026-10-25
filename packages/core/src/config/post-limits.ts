/**
 * Externally-owned numbers and facts for Google Business Profile local posts. Logic must read
 * these, never repeat the literals. Re-verify against the source URL and bump `verifiedOn`.
 */
export const POST_LIMITS = {
  /**
   * Summary length. USER RULE (Synectus): 1,500 characters (Unicode code points, not UTF-16 units
   * and not bytes). Google's v4 LocalPost reference states NO maximum for `summary`, so there is no
   * Google number to compare with; if Google ever documents a different limit, record it here and
   * keep this value (the user rule wins).
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
   */
  summaryMaxChars: {
    limit: 1500,
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts",
    verifiedOn: "2026-10-24",
  },
  /**
   * One image per post. USER RULE. Google's docs show a single PHOTO media item in every example
   * and state no limit.
   * Source: https://developers.google.com/my-business/content/posts-data
   */
  maxImages: {
    limit: 1,
    sourceUrl: "https://developers.google.com/my-business/content/posts-data",
    verifiedOn: "2026-10-12",
  },
  /** Our own bound on localPosts.list paging (pages of listPageSize), not a Google number. */
  listMaxPages: 20,
  /**
   * localPosts.list pageSize: default 20, minimum 1, maximum 100. Confirmed live on 2026-10-18:
   * no pageSize returned 20 with a nextPageToken; pageSize 100 returned all 139 posts in two pages.
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/list
   */
  listPageSize: {
    limit: 100,
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/list",
    verifiedOn: "2026-10-18",
  },
  /**
   * Phone numbers in post text. Google Help: "Posts that include a phone number in the post
   * description might get rejected" (when Google cannot confirm the number belongs to the
   * business). Synectus rule: never put a phone number in the text; use the CALL button, which
   * uses the location's phone.
   * Source: https://support.google.com/business/answer/7662907
   */
  phoneInText: {
    sourceUrl: "https://support.google.com/business/answer/7662907",
    verifiedOn: "2026-10-12",
  },
  /**
   * ALERT posts: `alertType` applies only to ALERT; the only AlertType is COVID_19, which "supports
   * only summary and call to action". "New COVID-19 alert creation is disabled, though existing
   * posts can still be managed", and the ALERT topic is "not always available for authoring".
   * So a new ALERT post will likely be rejected by Google.
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
   */
  alert: {
    alertTypes: ["COVID_19"],
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts",
    verifiedOn: "2026-10-12",
  },
  /**
   * `event` is "Required for topic types EVENT and OFFER" (title + schedule: start and end date
   * and time, all four fields required in TimeInterval). `callToAction` is "Ignored for topic type
   * OFFER". CALL actions leave `url` unset.
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
   */
  eventRequiredFor: ["EVENT", "OFFER"],
  ctaActionTypes: ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"],
  /** Calendar guards (ours, not Google's). */
  calendarMaxWindowDays: 366,
  calendarMaxEntries: 1000,
} as const;

export const POST_MAX_CHARS = POST_LIMITS.summaryMaxChars.limit;
export const POST_MAX_IMAGES = POST_LIMITS.maxImages.limit;
