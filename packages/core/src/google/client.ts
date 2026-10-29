/** Shapes modelled on Business Profile API v1 (mybusinessaccountmanagement / mybusinessbusinessinformation). */
export interface GoogleAccount {
  /** Resource name, `accounts/{id}`. */
  name: string;
  accountName: string;
  type: "PERSONAL" | "LOCATION_GROUP" | "USER_GROUP" | "ORGANIZATION";
  role: "OWNER" | "CO_OWNER" | "MANAGER" | "COMMUNITY_MANAGER";
  state: { status: "VERIFIED" | "UNVERIFIED" | "VERIFICATION_REQUESTED" };
  verificationState: string;
  vettedState: string;
}

/**
 * Business Information API v1 Location sub-resources, verified 2026-10-13 against the discovery
 * document https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1.
 */
export interface GoogleTimeOfDay {
  /** 0-24 (24 only with minutes 0, as a closing time). Proto3 JSON omits zero values. */
  hours?: number;
  minutes?: number;
}
export interface GoogleDate {
  year?: number;
  month?: number;
  day?: number;
}
export const GOOGLE_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export type GoogleDay = (typeof GOOGLE_DAYS)[number];
export interface GoogleTimePeriod {
  openDay: string;
  openTime: GoogleTimeOfDay;
  closeDay: string;
  closeTime: GoogleTimeOfDay;
}
export interface GoogleSpecialHourPeriod {
  startDate: GoogleDate;
  endDate?: GoogleDate;
  openTime?: GoogleTimeOfDay;
  closeTime?: GoogleTimeOfDay;
  closed?: boolean;
}
export interface GoogleCategory {
  /** Stable id, e.g. `categories/gcid:dentist`. The only field a write needs. */
  name: string;
  /** Output only. */
  displayName?: string;
}
export interface GoogleServiceItem {
  structuredServiceItem?: { serviceTypeId: string; description?: string };
  freeFormServiceItem?: {
    category: string;
    label: { displayName: string; description?: string; languageCode?: string };
  };
  price?: { currencyCode?: string; units?: string; nanos?: number };
}

/**
 * Attributes resource (`locations/{l}/attributes`). Each attribute is addressed as `attributes/{id}`
 * in the attributeMask; the value lives in `values` (BOOL, ENUM), `uriValues` (URL) or
 * `repeatedEnumValue` (REPEATED_ENUM). `valueType` is output only.
 */
export interface GoogleAttribute {
  name: string;
  valueType?: "BOOL" | "ENUM" | "URL" | "REPEATED_ENUM";
  values?: unknown[];
  uriValues?: { uri: string }[];
  repeatedEnumValue?: { setValues?: string[]; unsetValues?: string[] };
}
export interface GoogleAttributes {
  /** `locations/{l}/attributes` */
  name: string;
  attributes?: GoogleAttribute[];
}

/** Business Information v1 `Category` as categories.list / batchGet return it (view FULL adds serviceTypes). */
export interface GoogleCategoryMetadata {
  name: string;
  displayName?: string;
  serviceTypes?: { serviceTypeId: string; displayName?: string }[];
}
export interface ListCategoriesResponse {
  categories: GoogleCategoryMetadata[];
  nextPageToken?: string;
}
export type CategoryView = "BASIC" | "FULL";
/** Business Information v1 `AttributeMetadata` (attributes.list). */
export interface GoogleAttributeMetadata {
  parent: string;
  valueType?: "ATTRIBUTE_VALUE_TYPE_UNSPECIFIED" | "BOOL" | "ENUM" | "URL" | "REPEATED_ENUM";
  displayName?: string;
  groupDisplayName?: string;
  repeatable?: boolean;
  valueMetadata?: { value: unknown; displayName?: string }[];
  deprecated?: boolean;
}
export interface ListAttributeMetadataResponse {
  attributeMetadata: GoogleAttributeMetadata[];
  nextPageToken?: string;
}

