import { GOOGLE_NOTIFICATIONS } from "../config/google-notifications";
import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import { GoogleApiError, GoogleRateLimitError } from "./errors";
import type {
  DailyMetric,
  DailyMetricSeries,
  FetchDailyMetricsResponse,
  GoogleAttributes,
  GoogleCategoryMetadata,
  GoogleClient,
  GoogleLocalPost,
  GoogleLocation,
  GoogleNotificationSetting,
  GoogleMediaDataRef,
  GoogleMediaItem,
  GoogleFoodMenus,
  GooglePlaceActionLink,
  GoogleReview,
  GoogleUpdatedLocation,
  GoogleAdmin,
  GoogleVoiceOfMerchantState,
  ListLocalPostsResponse,
  ListMediaResponse,
  ListPlaceActionLinksResponse,
  ListVerificationsResponse,
  ListAccountsResponse,
  ListAttributeMetadataResponse,
  ListCategoriesResponse,
  ListLocationsResponse,
  ListReviewsResponse,
  ListSearchKeywordsResponse,
  RawGoogleReview,
} from "./client";
import { mapReview, parseReviewName } from "./reviews";

/**
 * Source of truth: Google's public discovery documents, fetched 2026-10-12.
 *   https://mybusinessaccountmanagement.googleapis.com/$discovery/rest?version=v1
 *     rootUrl https://mybusinessaccountmanagement.googleapis.com/
 *     accounts.list: GET v1/accounts (query: pageToken, pageSize, parentAccount, filter)
 *   https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1
 *     rootUrl https://mybusinessbusinessinformation.googleapis.com/
 *     accounts.locations.list: GET v1/{+parent}/locations, parent ^accounts/[^/]+$,
 *       query readMask (REQUIRED, google-fieldmask), pageToken, pageSize (default 10, max 100), filter, orderBy
 *     locations.get: GET v1/{+name}, name ^locations/[^/]+$, query readMask (REQUIRED)
 *     locations.patch: PATCH v1/{+name}, name ^locations/[^/]+$, query updateMask (REQUIRED),
 *       validateOnly; request body Location, response Location
 *     Location properties used in DEFAULT_READ_MASK: name, title, storeCode, languageCode,
 *       phoneNumbers, categories, storefrontAddress, websiteUri, regularHours, metadata
 *     locations.getAttributes: GET v1/{+name}, name ^locations/[^/]+/attributes$; response Attributes {name, attributes[]}
 *     locations.updateAttributes: PATCH v1/{+name} (name = attributes.name, same pattern), query attributeMask
 *       (REQUIRED, entries `attributes/{id}`), body Attributes, response Attributes. Verified 2026-10-13
 *       from https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1
 * Category and attribute metadata (discovery document revision 20261014, fetched 2026-10-18 from
 *   https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1):
 *   categories.list GET v1/categories: regionCode, languageCode, view (BASIC | FULL) required;
 *     filter (only `displayName="..."`, quoted), pageSize (default 100, max 100), pageToken -> {categories[], nextPageToken}
 *   categories.batchGet GET v1/categories:batchGet: names (repeated, required), languageCode and view
 *     required, regionCode optional -> {categories[]} (any order)
 *   attributes.list GET v1/attributes: parent=locations/{id} OR categoryName + regionCode (+ languageCode),
 *     showAll, pageSize (default 200), pageToken -> {attributeMetadata[], nextPageToken}
 *   ListAccountsResponse {accounts[], nextPageToken}; ListLocationsResponse {locations[], nextPageToken, totalSize}
 * Reviews are still v4 (fetched 2026-10-12 from developers.google.com/my-business/reference/rest/v4/...):
 *   https://mybusiness.googleapis.com/v4
 *   accounts.locations.reviews.list: GET v4/{parent=accounts/*\/locations/*}/reviews, query pageSize (max 50),
 *     pageToken, orderBy (rating | rating desc | updateTime desc, default updateTime desc);
 *     response {reviews[], averageRating, totalReviewCount, nextPageToken}
 *   reviews.get: GET v4/{name=accounts/*\/locations/*\/reviews/*}
 *   reviews.updateReply: PUT v4/{name}/reply, body ReviewReply {comment (max 4096 bytes)}, response ReviewReply
 *   reviews.deleteReply: DELETE v4/{name}/reply, empty response
 *   Review {name, reviewId, reviewer{displayName, profilePhotoUrl, isAnonymous}, starRating enum
 *     (STAR_RATING_UNSPECIFIED, ONE..FIVE), comment, createTime, updateTime, reviewReply{comment, updateTime}}
 * Local posts (v4, fetched 2026-10-12 from developers.google.com/my-business/reference/rest/v4/...localPosts/...):
 *   localPosts.create: POST v4/{parent=accounts/*\/locations/*}/localPosts, body LocalPost, response LocalPost
 *   localPosts.patch: PATCH v4/{name=accounts/*\/locations/*\/localPosts/*}, query updateMask (FieldMask), body LocalPost
 *   localPosts.delete: DELETE v4/{name}, empty body, empty response, NOT_FOUND if missing
 *   localPosts.list: GET v4/{parent}/localPosts, query pageSize (default 20, min 1, max 100), pageToken;
 *     response {localPosts[], nextPageToken}
 * Auth: Bearer access token with scope https://www.googleapis.com/auth/business.manage.
 *
 * NOT USED until Google approves Basic Access (quota is 0 today); createGoogleClient only builds
 * this when GOOGLE_BUSINESS_API_MODE=live.
 */
