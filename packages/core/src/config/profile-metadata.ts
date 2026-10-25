const DISCOVERY = "https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1";

/**
 * Category and attribute metadata reads. Google's numbers carry their source; the rest are ours,
 * chosen so metadata never competes with replies and posts for the shared 300/min project budget
 * (GOOGLE_LIMITS.projectQpm).
 */
export const PROFILE_METADATA = {
  /**
   * Ours. Google's category and attribute lists change rarely; a day bounds each key to one call per
   * process per day.
   */
  cacheTtlMs: 24 * 60 * 60 * 1000,
  /** Ours. Bounds memory; the oldest entry is evicted first. */
  cacheMaxEntries: 500,
  /** Ours. Shorter searches return nothing (no call). */
  searchMinChars: 2,
  /** Ours, and at most Google's categories.list maximum below. */
  searchPageSize: 20,
  /** categories.list pageSize: "Default is 100, minimum is 1, and maximum page size is 100." */
  categoriesPageSizeMax: { limit: 100, sourceUrl: DISCOVERY, verifiedOn: "2026-10-18" },
  /** attributes.list pageSize: "Default is 200, minimum is 1." (no maximum documented) */
  attributesPageSize: { limit: 200, sourceUrl: DISCOVERY, verifiedOn: "2026-10-18" },
  /** Ours. A safety stop for attributes.list paging. */
  attributesMaxPages: 10,
  /** Ours. A location has a primary plus a few additional categories; batchGet takes them in one call. */
  batchGetMaxNames: 10,
  /** Ours. Used only when the location carries neither an address region nor a regional language code. */
  defaultRegionCode: "US",
  defaultLanguageCode: "en",
} as const;