export interface GoogleLocation {
  /** Resource name, `locations/{id}`. */
  name: string;
  /** Owning account resource name. Not in the real Location resource; set by the mock and by live list calls only. */
  account?: string;
  title: string;
  storeCode?: string;
  languageCode?: string;
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] };
  /** `profile.description` is the business description. */
  profile?: { description?: string };
  /** Updating categories needs both fields set (Google rejects a mask on just one of them). */
  categories?: {
    primaryCategory?: GoogleCategory;
    additionalCategories?: GoogleCategory[];
  };
  storefrontAddress?: {
    regionCode: string;
    postalCode?: string;
    administrativeArea?: string;
    locality?: string;
    addressLines?: string[];
    /**
     * Other PostalAddress parts (sublocality, languageCode, organization, recipients, sortingCode ...).
     * The patch replaces the whole address, so they are carried through unchanged.
     */
    [part: string]: unknown;
  };
  websiteUri?: string;
  regularHours?: { periods: GoogleTimePeriod[] };
  specialHours?: { specialHourPeriods: GoogleSpecialHourPeriod[] };
  serviceItems?: GoogleServiceItem[];
  serviceArea?: {
    businessType: "CUSTOMER_LOCATION_ONLY" | "CUSTOMER_AND_BUSINESS_LOCATION";
    places?: { placeInfos: { placeName: string; placeId: string }[] };
  };
  /** `openInfo.openingDate` is editable; `status` is required by Google when openInfo is sent whole. */
  openInfo?: {
    status?: "OPEN" | "CLOSED_PERMANENTLY" | "CLOSED_TEMPORARILY";
    openingDate?: GoogleDate;
  };
  /** Read-only here. Google fills it from the address, and a location may not have one. Needs `latlng` in the readMask. */
  latlng?: { latitude: number; longitude: number };
  metadata?: { placeId?: string; mapsUri?: string; hasVoiceOfMerchant?: boolean };
}

/** Notifications v1 NotificationSetting (accounts/{id}/notificationSetting). */
export interface GoogleNotificationSetting {
  name: string;
  pubsubTopic?: string;
  notificationTypes?: string[];
}

export interface ListAccountsResponse {
  accounts: GoogleAccount[];
  nextPageToken?: string;
}

export interface ListLocationsResponse {
  locations: GoogleLocation[];
  nextPageToken?: string;
  totalSize?: number;
}

/** v4 `StarRating` enum as Google sends it. The client layer maps it to 1-5 / null; see reviews.ts. */
export type GoogleStarRatingEnum =
  "STAR_RATING_UNSPECIFIED" | "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";

/** v4 Review exactly as the API sends it (starRating is still the enum). Fixtures use this shape. */
export interface RawGoogleReview {
  /** `accounts/{a}/locations/{l}/reviews/{r}` */
  name: string;
  reviewId: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: GoogleStarRatingEnum;
  comment?: string;
  /** RFC 3339 */
  createTime: string;
  updateTime: string;
  reviewReply?: {
    comment: string;
    updateTime: string;
    /**
     * Google's moderation of the reply. Not in the v4 reference; observed live on 2026-10-18:
     * "APPROVED", or "REJECTED" with `policyViolation` "ACCOUNT_RESTRICTED_AND_EDIT_REJECTED".
     * A rejected reply is stored by Google but not shown to customers.
     */
    reviewReplyState?: string;
    policyViolation?: string;
  };
}

/** A review as the rest of the code sees it: starRating is 1-5, or null when unspecified. */
export interface GoogleReview extends Omit<RawGoogleReview, "starRating"> {
  starRating: number | null;
}

export interface ListReviewsResponse {
  reviews: GoogleReview[];
  averageRating?: number;
  totalReviewCount?: number;
  nextPageToken?: string;
}

/** Business Profile Performance API v1 `DailyMetric` values we read (DAILY_METRIC_UNKNOWN excluded). */
export const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
] as const;
export type DailyMetric = (typeof DAILY_METRICS)[number];

/** `YYYY-MM-DD` (calendar day, no timezone). Days Google omits (zero) may be absent. */
export interface DailyMetricSeries {
  metric: DailyMetric;
  points: { date: string; value: number }[];
}

export interface FetchDailyMetricsResponse {
  series: DailyMetricSeries[];
}

/** One monthly search keyword: exactly one of `value` (unique users) or `threshold` (actual is below it). */
export interface SearchKeywordCount {
  keyword: string;
  value?: number;
  threshold?: number;
}

export interface ListSearchKeywordsResponse {
  keywords: SearchKeywordCount[];
  nextPageToken?: string;
}

/**
 * v4 LocalPost (accounts/{a}/locations/{l}/localPosts/{p}), the fields we model. Verified
 * 2026-10-12 against developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts.
 */