export const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
export const BUSINESS_INFORMATION_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
export const DEFAULT_READ_MASK =
  "name,title,storeCode,languageCode,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,metadata";
export const REVIEWS_BASE = "https://mybusiness.googleapis.com/v4";
/** Media bytes: POST {base}/{dataRef.resourceName}?uploadType=media (config/media-limits.ts cites the source). */
export const MEDIA_UPLOAD_BASE = MEDIA_LIMITS.upload.uploadBase;
/**
 * Verified 2026-10-13 from the discovery documents (v1):
 *   https://mybusinessbusinessinformation.googleapis.com: locations.getGoogleUpdated GET v1/{+name}:getGoogleUpdated,
 *     name ^locations/[^/]+$, query readMask (REQUIRED); response GoogleUpdatedLocation {location, diffMask, pendingMask}
 *   https://mybusinessverifications.googleapis.com: locations.getVoiceOfMerchantState GET v1/{+name}/VoiceOfMerchantState;
 *     locations.verifications.list GET v1/{+parent}/verifications (pageSize, pageToken) -> {verifications[], nextPageToken}
 *   https://mybusinessplaceactions.googleapis.com: locations.placeActionLinks create POST v1/{+parent}/placeActionLinks,
 *     list GET (pageSize default 10, pageToken, filter `place_action_type=XYZ`), patch PATCH v1/{+name} (updateMask REQUIRED;
 *     editable: uri, place_action_type, is_preferred), delete DELETE v1/{+name}
 * v4 media (developers.google.com/my-business/reference/rest/v4/accounts.locations.media...):
 *   media.create POST v4/{parent=accounts/*\/locations/*}/media; media.list GET (pageSize default 100, max 2500);
 *   media.delete DELETE v4/{name=accounts/*\/locations/*\/media/*}; media.customers.list GET .../media/customers (pageSize max 200)
 */
export const VERIFICATIONS_BASE = "https://mybusinessverifications.googleapis.com/v1";
export const PLACE_ACTIONS_BASE = "https://mybusinessplaceactions.googleapis.com/v1";
/**
 * Business Profile Performance API v1 (reference pages fetched 2026-10-12,
 * developers.google.com/my-business/reference/performance/rest/v1/...):
 *   locations.fetchMultiDailyMetricsTimeSeries: GET v1/{location=locations/*}:fetchMultiDailyMetricsTimeSeries,
 *     query dailyMetrics[] (DailyMetric enum, repeated), dailyRange.start_date.{year,month,day},
 *     dailyRange.end_date.{year,month,day}; response {multiDailyMetricTimeSeries[]{dailyMetricTimeSeries[]
 *     {dailyMetric, dailySubEntityType?, timeSeries{datedValues[]{date{year,month,day}, value (int64 string,
 *     absent when zero)}}}}}
 *   locations.searchkeywords.impressions.monthly.list: GET v1/{parent=locations/*}/searchkeywords/impressions/monthly,
 *     query monthlyRange.{start_month,end_month}.{year,month}, pageSize (default and max 100), pageToken;
 *     response {searchKeywordsCounts[]{searchKeyword (lowercased), insightsValue{value | threshold} (int64 strings)},
 *     nextPageToken}
 */
