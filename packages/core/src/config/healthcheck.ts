/**
 * Location healthcheck thresholds. Every number here is OUR OWN choice (a rule of thumb for what a
 * well-kept listing looks like), not a figure Google states; nothing here is a Google limit.
 * Google-owned limits the checks also use are read from their own config
 * (`PROFILE_LIMITS.descriptionMaxChars`, `MEDIA_LIMITS`, `POST_LIMITS`), never repeated here.
 */
export const HEALTHCHECK_CONFIG = {
  /** Owner photos on the listing, counting every category. Our choice. */
  minPhotos: 10,
  /** A photo added within this many days counts as recent. Our choice. */
  recentPhotoDays: 30,
  /** A Google post published within this many days counts as recent. Our choice. */
  recentPostDays: 7,
  /** Reviews window: unreplied reviews and "new review" look at this many days. Our choice. */
  reviewWindowDays: 30,
  /** Average star rating at or above this passes. Our choice. */
  minAverageRating: 4.0,
  /** Posts read from Google: one page only (newest first), this many posts. Our choice. */
  postsPageSize: 20,
  /**
   * `healthcheckSummary` runs the healthcheck for one page of this many locations. Our choice: each
   * location costs about 7 Google reads, so a page is about 175 of the 300 requests a minute the
   * project may spend (config/google-limits.ts). Further pages are reached with `offset`.
   */
  summaryPageSize: 25,
  /**
   * Description quality. Google shows roughly the first 250 characters before "more" on the profile
   * (Google Business Profile Help, "Add business description"), so a shorter text wastes the space.
   * Our reading of that guidance, not a Google limit.
   */
  minDescriptionChars: 250,
  /** More capitals than this share of letters reads as shouting; Google's content policy asks against excessive capitalization. Our threshold. */
  maxUppercaseShare: 0.5,
  /** A word of 4+ letters used more often than this reads as keyword stuffing (Google's policy asks for no stuffing). Our threshold. */
  maxWordRepeats: 4,
  /**
   * Keyword coverage: the top search terms people used to find this listing (Performance, last
   * `keywordMonths` months; Google reports a count only above its own privacy threshold). The
   * description should mention at least `minKeywordCoverage` of the top `keywordTopN`. Our choice.
   */
  keywordTopN: 5,
  keywordMonths: 3,
  minKeywordCoverage: 0.4,
  /** Duplicate listings: name and address similarity (0 to 1, character-bigram Dice) above which two listings of one organisation look the same. Our choice, tuned to catch "Ace Dental" vs "Ace Dental Clinic". */
  duplicateNameSimilarity: 0.7,
  duplicateAddressSimilarity: 0.8,
  /**
   * Category fit, against the categories of the competitors K2 profiles (live data only). Fewer
   * profiled competitors than `categoryFitMinCompetitors` is not enough data: the check is unknown.
   * The listing's primary category should be used (as primary or additional) by at least
   * `categoryPrimaryMinShare` of them, and any category at least `categoryMissingMinShare` of them
   * use should be on the listing. Our choices.
   */
  categoryFitMinCompetitors: 3,
  categoryPrimaryMinShare: 0.5,
  categoryMissingMinShare: 0.5,
  /** Phones are matched on their last N digits, which ignores country code and punctuation. Our choice. */
  phoneMatchDigits: 9,
} as const;