export type GoogleLocalPostTopicType = "STANDARD" | "EVENT" | "OFFER" | "ALERT";
export type GoogleCallToActionType = "BOOK" | "ORDER" | "SHOP" | "LEARN_MORE" | "SIGN_UP" | "CALL";
export type GoogleLocalPostState = "REJECTED" | "LIVE" | "PROCESSING" | "SCHEDULED" | "RECURRING";

export interface GoogleLocalPost {
  /** Output only: `accounts/{a}/locations/{l}/localPosts/{p}` */
  name?: string;
  languageCode?: string;
  summary?: string;
  /** Ignored by Google for OFFER posts. `url` is unset for CALL. */
  callToAction?: { actionType: GoogleCallToActionType; url?: string };
  createTime?: string;
  updateTime?: string;
  /** Google can schedule natively; Synectus schedules in its own queue and never sets this. */
  scheduledTime?: string;
  /** Required for EVENT and OFFER. All four TimeInterval fields are required by Google. */
  event?: {
    title: string;
    schedule: {
      startDate: { year: number; month: number; day: number };
      startTime: { hours: number; minutes: number; seconds?: number; nanos?: number };
      endDate: { year: number; month: number; day: number };
      endTime: { hours: number; minutes: number; seconds?: number; nanos?: number };
    };
  };
  /** Output only. */
  state?: GoogleLocalPostState;
  /** Sent with sourceUrl; Google answers with name + googleUrl (observed live 2026-10-18). */
  media?: {
    mediaFormat: "PHOTO" | "VIDEO";
    sourceUrl: string;
    name?: string;
    googleUrl?: string;
  }[];
  /** Output only. */
  searchUrl?: string;
  topicType: GoogleLocalPostTopicType;
  /** ALERT only. COVID_19 is the only value. */
  alertType?: "COVID_19";
  /** OFFER only. */
  offer?: { couponCode?: string; redeemOnlineUrl?: string; termsConditions?: string };
}

export interface ListLocalPostsResponse {
  localPosts: GoogleLocalPost[];
  nextPageToken?: string;
}

/**
 * Business Information API v1 `locations.getGoogleUpdated` (verified 2026-10-13 against the discovery
 * document): the location as it appears live on Maps and Search. `diffMask` lists the fields whose
 * consumer-facing value differs from the merchant's; `pendingMask` the merchant's own edits still in
 * flight. "To accept these changes, patch the location. To reject, patch with your preferred values."
 */
export interface GoogleUpdatedLocation {
  location: GoogleLocation;
  /** Comma-separated google-fieldmask, absent when nothing differs. */
  diffMask?: string;
  pendingMask?: string;
}

/**
 * v4 MediaItem, the fields we model (fetched 2026-10-13 from
 * developers.google.com/my-business/reference/rest/v4/accounts.locations.media). `LOGO` is a
 * deprecated alias of `PROFILE`; Google maps it, so we never send it.
 */
export type GoogleMediaCategory =
  | "COVER"
  | "PROFILE"
  | "EXTERIOR"
  | "INTERIOR"
  | "PRODUCT"
  | "AT_WORK"
  | "FOOD_AND_DRINK"
  | "MENU"
  | "COMMON_AREA"
  | "ROOMS"
  | "TEAMS"
  | "ADDITIONAL";
export interface GoogleMediaItem {
  /** Output only: `accounts/{a}/locations/{l}/media/{key}`; profile photos use the fixed key `profile`. */
  name?: string;
  mediaFormat?: "PHOTO" | "VIDEO";
  locationAssociation?: { category?: string; priceListItemId?: string };
  /** Output only, Google-hosted, not stable. */
  googleUrl?: string;
  thumbnailUrl?: string;
  createTime?: string;
  dimensions?: { widthPixels?: number; heightPixels?: number };
  /** Output only, customer media only. Google requires showing it unaltered. */
  attribution?: {
    profileName?: string;
    profilePhotoUrl?: string;
    takedownUrl?: string;
    profileUrl?: string;
  };
  description?: string;
  /** Input: a publicly accessible URL. Exactly one of `sourceUrl` and `dataRef` is set on create. */
  sourceUrl?: string;
  /** Input: bytes uploaded through startMediaUpload + uploadMediaBytes. */
  dataRef?: GoogleMediaDataRef;
}
/** v4 MediaItemDataRef: "The unique ID for this media item's binary data" (from media.startUpload). */
export interface GoogleMediaDataRef {
  resourceName: string;
}
export interface ListMediaResponse {
  mediaItems: GoogleMediaItem[];
  totalMediaItemCount?: number;
  nextPageToken?: string;
}

