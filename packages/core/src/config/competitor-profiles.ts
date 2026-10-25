/**
 * K2 part 2: competitor profile refresh (categories, photos, recent posts, rating). Each external fact
 * carries its source URL and the date it was checked; logic reads these, never a literal.
 */
export const COMPETITOR_PROFILES = {
  /** Our choice, not an external fact: how many competitors per tracker are profiled (top by appearances). */
  topPerTracker: 10,
  /** Our choice: the default refresh schedule of a tracker (its `competitor_refresh` column; "manual" turns it off). */
  defaultSchedule: "weekly",
  /** Give up on a task DataForSEO has not answered after this long. */
  giveUpAfterMs: 6 * 3_600_000,
  /** DataForSEO accepts up to 100 tasks per task_post call. */
  maxTasksPerPost: 100,
  dataforseo: {
    info: {
      postPath: "/v3/business_data/google/my_business_info/task_post",
      getPath: "/v3/business_data/google/my_business_info/task_get/",
      /** Response: tasks[].result[].items[] (type google_business_info): category, additional_categories (string[]), category_ids (string[]), total_photos, rating.value, rating.votes_count. */
      standardUsd: 0.0015,
      sourceUrl: "https://docs.dataforseo.com/v3/business_data/google/my_business_info/task_get/",
    },
    updates: {
      postPath: "/v3/business_data/google/my_business_updates/task_post",
      getPath: "/v3/business_data/google/my_business_updates/task_get/",
      /** Response: tasks[].result[].items[] (type google_business_post): timestamp "yyyy-mm-dd hh:mm:ss +00:00"; result[].items_count. Live is not offered. */
      taskUsd: 0.0015,
      per10UpdatesUsd: 0.00075,
      /** `depth` = number of updates parsed (docs default 10). One 10-update block is billed. */
      depth: 10,
      sourceUrl: "https://docs.dataforseo.com/v3/business_data/google/my_business_updates/task_get/",
    },
    /** task_post: keyword takes "place_id:<id>"; a location and a language are required; the location_code follows the tracked business's country (DFS_COUNTRY_LOCATIONS). */
    keywordPrefix: "place_id:",
    languageCode: "en",
    pricingUrl: "https://dataforseo.com/pricing/business-data/business-data-api",
    verifiedOn: "2026-10-24",
    note: "My Business Info Standard $0.0015 per profile; My Business Updates Standard $0.0015 per task + $0.00075 per 10 updates, no Live mode (pricing page and task_get docs, 2026-10-24). A posts count is capped at the requested depth, so it means recent posts, not a lifetime total.",
  },
  timeoutMs: 30_000,
} as const;

/** DataForSEO's cost of profiling one competitor: one info task + one updates task of one 10-update block. */
export const PROFILE_PROVIDER_USD =
  COMPETITOR_PROFILES.dataforseo.info.standardUsd +
  COMPETITOR_PROFILES.dataforseo.updates.taskUsd +
  COMPETITOR_PROFILES.dataforseo.updates.per10UpdatesUsd;