export const PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1";

type RawMultiDailyResponse = {
  multiDailyMetricTimeSeries?: {
    dailyMetricTimeSeries?: {
      dailyMetric?: DailyMetric;
      dailySubEntityType?: unknown;
      timeSeries?: {
        datedValues?: { date?: { year?: number; month?: number; day?: number }; value?: string }[];
      };
    }[];
  }[];
};

function parseYmd(s: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) throw new CoreError("INVALID_INPUT", `Invalid date ${s}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}
const HTTP_TIMEOUT_MS = 15_000;

/** Retry-After is delta-seconds or an HTTP-date. Returns ms, or undefined when absent/unparseable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const v = header.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** Names go into the URL path; pin them to the discovery doc patterns so they cannot escape it. */
function checkName(kind: "accounts" | "locations", name: string) {
  if (!new RegExp(`^${kind}/[^/]+$`).test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", `Invalid ${kind} resource name`);
  }
}

function checkAttributesName(name: string) {
  if (!/^locations\/[^/]+\/attributes$/.test(name) || name.includes("..")) {
    throw new CoreError(
      "INVALID_INPUT",
      "Invalid attributes resource name (locations/{l}/attributes)",
    );
  }
}

function checkCategoryName(name: string) {
  if (!/^categories\/[^/]+$/.test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", "Invalid category name (categories/{id})");
  }
}

function checkReviewName(name: string) {
  if (!parseReviewName(name)) throw new CoreError("INVALID_INPUT", "Invalid review resource name");
}

function checkLocationParent(name: string) {
  if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", "Invalid location parent (accounts/{a}/locations/{l})");
  }
}

function checkPostName(name: string) {
  if (!/^accounts\/[^/]+\/locations\/[^/]+\/localPosts\/[^/]+$/.test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", "Invalid local post resource name");
  }
}

function checkMediaName(name: string) {
  if (!/^accounts\/[^/]+\/locations\/[^/]+\/media\/[^/]+$/.test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", "Invalid media resource name");
  }
}

function checkLinkName(name: string) {
  if (!/^locations\/[^/]+\/placeActionLinks\/[^/]+$/.test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", "Invalid place action link resource name");
  }
}

function checkFoodMenusName(name: string) {
  if (!/^accounts\/[^/]+\/locations\/[^/]+\/foodMenus$/.test(name) || name.includes("..")) {
    throw new CoreError("INVALID_INPUT", "Invalid food menus resource name");
  }
}

export class LiveGoogleClient implements GoogleClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      getAccessToken: () => Promise<string>;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: URL,
    body?: unknown,
    /** Raw bytes instead of a JSON body (media upload). */
    raw?: { bytes: Uint8Array; contentType: string },
  ): Promise<T> {
    const token = await this.opts.getAccessToken();
    const res = await this.fetchFn(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(raw
          ? { "content-type": raw.contentType }
          : body === undefined
            ? {}
            : { "content-type": "application/json" }),
      },
      ...(raw
        ? { body: raw.bytes as unknown as ArrayBuffer }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    if (res.status === 429) {
      throw new GoogleRateLimitError(
        parseRetryAfter(res.headers.get("retry-after"), this.now()),
        parsed,
      );
    }
    if (!res.ok) {
      const err = (
        parsed as {
          error?: {
            message?: unknown;
            details?: { fieldViolations?: { field?: unknown; description?: unknown }[] }[];
          };
        } | null
      )?.error;
      const msg = err?.message;
      const violations = (err?.details ?? [])
        .flatMap((d) => d?.fieldViolations ?? [])
        .map((v) => `${String(v.field)}: ${String(v.description)}`);
      throw new GoogleApiError(
        res.status,
        parsed,
        typeof msg === "string"
          ? `Google API error ${res.status}: ${msg}${violations.length ? ` (${violations.join("; ")})` : ""}`
          : undefined,
      );
    }
    return parsed as T;
  }

  listAccounts() {
    return this.request<ListAccountsResponse>(
      "GET",
      new URL(`${ACCOUNT_MANAGEMENT_BASE}/accounts`),
    );
  }

  async listLocations(
    accountName: string,
    opts: { readMask?: string; pageToken?: string; pageSize?: number } = {},
  ): Promise<ListLocationsResponse> {
    checkName("accounts", accountName);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${accountName}/locations`);
    url.searchParams.set("readMask", opts.readMask ?? DEFAULT_READ_MASK);
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    const res = await this.request<Partial<ListLocationsResponse>>("GET", url);
    // Google's list omits `locations` when empty; `account` is carried for callers (not an API field).
    return {
      ...res,
      locations: (res.locations ?? []).map((l) => ({ ...l, account: accountName })),
    };
  }

  async getLocation(locationName: string, opts: { readMask?: string } = {}) {
    checkName("locations", locationName);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${locationName}`);
    url.searchParams.set("readMask", opts.readMask ?? DEFAULT_READ_MASK);
    return this.request<GoogleLocation>("GET", url);
  }

  async updateLocation(locationName: string, patch: Partial<GoogleLocation>, updateMask: string[]) {
    checkName("locations", locationName);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${locationName}`);
    url.searchParams.set("updateMask", updateMask.join(","));
    return this.request<GoogleLocation>("PATCH", url, patch);
  }

  async getAttributes(name: string): Promise<GoogleAttributes> {
    checkAttributesName(name);
    const res = await this.request<Partial<GoogleAttributes>>(
      "GET",
      new URL(`${BUSINESS_INFORMATION_BASE}/${name}`),
    );
    // Google omits `attributes` when there are none.
    return { name, ...res, attributes: res.attributes ?? [] };
  }

  async updateAttributes(
    name: string,
    attributes: GoogleAttributes,
    attributeMask: string[],
  ): Promise<GoogleAttributes> {
    checkAttributesName(name);
    if (attributeMask.length === 0)
      throw new CoreError("INVALID_INPUT", "attributeMask is required");
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${name}`);
    url.searchParams.set("attributeMask", attributeMask.join(","));
    return this.request<GoogleAttributes>("PATCH", url, attributes);
  }

  async listCategories(
    opts: Parameters<GoogleClient["listCategories"]>[0],
  ): Promise<ListCategoriesResponse> {
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/categories`);
    url.searchParams.set("regionCode", opts.regionCode);
    url.searchParams.set("languageCode", opts.languageCode);
    url.searchParams.set("view", opts.view);
    if (opts.filter) url.searchParams.set("filter", opts.filter);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    const res = await this.request<Partial<ListCategoriesResponse>>("GET", url);
    return { ...res, categories: res.categories ?? [] };
  }

  async batchGetCategories(
    opts: Parameters<GoogleClient["batchGetCategories"]>[0],
  ): Promise<{ categories: GoogleCategoryMetadata[] }> {
    if (opts.names.length === 0) {
      throw new CoreError("INVALID_INPUT", "At least one category name is required");
    }
    opts.names.forEach(checkCategoryName);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/categories:batchGet`);
    for (const n of opts.names) url.searchParams.append("names", n);
    url.searchParams.set("languageCode", opts.languageCode);
    if (opts.regionCode) url.searchParams.set("regionCode", opts.regionCode);
    url.searchParams.set("view", opts.view);
    const res = await this.request<{ categories?: GoogleCategoryMetadata[] }>("GET", url);
    return { categories: res.categories ?? [] };
  }

  async listAttributeMetadata(
    opts: Parameters<GoogleClient["listAttributeMetadata"]>[0],
  ): Promise<ListAttributeMetadataResponse> {
    checkCategoryName(opts.categoryName);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/attributes`);
    url.searchParams.set("categoryName", opts.categoryName);
    url.searchParams.set("regionCode", opts.regionCode);
    url.searchParams.set("languageCode", opts.languageCode);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    const res = await this.request<Partial<ListAttributeMetadataResponse>>("GET", url);
    return { ...res, attributeMetadata: res.attributeMetadata ?? [] };
  }

  async listReviews(
    accountName: string,
    locationId: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListReviewsResponse> {
    checkName("accounts", accountName);
    checkName("locations", locationId);
    const url = new URL(`${REVIEWS_BASE}/${accountName}/${locationId}/reviews`);
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    const res = await this.request<
      Partial<Omit<ListReviewsResponse, "reviews">> & { reviews?: RawGoogleReview[] }
    >("GET", url);
    // Google omits `reviews` when the location has none.
    return { ...res, reviews: (res.reviews ?? []).map(mapReview) };
  }

  async fetchDailyMetrics(
    locationName: string,
    metrics: readonly DailyMetric[],
    startDate: string,
    endDate: string,
  ): Promise<FetchDailyMetricsResponse> {
    checkName("locations", locationName);
    const start = parseYmd(startDate);
    const end = parseYmd(endDate);
    const url = new URL(`${PERFORMANCE_BASE}/${locationName}:fetchMultiDailyMetricsTimeSeries`);
    for (const m of metrics) url.searchParams.append("dailyMetrics", m);
    url.searchParams.set("dailyRange.start_date.year", String(start.y));
    url.searchParams.set("dailyRange.start_date.month", String(start.m));
    url.searchParams.set("dailyRange.start_date.day", String(start.d));
    url.searchParams.set("dailyRange.end_date.year", String(end.y));
    url.searchParams.set("dailyRange.end_date.month", String(end.m));
    url.searchParams.set("dailyRange.end_date.day", String(end.d));
    const res = await this.request<RawMultiDailyResponse>("GET", url);
    const series: DailyMetricSeries[] = [];
    for (const multi of res.multiDailyMetricTimeSeries ?? []) {
      for (const s of multi.dailyMetricTimeSeries ?? []) {
        // Breakdown series (dailySubEntityType present) are not part of the plain metrics we store.
        if (s.dailySubEntityType || !s.dailyMetric) continue;
        series.push({
          metric: s.dailyMetric,
          points: (s.timeSeries?.datedValues ?? []).flatMap((v) =>
            v.date?.year && v.date.month && v.date.day
              ? [
                  {
                    date: `${v.date.year}-${String(v.date.month).padStart(2, "0")}-${String(v.date.day).padStart(2, "0")}`,
                    // int64 arrives as a string and is absent when zero.
                    value: v.value === undefined ? 0 : Number(v.value),
                  },
                ]
              : [],
          ),
        });
      }
    }
    return { series };
  }

  async listMonthlySearchKeywords(
    locationName: string,
    startMonth: string,
    endMonth: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListSearchKeywordsResponse> {
    checkName("locations", locationName);
    const start = parseYmd(`${startMonth}-01`);
    const end = parseYmd(`${endMonth}-01`);
    const url = new URL(`${PERFORMANCE_BASE}/${locationName}/searchkeywords/impressions/monthly`);
    url.searchParams.set("monthlyRange.start_month.year", String(start.y));
    url.searchParams.set("monthlyRange.start_month.month", String(start.m));
    url.searchParams.set("monthlyRange.end_month.year", String(end.y));
    url.searchParams.set("monthlyRange.end_month.month", String(end.m));
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    const res = await this.request<{
      searchKeywordsCounts?: {
        searchKeyword: string;
        insightsValue?: { value?: string; threshold?: string };
      }[];
      nextPageToken?: string;
    }>("GET", url);
    return {
      keywords: (res.searchKeywordsCounts ?? []).map((k) => ({
        keyword: k.searchKeyword,
        ...(k.insightsValue?.value !== undefined ? { value: Number(k.insightsValue.value) } : {}),
        ...(k.insightsValue?.threshold !== undefined
          ? { threshold: Number(k.insightsValue.threshold) }
          : {}),
      })),
      ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}),
    };
  }

  async getReview(reviewName: string): Promise<GoogleReview> {
    checkReviewName(reviewName);
    return mapReview(
      await this.request<RawGoogleReview>("GET", new URL(`${REVIEWS_BASE}/${reviewName}`)),
    );
  }

  async updateReply(reviewName: string, comment: string) {
    checkReviewName(reviewName);
    return this.request<{ comment: string; updateTime: string }>(
      "PUT",
      new URL(`${REVIEWS_BASE}/${reviewName}/reply`),
      { comment },
    );
  }

  async deleteReply(reviewName: string): Promise<void> {
    checkReviewName(reviewName);
    await this.request<unknown>("DELETE", new URL(`${REVIEWS_BASE}/${reviewName}/reply`));
  }

  async createLocalPost(parent: string, post: GoogleLocalPost): Promise<GoogleLocalPost> {
    checkLocationParent(parent);
    return this.request<GoogleLocalPost>(
      "POST",
      new URL(`${REVIEWS_BASE}/${parent}/localPosts`),
      post,
    );
  }

  async updateLocalPost(
    postName: string,
    patch: Partial<GoogleLocalPost>,
    updateMask: string[],
  ): Promise<GoogleLocalPost> {
    checkPostName(postName);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    const url = new URL(`${REVIEWS_BASE}/${postName}`);
    url.searchParams.set("updateMask", updateMask.join(","));
    return this.request<GoogleLocalPost>("PATCH", url, patch);
  }

  async deleteLocalPost(postName: string): Promise<void> {
    checkPostName(postName);
    await this.request<unknown>("DELETE", new URL(`${REVIEWS_BASE}/${postName}`));
  }

  async listLocalPosts(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListLocalPostsResponse> {
    checkLocationParent(parent);
    const url = new URL(`${REVIEWS_BASE}/${parent}/localPosts`);
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    const res = await this.request<Partial<ListLocalPostsResponse>>("GET", url);
    // Google omits `localPosts` when there are none.
    return { ...res, localPosts: res.localPosts ?? [] };
  }

  async getGoogleUpdated(
    locationName: string,
    opts: { readMask?: string } = {},
  ): Promise<GoogleUpdatedLocation> {
    checkName("locations", locationName);
    const url = new URL(`${BUSINESS_INFORMATION_BASE}/${locationName}:getGoogleUpdated`);
    url.searchParams.set("readMask", opts.readMask ?? DEFAULT_READ_MASK);
    const res = await this.request<Partial<GoogleUpdatedLocation>>("GET", url);
    return { ...res, location: res.location ?? { name: locationName, title: "" } };
  }

  private async listMediaAt(
    parent: string,
    path: string,
    opts: { pageToken?: string; pageSize?: number },
  ): Promise<ListMediaResponse> {
    checkLocationParent(parent);
    const url = new URL(`${REVIEWS_BASE}/${parent}/${path}`);
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    const res = await this.request<Partial<ListMediaResponse>>("GET", url);
    // Google omits `mediaItems` when there are none.
    return { ...res, mediaItems: res.mediaItems ?? [] };
  }

  listMedia(parent: string, opts: { pageToken?: string; pageSize?: number } = {}) {
    return this.listMediaAt(parent, "media", opts);
  }

  listCustomerMedia(parent: string, opts: { pageToken?: string; pageSize?: number } = {}) {
    return this.listMediaAt(parent, "media/customers", opts);
  }

  async createMedia(parent: string, item: GoogleMediaItem): Promise<GoogleMediaItem> {
    checkLocationParent(parent);
    return this.request<GoogleMediaItem>("POST", new URL(`${REVIEWS_BASE}/${parent}/media`), item);
  }

  async startMediaUpload(parent: string): Promise<GoogleMediaDataRef> {
    checkLocationParent(parent);
    // v4 media.startUpload: POST .../media:startUpload with an empty request body.
    const ref = await this.request<Partial<GoogleMediaDataRef> | null>(
      "POST",
      new URL(`${REVIEWS_BASE}/${parent}/media:startUpload`),
    );
    if (!ref?.resourceName) throw new Error("Google returned no upload reference");
    return { resourceName: ref.resourceName };
  }

  async uploadMediaBytes(
    dataRef: GoogleMediaDataRef,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const name = dataRef.resourceName;
    if (
      !/^[A-Za-z0-9_\-+=.~:/]{1,2000}$/.test(name) ||
      name.includes("..") ||
      name.startsWith("/")
    ) {
      throw new CoreError("INVALID_INPUT", "Invalid media upload reference");
    }
    const path = name.split("/").map(encodeURIComponent).join("/");
    const url = new URL(`${MEDIA_UPLOAD_BASE}/${path}`);
    url.searchParams.set("uploadType", "media");
    await this.request<unknown>("POST", url, undefined, { bytes, contentType });
  }

  async deleteMedia(mediaName: string): Promise<void> {
    checkMediaName(mediaName);
    await this.request<unknown>("DELETE", new URL(`${REVIEWS_BASE}/${mediaName}`));
  }

  async getNotificationSetting(accountName: string): Promise<GoogleNotificationSetting> {
    checkName("accounts", accountName);
    const res = await this.request<GoogleNotificationSetting | null>(
      "GET",
      new URL(`${GOOGLE_NOTIFICATIONS.baseUrl}/${GOOGLE_NOTIFICATIONS.settingPath(accountName)}`),
    );
    return res ?? { name: GOOGLE_NOTIFICATIONS.settingPath(accountName) };
  }

  async updateNotificationSetting(
    accountName: string,
    setting: GoogleNotificationSetting,
    updateMask: string,
  ): Promise<GoogleNotificationSetting> {
    checkName("accounts", accountName);
    const url = new URL(`${GOOGLE_NOTIFICATIONS.baseUrl}/${GOOGLE_NOTIFICATIONS.settingPath(accountName)}`);
    url.searchParams.set("updateMask", updateMask);
    const res = await this.request<GoogleNotificationSetting | null>("PATCH", url, {
      ...setting,
      name: GOOGLE_NOTIFICATIONS.settingPath(accountName),
    });
    return res ?? setting;
  }

  async getVoiceOfMerchantState(locationName: string): Promise<GoogleVoiceOfMerchantState> {
    checkName("locations", locationName);
    return (
      (await this.request<GoogleVoiceOfMerchantState | null>(
        "GET",
        new URL(`${VERIFICATIONS_BASE}/${locationName}/VoiceOfMerchantState`),
      )) ?? {}
    );
  }

  async listLocationAdmins(parent: string): Promise<{ admins: GoogleAdmin[] }> {
    checkName("locations", parent);
    const res = await this.request<{ admins?: GoogleAdmin[] } | null>(
      "GET",
      new URL(`${ACCOUNT_MANAGEMENT_BASE}/${parent}/admins`),
    );
    return { admins: res?.admins ?? [] };
  }

  async listVerifications(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListVerificationsResponse> {
    checkName("locations", parent);
    const url = new URL(`${VERIFICATIONS_BASE}/${parent}/verifications`);
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    const res = await this.request<Partial<ListVerificationsResponse>>("GET", url);
    return { ...res, verifications: res.verifications ?? [] };
  }

  async listPlaceActionLinks(
    parent: string,
    opts: { pageToken?: string; pageSize?: number; placeActionType?: string } = {},
  ): Promise<ListPlaceActionLinksResponse> {
    checkName("locations", parent);
    const url = new URL(`${PLACE_ACTIONS_BASE}/${parent}/placeActionLinks`);
    if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
    if (opts.pageSize) url.searchParams.set("pageSize", String(opts.pageSize));
    if (opts.placeActionType) {
      url.searchParams.set("filter", `place_action_type=${opts.placeActionType}`);
    }
    const res = await this.request<Partial<ListPlaceActionLinksResponse>>("GET", url);
    return { ...res, placeActionLinks: res.placeActionLinks ?? [] };
  }

  async createPlaceActionLink(parent: string, link: GooglePlaceActionLink) {
    checkName("locations", parent);
    return this.request<GooglePlaceActionLink>(
      "POST",
      new URL(`${PLACE_ACTIONS_BASE}/${parent}/placeActionLinks`),
      link,
    );
  }

  async updatePlaceActionLink(
    name: string,
    patch: Partial<GooglePlaceActionLink>,
    updateMask: string[],
  ) {
    checkLinkName(name);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    const url = new URL(`${PLACE_ACTIONS_BASE}/${name}`);
    url.searchParams.set("updateMask", updateMask.join(","));
    return this.request<GooglePlaceActionLink>("PATCH", url, patch);
  }

  async deletePlaceActionLink(name: string): Promise<void> {
    checkLinkName(name);
    await this.request<unknown>("DELETE", new URL(`${PLACE_ACTIONS_BASE}/${name}`));
  }

  async getFoodMenus(name: string): Promise<GoogleFoodMenus> {
    checkFoodMenusName(name);
    const res = await this.request<Partial<GoogleFoodMenus>>(
      "GET",
      new URL(`${REVIEWS_BASE}/${name}`),
    );
    return { name, menus: res.menus ?? [] };
  }

  async updateFoodMenus(foodMenus: GoogleFoodMenus, updateMask: string[]): Promise<GoogleFoodMenus> {
    checkFoodMenusName(foodMenus.name);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    const url = new URL(`${REVIEWS_BASE}/${foodMenus.name}`);
    url.searchParams.set("updateMask", updateMask.join(","));
    const res = await this.request<Partial<GoogleFoodMenus>>("PATCH", url, foodMenus);
    return { name: foodMenus.name, menus: res.menus ?? [] };
  }
}