/**
 * My Business Verifications API v1 (discovery document fetched 2026-10-13).
 * `locations.getVoiceOfMerchantState`: GET v1/{name}/VoiceOfMerchantState. The sub-states
 * (waitForVoiceOfMerchant, resolveOwnershipConflict) are empty messages: presence is the signal.
 * proto3 JSON omits false booleans.
 */
export interface GoogleVoiceOfMerchantState {
  hasVoiceOfMerchant?: boolean;
  hasBusinessAuthority?: boolean;
  waitForVoiceOfMerchant?: Record<string, never>;
  verify?: { hasPendingVerification?: boolean };
  complyWithGuidelines?: { recommendationReason?: string };
  resolveOwnershipConflict?: Record<string, never>;
}
/**
 * Account Management v1 `locations.admins.list` item (reference fetched 2026-10-21,
 * developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts.admins).
 * `admin` is the email while the invitation is pending and the person's name otherwise.
 */
export interface GoogleAdmin {
  /** `locations/{l}/admins/{id}` */
  name: string;
  admin?: string;
  role?: "ADMIN_ROLE_UNSPECIFIED" | "PRIMARY_OWNER" | "OWNER" | "MANAGER" | "SITE_MANAGER";
  pendingInvitation?: boolean;
}
/** `locations.verifications.list` item. */
export interface GoogleVerification {
  name: string;
  method?: string;
  state?: "STATE_UNSPECIFIED" | "PENDING" | "COMPLETED" | "FAILED";
  createTime?: string;
  announcement?: string;
}
export interface ListVerificationsResponse {
  verifications: GoogleVerification[];
  nextPageToken?: string;
}

/**
 * My Business Place Actions API v1 `locations.placeActionLinks` (discovery document fetched
 * 2026-10-13). Only one link per (uri, type, location); only one preferred link per type.
 */
export const PLACE_ACTION_TYPES = [
  "APPOINTMENT",
  "ONLINE_APPOINTMENT",
  "DINING_RESERVATION",
  "FOOD_ORDERING",
  "FOOD_DELIVERY",
  "FOOD_TAKEOUT",
  "SHOP_ONLINE",
] as const;
export type PlaceActionType = (typeof PLACE_ACTION_TYPES)[number];
export interface GooglePlaceActionLink {
  /** `locations/{l}/placeActionLinks/{id}`; assigned by Google on create. */
  name?: string;
  uri: string;
  placeActionType: string;
  isPreferred?: boolean;
  /** Output only. */
  isEditable?: boolean;
  providerType?: "PROVIDER_TYPE_UNSPECIFIED" | "MERCHANT" | "AGGREGATOR_3P";
  createTime?: string;
  updateTime?: string;
}
export interface ListPlaceActionLinksResponse {
  placeActionLinks: GooglePlaceActionLink[];
  nextPageToken?: string;
}

/**
 * Business Profile v4 `accounts.locations.foodMenus` (reference pages fetched 2026-10-20,
 * developers.google.com/my-business/reference/rest/v4/FoodMenus). Kept as Google spells it.
 */
export interface GoogleMenuLabel {
  displayName: string;
  description?: string;
  languageCode?: string;
}
export interface GoogleMoney {
  currencyCode: string;
  units?: string;
  nanos?: number;
}
export interface GoogleFoodMenuItemAttributes {
  price: GoogleMoney;
  spiciness?: string;
  allergen?: string[];
  dietaryRestriction?: string[];
  servesNumPeople?: number;
  preparationMethods?: string[];
  mediaKeys?: string[];
}
export interface GoogleFoodMenuItemOption {
  labels: GoogleMenuLabel[];
  attributes: GoogleFoodMenuItemAttributes;
}
export interface GoogleFoodMenuItem {
  labels: GoogleMenuLabel[];
  attributes: GoogleFoodMenuItemAttributes;
  options?: GoogleFoodMenuItemOption[];
}
export interface GoogleFoodMenuSection {
  labels: GoogleMenuLabel[];
  items: GoogleFoodMenuItem[];
}
export interface GoogleFoodMenu {
  labels: GoogleMenuLabel[];
  sourceUrl?: string;
  sections: GoogleFoodMenuSection[];
  cuisines?: string[];
}
export interface GoogleFoodMenus {
  /** `accounts/{a}/locations/{l}/foodMenus` */
  name: string;
  menus: GoogleFoodMenu[];
}

