/**
 * Externally-owned facts for photos (P6) and place action links (P8). Logic reads these, never the
 * literals. Re-verify against the source URL and bump `verifiedOn`.
 */
export const MEDIA_LIMITS = {
  /**
   * Categories a caller may create media in. Verified against the v4 `Category` enum. `LOGO` is
   * deprecated: "treated as an alias for PROFILE", so it is not offered. COVER and PROFILE each
   * allow ONE item per location, and the profile photo has the fixed resource name `.../media/profile`.
   * Source: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media
   */
  categories: {
    values: [
      "COVER",
      "PROFILE",
      "EXTERIOR",
      "INTERIOR",
      "PRODUCT",
      "AT_WORK",
      "FOOD_AND_DRINK",
      "MENU",
      "COMMON_AREA",
      "ROOMS",
      "TEAMS",
      "ADDITIONAL",
    ],
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media",
    verifiedOn: "2026-10-13",
  },
  /**
   * Photo requirements shown to the user. Google: "With the exception of PROFILE and COVER
   * category, all photos must measure a minimum of 250px on the short edge, with a file size of at
   * least 10240 bytes." Help page: "Format: JPG or PNG. Size: Between 10 KB and 5 MB.
   * Recommended resolution: 720 px tall, 720 px wide. Minimum resolution: 250 px tall, 250 px wide."
   * We cannot check size or pixels without fetching the URL, and we never fetch a user-supplied URL
   * (SSRF, and Google fetches it anyway), so only the URL scheme and an extension hint are checked.
   */
  photo: {
    formats: ["jpg", "jpeg", "png"],
    minBytes: 10_240,
    maxBytes: 5 * 1024 * 1024,
    minShortEdgePx: 250,
    recommendedPx: 720,
    sourceUrl: "https://support.google.com/business/answer/6103862",
    apiSourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media",
    verifiedOn: "2026-10-13",
  },
  sourceUrlMaxLength: 2000,
  /**
   * Direct upload (bytes from a phone or the MCP). Google v4: media.startUpload (POST, empty body)
   * returns a MediaItemDataRef {resourceName}; the bytes go to
   * POST https://mybusiness.googleapis.com/upload/v1/media/{resourceName}?uploadType=media; then
   * media.create with `dataRef` instead of `sourceUrl`. "Except for the PROFILE and COVER category,
   * all photos must measure a minimum of 250px on the short edge, with a file size of at least
   * 10240 bytes" (so the minimums are skipped for those two categories).
   * Sources: .../v4/accounts.locations.media/startUpload and .../v4/accounts.locations.media
   * (MediaItemDataRef). The reference's curl example spells the query `uploadType=media`.
   * HEIC/HEIF (the iPhone default) is not a documented format, so it is rejected here.
   * Bytes are kept only until Google accepts the upload (then purged); a failed upload's bytes
   * are purged after `failedRetentionDays`.
   */
  upload: {
    contentTypes: ["image/jpeg", "image/png"],
    minimumsExemptCategories: ["COVER", "PROFILE"],
    /** media.upload (base64) input cap: 5 MB is 6.99M base64 characters. */
    maxBase64Chars: 7_000_000,
    filenameMaxLength: 200,
    failedRetentionDays: 7,
    uploadBase: "https://mybusiness.googleapis.com/upload/v1/media",
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/startUpload",
    verifiedOn: "2026-10-13",
  },
  /**
   * media.list: "default value is 100 ... Maximum page size is 2500". customers.list: "default 100,
   * the maximum supported page size is 200". We page with these and stop after maxPages.
   * Sources: .../v4/accounts.locations.media/list and .../media.customers/list
   */
  listPageSize: {
    limit: 100,
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media/list",
    verifiedOn: "2026-10-13",
  },
  customerPageSize: {
    limit: 200,
    sourceUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.media.customers/list",
    verifiedOn: "2026-10-13",
  },
  maxPages: 20,
  /** Operations (add/delete/place action writes) listed next to Google's data. */
  recentOps: 20,
} as const;

/**
 * Place action links. Types per the v1 `PlaceActionType` enum (SOLOPRENEUR_APPOINTMENT also exists
 * there and is not offered here). One link per (uri, type, location); one preferred link per type.
 * Source: https://mybusinessplaceactions.googleapis.com/$discovery/rest?version=v1
 */
export const PLACE_ACTION_LIMITS = {
  uriMaxLength: 2000,
  listPageSize: {
    limit: 100,
    sourceUrl:
      "https://developers.google.com/my-business/reference/placeactions/rest/v1/locations.placeActionLinks/list",
    verifiedOn: "2026-10-13",
  },
  sourceUrl:
    "https://developers.google.com/my-business/reference/placeactions/rest/v1/locations.placeActionLinks",
  verifiedOn: "2026-10-13",
} as const;

/**
 * Food menus (v4 FoodMenus). Text limits and enum values from
 * https://developers.google.com/my-business/reference/rest/v4/FoodMenus (fetched 2026-10-20).
 * Google states no maximum counts; menusMax is our own sanity cap, not Google's.
 */
export const FOOD_MENU_LIMITS = {
  displayNameMax: 140,
  descriptionMax: 1000,
  menusMax: 20,
  spiciness: ["SPICINESS_UNSPECIFIED", "MILD", "MEDIUM", "HOT"],
  allergens: [
    "ALLERGEN_UNSPECIFIED",
    "DAIRY",
    "EGG",
    "FISH",
    "PEANUT",
    "SHELLFISH",
    "SOY",
    "TREE_NUT",
    "WHEAT",
  ],
  dietary: [
    "DIETARY_RESTRICTION_UNSPECIFIED",
    "DAIRY_FREE",
    "GLUTEN_FREE",
    "HALAL",
    "KOSHER",
    "ORGANIC",
    "VEGAN",
    "VEGETARIAN",
  ],
  sourceUrl: "https://developers.google.com/my-business/reference/rest/v4/FoodMenus",
  verifiedOn: "2026-10-20",
} as const;