export interface GoogleClient {
  /**
   * Performance API v1 locations.fetchMultiDailyMetricsTimeSeries. `locationName` is `locations/{l}`;
   * `startDate`/`endDate` are inclusive `YYYY-MM-DD`.
   */
  fetchDailyMetrics(
    locationName: string,
    metrics: readonly DailyMetric[],
    startDate: string,
    endDate: string,
  ): Promise<FetchDailyMetricsResponse>;
  /**
   * Performance API v1 locations.searchkeywords.impressions.monthly.list. `startMonth`/`endMonth`
   * are inclusive `YYYY-MM`; Google sums the range, so call with one month to get that month.
   */
  listMonthlySearchKeywords(
    locationName: string,
    startMonth: string,
    endMonth: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListSearchKeywordsResponse>;
  /** accounts.list */
  listAccounts(): Promise<ListAccountsResponse>;
  /** accounts.locations.list; `accountName` is `accounts/{id}`. */
  listLocations(
    accountName: string,
    opts?: { readMask?: string; pageToken?: string; pageSize?: number },
  ): Promise<ListLocationsResponse>;
  /** locations.get; `locationName` is `locations/{id}`. */
  getLocation(locationName: string, opts?: { readMask?: string }): Promise<GoogleLocation>;
  /**
   * locations.patch. `updateMask` names the fields to write (required by the API); a masked field
   * missing from `patch` is cleared. Returns the updated location.
   */
  updateLocation(
    locationName: string,
    patch: Partial<GoogleLocation>,
    updateMask: string[],
  ): Promise<GoogleLocation>;
  /** locations.getAttributes; `name` is `locations/{l}/attributes`. */
  getAttributes(name: string): Promise<GoogleAttributes>;
  /**
   * locations.updateAttributes (PATCH). `attributeMask` lists `attributes/{id}` entries (required): an
   * attribute in the mask and in the body is set; in the mask but absent from the body is deleted;
   * in the body but not in the mask is ignored. Called only from profile/publish.ts.
   */
  updateAttributes(
    name: string,
    attributes: GoogleAttributes,
    attributeMask: string[],
  ): Promise<GoogleAttributes>;
  /** categories.list (read): `filter` is `displayName="<text>"` (quote it: an unquoted multi-word value is a 400), the only supported field. */
  listCategories(opts: {
    regionCode: string;
    languageCode: string;
    view: CategoryView;
    filter?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListCategoriesResponse>;
  /** categories.batchGet (read): `names` are `categories/{id}`; results come in no particular order. */
  batchGetCategories(opts: {
    names: string[];
    languageCode: string;
    regionCode?: string;
    view: CategoryView;
  }): Promise<{ categories: GoogleCategoryMetadata[] }>;
  /** attributes.list (read) by primary category, region and language (not by location: see profile/metadata.ts). */
  listAttributeMetadata(opts: {
    categoryName: string;
    regionCode: string;
    languageCode: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListAttributeMetadataResponse>;
  /**
   * v4 accounts.locations.reviews.list. `accountName` is `accounts/{a}`, `locationId` is
   * `locations/{l}`. Newest-updated first (Google's default order).
   */
  listReviews(
    accountName: string,
    locationId: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListReviewsResponse>;
  /** v4 reviews.get; `reviewName` is `accounts/{a}/locations/{l}/reviews/{r}`. */
  getReview(reviewName: string): Promise<GoogleReview>;
  /** v4 reviews.updateReply (PUT .../reply). Called only from reviews/publish.ts. Returns the stored reply. */
  updateReply(
    reviewName: string,
    comment: string,
  ): Promise<{ comment: string; updateTime: string }>;
  /** v4 reviews.deleteReply (DELETE .../reply). Called only from reviews/publish.ts. */
  deleteReply(reviewName: string): Promise<void>;
  /**
   * v4 localPosts.create (POST .../localPosts). `parent` is `accounts/{a}/locations/{l}`. Called only
   * from posts/publish.ts.
   */
  createLocalPost(parent: string, post: GoogleLocalPost): Promise<GoogleLocalPost>;
  /**
   * v4 localPosts.patch. `updateMask` lists the fields written (required). Called only from
   * posts/publish.ts.
   */
  updateLocalPost(
    postName: string,
    patch: Partial<GoogleLocalPost>,
    updateMask: string[],
  ): Promise<GoogleLocalPost>;
  /** v4 localPosts.delete. NOT_FOUND (404) if the post does not exist. Called only from posts/publish.ts. */
  deleteLocalPost(postName: string): Promise<void>;
  /** v4 localPosts.list (pageSize default 20, max 100). */
  listLocalPosts(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListLocalPostsResponse>;

  /**
   * Business Information v1 locations.getGoogleUpdated. `locationName` is `locations/{l}`; `readMask`
   * is required by the API. Read only.
   */
  getGoogleUpdated(
    locationName: string,
    opts?: { readMask?: string },
  ): Promise<GoogleUpdatedLocation>;
  /** v4 media.list; `parent` is `accounts/{a}/locations/{l}`. */
  listMedia(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListMediaResponse>;
  /** v4 media.customers.list: photos contributed by customers. */
  listCustomerMedia(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListMediaResponse>;
  /** v4 media.create (sourceUrl or dataRef). Called only from media/publish.ts. */
  createMedia(parent: string, item: GoogleMediaItem): Promise<GoogleMediaItem>;
  /** v4 media.startUpload (POST, empty body) -> MediaItemDataRef. Called only from media/publish.ts. */
  startMediaUpload(parent: string): Promise<GoogleMediaDataRef>;
  /**
   * Media upload: POST the raw bytes to /upload/v1/media/{resourceName}?uploadType=media. Called
   * only from media/publish.ts.
   */
  uploadMediaBytes(
    dataRef: GoogleMediaDataRef,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  /** v4 media.delete. NOT_FOUND (404) if it does not exist. Called only from media/publish.ts. */
  deleteMedia(mediaName: string): Promise<void>;
  /** Notifications v1 accounts.getNotificationSetting; `accountName` is `accounts/{id}`. */
  getNotificationSetting(accountName: string): Promise<GoogleNotificationSetting>;
  /** Notifications v1 accounts.updateNotificationSetting (PATCH with updateMask). A write to Google. */
  updateNotificationSetting(
    accountName: string,
    setting: GoogleNotificationSetting,
    updateMask: string,
  ): Promise<GoogleNotificationSetting>;
  /** Verifications v1 locations.getVoiceOfMerchantState (read only). */
  getVoiceOfMerchantState(locationName: string): Promise<GoogleVoiceOfMerchantState>;
  /** Account Management v1 locations.admins.list (read only, not paginated); `parent` is `locations/{l}`. */
  listLocationAdmins(parent: string): Promise<{ admins: GoogleAdmin[] }>;
  /** Verifications v1 locations.verifications.list (read only); `parent` is `locations/{l}`. */
  listVerifications(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListVerificationsResponse>;
  /** Place Actions v1 placeActionLinks.list; `parent` is `locations/{l}`. */
  listPlaceActionLinks(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number; placeActionType?: string },
  ): Promise<ListPlaceActionLinksResponse>;
  /** placeActionLinks.create. Called only from placeActions/publish.ts. */
  createPlaceActionLink(
    parent: string,
    link: GooglePlaceActionLink,
  ): Promise<GooglePlaceActionLink>;
  /** placeActionLinks.patch; editable fields are uri, placeActionType, isPreferred. Called only from placeActions/publish.ts. */
  updatePlaceActionLink(
    name: string,
    patch: Partial<GooglePlaceActionLink>,
    updateMask: string[],
  ): Promise<GooglePlaceActionLink>;
  /** placeActionLinks.delete. Called only from placeActions/publish.ts. */
  deletePlaceActionLink(name: string): Promise<void>;
  /** v4 getFoodMenus; `name` is `accounts/{a}/locations/{l}/foodMenus`. */
  getFoodMenus(name: string): Promise<GoogleFoodMenus>;
  /** v4 updateFoodMenus (PATCH). Called only from foodMenus/publish.ts. */
  updateFoodMenus(foodMenus: GoogleFoodMenus, updateMask: string[]): Promise<GoogleFoodMenus>;
}
