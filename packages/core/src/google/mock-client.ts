import accountsFixture from "./fixtures/accounts.json";
import metadataFixture from "./fixtures/metadata.json";
import locationsFixture from "./fixtures/locations.json";
import reviewsFixture from "./fixtures/reviews.json";
import { CoreError } from "../errors";
import { GOOGLE_LIMITS } from "../config/google-limits";
import { POST_LIMITS } from "../config/post-limits";
import { MEDIA_LIMITS } from "../config/media-limits";
import { mapReview, parseReviewName } from "./reviews";
import { GoogleApiError, GoogleRateLimitError } from "./errors";
import { createHash } from "node:crypto";
import { PLACE_ACTION_TYPES } from "./client";
import type {
  DailyMetric,
  FetchDailyMetricsResponse,
  GoogleAttribute,
  GoogleAttributeMetadata,
  GoogleAttributes,
  GoogleCategoryMetadata,
  GoogleClient,
  ListSearchKeywordsResponse,
  GoogleLocalPost,
  GoogleLocation,
  GoogleNotificationSetting,
  GoogleMediaDataRef,
  GoogleMediaItem,
  GoogleFoodMenus,
  GooglePlaceActionLink,
  GoogleReview,
  GoogleUpdatedLocation,
  GoogleVerification,
  GoogleAdmin,
  GoogleVoiceOfMerchantState,
  ListAttributeMetadataResponse,
  ListCategoriesResponse,
  ListLocalPostsResponse,
  ListMediaResponse,
  ListPlaceActionLinksResponse,
  ListVerificationsResponse,
  ListAccountsResponse,
  ListLocationsResponse,
  ListReviewsResponse,
  RawGoogleReview,
} from "./client";

/** Mirrors the API's readMask: only the named top-level fields (plus `name`) come back. */
function applyReadMask(loc: GoogleLocation, readMask?: string): GoogleLocation {
  if (!readMask) return loc;
  const keep = new Set(["name", ...readMask.split(",").map((f) => f.trim())]);
  return Object.fromEntries(
    Object.entries(loc).filter(([k]) => keep.has(k)),
  ) as unknown as GoogleLocation;
}

/** Set (or, when `value` is undefined, clear) a dotted path such as `phoneNumbers.primaryPhone`. */
function writePath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  let node = target;
  for (const k of keys) {
    const next = node[k];
    if (typeof next !== "object" || next === null) {
      if (value === undefined) return;
      node[k] = {};
    }
    node = node[k] as Record<string, unknown>;
  }
  if (value === undefined) delete node[last];
  else node[last] = structuredClone(value);
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let node: unknown = source;
  for (const k of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

const KEYWORD_POOL = [
  "dentist near me",
  "emergency dentist",
  "teeth whitening",
  "dental implants",
  "family dentist",
  "invisalign",
  "root canal",
  "pediatric dentist",
  "cosmetic dentistry",
  "dentist open saturday",
  "tooth extraction",
  "dental cleaning",
];

/** Deterministic integer in [0, 2^32) from the parts. */
function seeded(...parts: string[]): number {
  return createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0);
}

const DAY_MS = 86_400_000;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Fixture-backed GoogleClient. No network. Writes live in memory for the life of the instance. */
export class MockGoogleClient implements GoogleClient {
  private readonly accounts = accountsFixture as ListAccountsResponse;
  private readonly locations = structuredClone(
    (locationsFixture as ListLocationsResponse).locations,
  );
  /** Raw (enum-rated) reviews keyed by `locations/{l}`. */
  private readonly reviews = new Map<string, RawGoogleReview[]>(
    Object.entries(structuredClone(reviewsFixture as unknown as Record<string, RawGoogleReview[]>)),
  );
  private readonly metadata = metadataFixture as unknown as {
    categories: GoogleCategoryMetadata[];
    attributes: Record<string, GoogleAttributeMetadata[]>;
  };
  /** Attributes keyed by `locations/{l}`; seeded lazily with two attributes per location. */
  private readonly attributes = new Map<string, GoogleAttribute[]>();
  private nextReviewSeq = 1;
  /**
   * Local posts keyed by parent `accounts/{a}/locations/{l}`. `MOCK_GOOGLE_LOCAL_POSTS` (JSON, parent
   * to posts) pre-loads Google-made posts into every instance, so e2e processes, which each build
   * their own fresh mock, agree on what Google lists and a later sync keeps the mirrored rows.
   */
  private readonly posts = new Map<string, GoogleLocalPost[]>(
    Object.entries(JSON.parse(process.env.MOCK_GOOGLE_LOCAL_POSTS || "{}") as Record<string, GoogleLocalPost[]>),
  );
  private nextPostSeq = 1;
  /** Google-side suggestions per `locations/{l}`: path -> the value consumers see (undefined = cleared). */
  private readonly suggestions = new Map<string, Map<string, unknown>>();
  private readonly media = new Map<string, GoogleMediaItem[]>();
  private readonly customerMedia = new Map<string, GoogleMediaItem[]>();
  private nextMediaSeq = 1;
  /** startUpload references; bytes arrive with uploadMediaBytes. */
  private readonly uploads = new Map<
    string,
    { bytes: Uint8Array; contentType: string } | undefined
  >();
  private readonly admins = new Map<string, GoogleAdmin[]>();
  private readonly voiceOfMerchant = new Map<string, GoogleVoiceOfMerchantState>();
  private readonly verifications = new Map<string, GoogleVerification[]>();
  private readonly foodMenus = new Map<string, GoogleFoodMenus>();
  private readonly placeLinks = new Map<string, GooglePlaceActionLink[]>();
  private nextLinkSeq = 1;
  private failures: { remaining: number; make: () => Error; method?: string }[] = [];
  /** Every call made, including ones that were made to fail. Test-only. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  get callCount() {
    return this.calls.length;
  }

  /** Test-only: the next `times` calls (only calls to `method`, when given) throw `make()`. */
  failNext(times: number, make: () => Error, method?: string) {
    this.failures.push({ remaining: times, make, method });
  }

  /** Test-only: the next `times` calls fail as HTTP 429, with Retry-After of `retryAfterSeconds` if given. */
  rateLimitNext(times: number, retryAfterSeconds?: number) {
    this.failNext(
      times,
      () =>
        new GoogleRateLimitError(
          retryAfterSeconds === undefined ? undefined : retryAfterSeconds * 1000,
        ),
    );
  }

  private enter(method: string, args: unknown[]) {
    this.calls.push({ method, args });
    const f = this.failures[0];
    if (!f || (f.method !== undefined && f.method !== method)) return;
    if (--f.remaining <= 0) this.failures.shift();
    throw f.make();
  }

  async listAccounts(): Promise<ListAccountsResponse> {
    this.enter("listAccounts", []);
    return structuredClone(this.accounts);
  }

  async listLocations(
    accountName: string,
    opts: { readMask?: string; pageToken?: string; pageSize?: number } = {},
  ): Promise<ListLocationsResponse> {
    this.enter("listLocations", [accountName, opts]);
    if (!this.accounts.accounts.some((a) => a.name === accountName)) {
      throw new CoreError("NOT_FOUND", `Unknown account ${accountName}`);
    }
    const all = this.locations.filter((l) => l.account === accountName);
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const end = opts.pageSize ? start + opts.pageSize : all.length;
    const locations = all
      .slice(start, end)
      .map((l) => applyReadMask(structuredClone(l), opts.readMask));
    return {
      locations,
      totalSize: all.length,
      ...(end < all.length ? { nextPageToken: String(end) } : {}),
    };
  }

  async getLocation(
    locationName: string,
    opts: { readMask?: string } = {},
  ): Promise<GoogleLocation> {
    this.enter("getLocation", [locationName, opts]);
    const loc = this.locations.find((l) => l.name === locationName);
    if (!loc) throw new CoreError("NOT_FOUND", `Unknown location ${locationName}`);
    return applyReadMask(structuredClone(loc), opts.readMask);
  }

  async updateLocation(
    locationName: string,
    patch: Partial<GoogleLocation>,
    updateMask: string[],
  ): Promise<GoogleLocation> {
    this.enter("updateLocation", [locationName, patch, updateMask]);
    const loc = this.locations.find((l) => l.name === locationName);
    if (!loc) throw new CoreError("NOT_FOUND", `Unknown location ${locationName}`);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    if (updateMask.some((p) => p === "name" || p === "account" || p.startsWith("metadata"))) {
      throw new CoreError("INVALID_INPUT", "name, account and metadata are not updatable");
    }
    const target = loc as unknown as Record<string, unknown>;
    for (const path of updateMask) {
      writePath(target, path, readPath(patch as Record<string, unknown>, path));
      // Google: "To accept these changes, patch the location. To reject, patch with your preferred values."
      this.suggestions.get(locationName)?.delete(path);
    }
    return structuredClone(loc);
  }

  async getGoogleUpdated(
    locationName: string,
    opts: { readMask?: string } = {},
  ): Promise<GoogleUpdatedLocation> {
    this.enter("getGoogleUpdated", [locationName, opts]);
    const loc = this.locations.find((l) => l.name === locationName);
    if (!loc) throw new CoreError("NOT_FOUND", `Unknown location ${locationName}`);
    const view = structuredClone(loc);
    const diff: string[] = [];
    for (const [path, value] of this.suggestions.get(locationName) ?? []) {
      const merchant = readPath(loc as unknown as Record<string, unknown>, path);
      if (JSON.stringify(merchant ?? null) === JSON.stringify(value ?? null)) continue;
      writePath(view as unknown as Record<string, unknown>, path, value);
      diff.push(path);
    }
    return {
      location: applyReadMask(view, opts.readMask),
      ...(diff.length ? { diffMask: diff.join(",") } : {}),
    };
  }

  private attributesFor(attributesName: string): { key: string; list: GoogleAttribute[] } {
    const m = /^(locations\/[^/]+)\/attributes$/.exec(attributesName);
    if (!m || !this.locations.some((l) => l.name === m[1])) {
      throw new CoreError("NOT_FOUND", `Unknown attributes ${attributesName}`);
    }
    const key = m[1]!;
    if (!this.attributes.has(key)) {
      this.attributes.set(key, [
        { name: "attributes/has_wifi", valueType: "BOOL", values: [true] },
        {
          name: "attributes/url_appointment",
          valueType: "URL",
          uriValues: [{ uri: "https://book.example.test/start" }],
        },
      ]);
    }
    return { key, list: this.attributes.get(key)! };
  }

  async getAttributes(name: string): Promise<GoogleAttributes> {
    this.enter("getAttributes", [name]);
    return { name, attributes: structuredClone(this.attributesFor(name).list) };
  }

  async updateAttributes(
    name: string,
    attributes: GoogleAttributes,
    attributeMask: string[],
  ): Promise<GoogleAttributes> {
    this.enter("updateAttributes", [name, attributes, attributeMask]);
    if (attributeMask.length === 0)
      throw new CoreError("INVALID_INPUT", "attributeMask is required");
    if (attributeMask.some((m) => !m.startsWith("attributes/"))) {
      throw new CoreError("INVALID_INPUT", "attributeMask entries must be attributes/{id}");
    }
    const { key, list } = this.attributesFor(name);
    let next = [...list];
    for (const m of attributeMask) {
      next = next.filter((a) => a.name !== m);
      // In the mask and in the body: set. In the mask only: delete. In the body only: ignored.
      const given = attributes.attributes?.find((a) => a.name === m);
      if (given) next.push(structuredClone(given));
    }
    this.attributes.set(key, next);
    return { name, attributes: structuredClone(next) };
  }

  async listCategories(
    opts: Parameters<GoogleClient["listCategories"]>[0],
  ): Promise<ListCategoriesResponse> {
    this.enter("listCategories", [opts]);
    // Like Google: the value is a quoted string, or a bare token with no whitespace.
    const raw = /^displayName=(.*)$/.exec(opts.filter ?? "")?.[1]?.trim() ?? "";
    const quoted = /^"(.*)"$/.exec(raw);
    if (!quoted && /\s/.test(raw)) {
      throw new GoogleApiError(400, {
        error: {
          code: 400,
          message: "Request contains an invalid argument.",
          status: "INVALID_ARGUMENT",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [
                { field: "filter", description: "displayName is the only supported filter" },
              ],
            },
          ],
        },
      });
    }
    const q = (quoted ? quoted[1]! : raw).toLowerCase();
    const all = this.metadata.categories
      .filter((c) => (c.displayName ?? "").toLowerCase().includes(q))
      .map((c) => (opts.view === "FULL" ? c : { name: c.name, displayName: c.displayName }));
    const p = MockGoogleClient.page(all, opts, 100);
    return { categories: p.items, ...(p.next ? { nextPageToken: p.next } : {}) };
  }

  async batchGetCategories(
    opts: Parameters<GoogleClient["batchGetCategories"]>[0],
  ): Promise<{ categories: GoogleCategoryMetadata[] }> {
    this.enter("batchGetCategories", [opts]);
    if (opts.names.length === 0) throw new CoreError("INVALID_INPUT", "names is required");
    return {
      categories: this.metadata.categories
        .filter((c) => opts.names.includes(c.name))
        .map((c) =>
          structuredClone(opts.view === "FULL" ? c : { name: c.name, displayName: c.displayName }),
        ),
    };
  }

  async listAttributeMetadata(
    opts: Parameters<GoogleClient["listAttributeMetadata"]>[0],
  ): Promise<ListAttributeMetadataResponse> {
    this.enter("listAttributeMetadata", [opts]);
    const all =
      this.metadata.attributes[opts.categoryName] ?? this.metadata.attributes.default ?? [];
    const p = MockGoogleClient.page(all, opts, 200);
    return { attributeMetadata: p.items, ...(p.next ? { nextPageToken: p.next } : {}) };
  }

  private findReview(reviewName: string): RawGoogleReview {
    const p = parseReviewName(reviewName);
    const found = p
      ? this.reviews.get(p.locationName)?.find((r) => r.name === reviewName)
      : undefined;
    if (!found) throw new CoreError("NOT_FOUND", `Unknown review ${reviewName}`);
    return found;
  }

  async listReviews(
    accountName: string,
    locationId: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListReviewsResponse> {
    this.enter("listReviews", [accountName, locationId, opts]);
    // Unknown locations list as empty (the mock does not police which locations exist).
    const all = [...(this.reviews.get(locationId) ?? [])]
      .filter((r) => r.name.startsWith(`${accountName}/${locationId}/reviews/`))
      .sort(
        (a, b) => Date.parse(b.updateTime) - Date.parse(a.updateTime) || (a.name < b.name ? -1 : 1),
      );
    const max = GOOGLE_LIMITS.reviewsListPageSize.limit;
    const size = Math.min(opts.pageSize ?? max, max);
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const end = start + size;
    const rated = all.map(mapReview).filter((r) => r.starRating !== null);
    return {
      reviews: all.slice(start, end).map((r) => structuredClone(mapReview(r))),
      totalReviewCount: all.length,
      ...(rated.length
        ? { averageRating: rated.reduce((n, r) => n + r.starRating!, 0) / rated.length }
        : {}),
      ...(end < all.length ? { nextPageToken: String(end) } : {}),
    };
  }

  async getReview(reviewName: string): Promise<GoogleReview> {
    this.enter("getReview", [reviewName]);
    return structuredClone(mapReview(this.findReview(reviewName)));
  }

  async updateReply(reviewName: string, comment: string) {
    this.enter("updateReply", [reviewName, comment]);
    const r = this.findReview(reviewName);
    r.reviewReply = { comment, updateTime: new Date().toISOString() };
    return structuredClone(r.reviewReply);
  }

  async deleteReply(reviewName: string): Promise<void> {
    this.enter("deleteReply", [reviewName]);
    delete this.findReview(reviewName).reviewReply;
  }

  async createLocalPost(parent: string, post: GoogleLocalPost): Promise<GoogleLocalPost> {
    this.enter("createLocalPost", [parent, post]);
    if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(parent)) {
      throw new CoreError("INVALID_INPUT", `Invalid location parent ${parent}`);
    }
    const now = new Date().toISOString();
    const created: GoogleLocalPost = {
      ...structuredClone(post),
      name: `${parent}/localPosts/MockPost${String(this.nextPostSeq++).padStart(4, "0")}`,
      createTime: now,
      updateTime: now,
      state: "LIVE",
      searchUrl: `https://search.example.test/post/${this.nextPostSeq}`,
    };
    this.posts.set(parent, [...(this.posts.get(parent) ?? []), created]);
    return structuredClone(created);
  }

  private findPost(postName: string): { list: GoogleLocalPost[]; post: GoogleLocalPost } {
    const parent = /^(accounts\/[^/]+\/locations\/[^/]+)\/localPosts\/[^/]+$/.exec(postName)?.[1];
    const list = parent ? this.posts.get(parent) : undefined;
    const post = list?.find((p) => p.name === postName);
    if (!list || !post) throw new GoogleApiError(404, { error: { message: "Post not found" } });
    return { list, post };
  }

  async updateLocalPost(
    postName: string,
    patch: Partial<GoogleLocalPost>,
    updateMask: string[],
  ): Promise<GoogleLocalPost> {
    this.enter("updateLocalPost", [postName, patch, updateMask]);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    const { post } = this.findPost(postName);
    const target = post as unknown as Record<string, unknown>;
    for (const path of updateMask) {
      writePath(target, path, readPath(patch as Record<string, unknown>, path));
    }
    post.updateTime = new Date().toISOString();
    return structuredClone(post);
  }

  async deleteLocalPost(postName: string): Promise<void> {
    this.enter("deleteLocalPost", [postName]);
    const { list, post } = this.findPost(postName);
    list.splice(list.indexOf(post), 1);
  }

  async listLocalPosts(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListLocalPostsResponse> {
    this.enter("listLocalPosts", [parent, opts]);
    const all = this.posts.get(parent) ?? [];
    const max = POST_LIMITS.listPageSize.limit;
    const size = Math.min(opts.pageSize ?? 20, max);
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const end = start + size;
    return {
      localPosts: all.slice(start, end).map((p) => structuredClone(p)),
      ...(end < all.length ? { nextPageToken: String(end) } : {}),
    };
  }

  /**
   * Deterministic fixture: the same (location, metric, date) always gives the same value, with a
   * weekday bump so charts look like data. Every day in range is present (the real API omits zeros).
   */
  async fetchDailyMetrics(
    locationName: string,
    metrics: readonly DailyMetric[],
    startDate: string,
    endDate: string,
  ): Promise<FetchDailyMetricsResponse> {
    this.enter("fetchDailyMetrics", [locationName, metrics, startDate, endDate]);
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
      throw new CoreError("INVALID_INPUT", "Invalid date range");
    }
    return {
      series: metrics.map((metric) => {
        const base = 5 + (seeded(locationName, metric, "base") % 40);
        const points = [];
        for (let t = start; t <= end; t += DAY_MS) {
          const date = new Date(t).toISOString().slice(0, 10);
          const weekday = new Date(t).getUTCDay();
          const bump = weekday === 0 || weekday === 6 ? 0 : 3;
          points.push({ date, value: base + bump + (seeded(locationName, metric, date) % 11) });
        }
        return { metric, points };
      }),
    };
  }

  /**
   * Deterministic fixture: a per-location set of KEYWORD_POOL with per-month counts, highest first.
   * Counts under 15 come back as `threshold: 15` (Google hides small counts), as the real API does.
   */
  async listMonthlySearchKeywords(
    locationName: string,
    startMonth: string,
    endMonth: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListSearchKeywordsResponse> {
    this.enter("listMonthlySearchKeywords", [locationName, startMonth, endMonth, opts]);
    if (!MONTH_RE.test(startMonth) || !MONTH_RE.test(endMonth) || endMonth < startMonth) {
      throw new CoreError("INVALID_INPUT", "Invalid month range");
    }
    const months: string[] = [];
    let [y, m] = startMonth.split("-").map(Number) as [number, number];
    for (;;) {
      const cur = `${y}-${String(m).padStart(2, "0")}`;
      months.push(cur);
      if (cur >= endMonth) break;
      if (++m > 12) [y, m] = [y + 1, 1];
    }
    const all = KEYWORD_POOL.map((keyword) => ({
      keyword,
      count: months.reduce((n, mo) => n + (seeded(locationName, keyword, mo) % 60), 0),
    }))
      .filter((k) => seeded(locationName, k.keyword, "listed") % 4 !== 0)
      .sort((a, b) => b.count - a.count || (a.keyword < b.keyword ? -1 : 1));
    const keywords = all.map((k) =>
      k.count < 15 ? { keyword: k.keyword, threshold: 15 } : { keyword: k.keyword, value: k.count },
    );
    const size = Math.min(opts.pageSize ?? 100, 100);
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const end = start + size;
    return {
      keywords: keywords.slice(start, end),
      ...(end < keywords.length ? { nextPageToken: String(end) } : {}),
    };
  }

  private requireLocation(locationName: string) {
    if (!this.locations.some((l) => l.name === locationName)) {
      throw new CoreError("NOT_FOUND", `Unknown location ${locationName}`);
    }
  }

  private static page<T>(all: T[], opts: { pageToken?: string; pageSize?: number }, max: number) {
    const size = Math.min(opts.pageSize ?? 100, max);
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const end = start + size;
    return {
      items: all.slice(start, end).map((x) => structuredClone(x)),
      next: end < all.length ? String(end) : undefined,
    };
  }

  async listMedia(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListMediaResponse> {
    this.enter("listMedia", [parent, opts]);
    const all = this.media.get(parent) ?? [];
    const p = MockGoogleClient.page(all, opts, MEDIA_LIMITS.listPageSize.limit * 25);
    return {
      mediaItems: p.items,
      totalMediaItemCount: all.length,
      ...(p.next ? { nextPageToken: p.next } : {}),
    };
  }

  async listCustomerMedia(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListMediaResponse> {
    this.enter("listCustomerMedia", [parent, opts]);
    const all = this.customerMedia.get(parent) ?? [];
    const p = MockGoogleClient.page(all, opts, MEDIA_LIMITS.customerPageSize.limit);
    return {
      mediaItems: p.items,
      totalMediaItemCount: all.length,
      ...(p.next ? { nextPageToken: p.next } : {}),
    };
  }

  async createMedia(parent: string, item: GoogleMediaItem): Promise<GoogleMediaItem> {
    this.enter("createMedia", [parent, item]);
    if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(parent)) {
      throw new CoreError("INVALID_INPUT", `Invalid location parent ${parent}`);
    }
    let uploaded: { bytes: Uint8Array; contentType: string } | undefined;
    if (item.dataRef) {
      uploaded = this.uploads.get(item.dataRef.resourceName);
      if (!uploaded) {
        throw new GoogleApiError(400, { error: { message: "dataRef has no uploaded bytes" } });
      }
    } else if (!item.sourceUrl?.startsWith("https://")) {
      throw new GoogleApiError(400, { error: { message: "sourceUrl must be a public https URL" } });
    }
    let category = item.locationAssociation?.category;
    if (category === "LOGO") category = "PROFILE"; // Google maps the deprecated alias
    if (!category || !(MEDIA_LIMITS.categories.values as readonly string[]).includes(category)) {
      throw new GoogleApiError(400, {
        error: { message: "locationAssociation.category is required" },
      });
    }
    const list = this.media.get(parent) ?? [];
    // "A location has only one cover photo" / "only one profile photo": a new one replaces the old.
    const single = category === "COVER" || category === "PROFILE";
    const kept = single ? list.filter((m) => m.locationAssociation?.category !== category) : list;
    const id =
      category === "PROFILE"
        ? "profile"
        : `MockMedia${String(this.nextMediaSeq++).padStart(4, "0")}`;
    const created: GoogleMediaItem = {
      name: `${parent}/media/${id}`,
      mediaFormat: "PHOTO",
      locationAssociation: { category },
      googleUrl: `https://lh3.example.test/media/${id}`,
      thumbnailUrl: `https://lh3.example.test/media/${id}=s200`,
      // Documented quirk: a profile photo reports the epoch as createTime, the sourceUrl is not retained.
      createTime: category === "PROFILE" ? "1970-01-01T00:00:00Z" : new Date().toISOString(),
      ...(category === "PROFILE"
        ? {}
        : {
            ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
            dimensions: { widthPixels: 720, heightPixels: 720 },
          }),
      ...(item.description && category !== "COVER" ? { description: item.description } : {}),
    };
    this.media.set(parent, [...kept, created]);
    return structuredClone(created);
  }

  async startMediaUpload(parent: string): Promise<GoogleMediaDataRef> {
    this.enter("startMediaUpload", [parent]);
    if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(parent)) {
      throw new CoreError("INVALID_INPUT", `Invalid location parent ${parent}`);
    }
    const resourceName = `MockUpload${String(this.nextMediaSeq++).padStart(4, "0")}`;
    this.uploads.set(resourceName, undefined);
    return { resourceName };
  }

  async uploadMediaBytes(
    dataRef: GoogleMediaDataRef,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    // Not byte-logged: enter() records arguments, and a photo is not a diagnostic.
    this.enter("uploadMediaBytes", [dataRef, { byteLength: bytes.length, contentType }]);
    if (!this.uploads.has(dataRef.resourceName)) {
      throw new GoogleApiError(404, { error: { message: "Unknown upload reference" } });
    }
    this.uploads.set(dataRef.resourceName, { bytes: bytes.slice(), contentType });
  }

  async deleteMedia(mediaName: string): Promise<void> {
    this.enter("deleteMedia", [mediaName]);
    const parent = /^(accounts\/[^/]+\/locations\/[^/]+)\/media\/[^/]+$/.exec(mediaName)?.[1];
    const list = parent ? this.media.get(parent) : undefined;
    const i = list?.findIndex((m) => m.name === mediaName) ?? -1;
    if (!list || i < 0)
      throw new GoogleApiError(404, { error: { message: "Media item not found" } });
    list.splice(i, 1);
  }

  private readonly notificationSettings = new Map<string, GoogleNotificationSetting>();

  async getNotificationSetting(accountName: string): Promise<GoogleNotificationSetting> {
    this.enter("getNotificationSetting", [accountName]);
    return structuredClone(
      this.notificationSettings.get(accountName) ?? { name: `${accountName}/notificationSetting` },
    );
  }

  async updateNotificationSetting(
    accountName: string,
    setting: GoogleNotificationSetting,
    updateMask: string,
  ): Promise<GoogleNotificationSetting> {
    this.enter("updateNotificationSetting", [accountName, setting, updateMask]);
    const next = { ...structuredClone(setting), name: `${accountName}/notificationSetting` };
    this.notificationSettings.set(accountName, next);
    return structuredClone(next);
  }

  async getVoiceOfMerchantState(locationName: string): Promise<GoogleVoiceOfMerchantState> {
    this.enter("getVoiceOfMerchantState", [locationName]);
    this.requireLocation(locationName);
    return structuredClone(
      this.voiceOfMerchant.get(locationName) ?? {
        hasVoiceOfMerchant: true,
        hasBusinessAuthority: true,
      },
    );
  }

  async listLocationAdmins(parent: string): Promise<{ admins: GoogleAdmin[] }> {
    this.enter("listLocationAdmins", [parent]);
    this.requireLocation(parent);
    return { admins: structuredClone(
        this.admins.get(parent) ?? [
          { name: `${parent}/admins/MockOwner`, admin: "Mock Owner", role: "PRIMARY_OWNER" },
        ],
      ) };
  }

  async listVerifications(
    parent: string,
    opts: { pageToken?: string; pageSize?: number } = {},
  ): Promise<ListVerificationsResponse> {
    this.enter("listVerifications", [parent, opts]);
    this.requireLocation(parent);
    const p = MockGoogleClient.page(this.verifications.get(parent) ?? [], opts, 100);
    return { verifications: p.items, ...(p.next ? { nextPageToken: p.next } : {}) };
  }

  private linksFor(locationName: string): GooglePlaceActionLink[] {
    this.requireLocation(locationName);
    if (!this.placeLinks.has(locationName)) {
      // One link the merchant cannot edit, like a third-party aggregator's.
      this.placeLinks.set(locationName, [
        {
          name: `${locationName}/placeActionLinks/MockAggregator`,
          uri: "https://aggregator.example.test/order",
          placeActionType: "FOOD_ORDERING",
          isPreferred: false,
          isEditable: false,
          providerType: "AGGREGATOR_3P",
          createTime: "2026-01-01T00:00:00Z",
          updateTime: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    return this.placeLinks.get(locationName)!;
  }

  async listPlaceActionLinks(
    parent: string,
    opts: { pageToken?: string; pageSize?: number; placeActionType?: string } = {},
  ): Promise<ListPlaceActionLinksResponse> {
    this.enter("listPlaceActionLinks", [parent, opts]);
    const all = this.linksFor(parent).filter(
      (l) => !opts.placeActionType || l.placeActionType === opts.placeActionType,
    );
    const p = MockGoogleClient.page(all, opts, 100);
    return { placeActionLinks: p.items, ...(p.next ? { nextPageToken: p.next } : {}) };
  }

  private checkLink(l: { uri?: string; placeActionType?: string }) {
    if (!l.uri?.startsWith("https://")) {
      throw new GoogleApiError(400, { error: { message: "uri must be https" } });
    }
    if (!(PLACE_ACTION_TYPES as readonly string[]).includes(l.placeActionType ?? "")) {
      throw new GoogleApiError(400, { error: { message: "unsupported placeActionType" } });
    }
  }

  async createPlaceActionLink(
    parent: string,
    link: GooglePlaceActionLink,
  ): Promise<GooglePlaceActionLink> {
    this.enter("createPlaceActionLink", [parent, link]);
    const list = this.linksFor(parent);
    this.checkLink(link);
    if (list.some((l) => l.uri === link.uri && l.placeActionType === link.placeActionType)) {
      throw new GoogleApiError(409, { error: { status: "ALREADY_EXISTS" } });
    }
    if (link.isPreferred) {
      for (const l of list) if (l.placeActionType === link.placeActionType) l.isPreferred = false;
    }
    const now = new Date().toISOString();
    const created: GooglePlaceActionLink = {
      name: `${parent}/placeActionLinks/MockLink${String(this.nextLinkSeq++).padStart(4, "0")}`,
      uri: link.uri,
      placeActionType: link.placeActionType,
      isPreferred: link.isPreferred ?? false,
      isEditable: true,
      providerType: "MERCHANT",
      createTime: now,
      updateTime: now,
    };
    list.push(created);
    return structuredClone(created);
  }

  private findLink(name: string): { list: GooglePlaceActionLink[]; link: GooglePlaceActionLink } {
    const parent = /^(locations\/[^/]+)\/placeActionLinks\/[^/]+$/.exec(name)?.[1];
    if (!parent) throw new CoreError("INVALID_INPUT", `Invalid place action link ${name}`);
    const list = this.linksFor(parent);
    const link = list.find((l) => l.name === name);
    if (!link) throw new GoogleApiError(404, { error: { message: "Place action link not found" } });
    if (link.isEditable === false) {
      throw new GoogleApiError(400, {
        error: { message: "This link cannot be edited by the client" },
      });
    }
    return { list, link };
  }

  async updatePlaceActionLink(
    name: string,
    patch: Partial<GooglePlaceActionLink>,
    updateMask: string[],
  ): Promise<GooglePlaceActionLink> {
    this.enter("updatePlaceActionLink", [name, patch, updateMask]);
    if (updateMask.length === 0) throw new CoreError("INVALID_INPUT", "updateMask is required");
    if (updateMask.some((m) => !["uri", "placeActionType", "isPreferred"].includes(m))) {
      throw new CoreError(
        "INVALID_INPUT",
        "Only uri, placeActionType and isPreferred are editable",
      );
    }
    const { list, link } = this.findLink(name);
    const next = { ...link };
    for (const m of updateMask as ("uri" | "placeActionType" | "isPreferred")[]) {
      (next as Record<string, unknown>)[m] = patch[m];
    }
    this.checkLink(next);
    if (
      list.some(
        (l) => l !== link && l.uri === next.uri && l.placeActionType === next.placeActionType,
      )
    ) {
      throw new GoogleApiError(409, { error: { status: "ALREADY_EXISTS" } });
    }
    if (next.isPreferred) {
      for (const l of list)
        if (l !== link && l.placeActionType === next.placeActionType) l.isPreferred = false;
    }
    Object.assign(link, next, { updateTime: new Date().toISOString() });
    return structuredClone(link);
  }

  async deletePlaceActionLink(name: string): Promise<void> {
    this.enter("deletePlaceActionLink", [name]);
    const { list, link } = this.findLink(name);
    list.splice(list.indexOf(link), 1);
  }

  async getFoodMenus(name: string): Promise<GoogleFoodMenus> {
    this.enter("getFoodMenus", [name]);
    const parent = /^(accounts\/[^/]+\/locations\/[^/]+)\/foodMenus$/.exec(name)?.[1];
    if (!parent) throw new CoreError("INVALID_INPUT", `Invalid food menus name ${name}`);
    return structuredClone(this.foodMenus.get(name) ?? { name, menus: [] });
  }

  async updateFoodMenus(foodMenus: GoogleFoodMenus, updateMask: string[]): Promise<GoogleFoodMenus> {
    this.enter("updateFoodMenus", [foodMenus, updateMask]);
    if (!/^accounts\/[^/]+\/locations\/[^/]+\/foodMenus$/.test(foodMenus.name)) {
      throw new CoreError("INVALID_INPUT", `Invalid food menus name ${foodMenus.name}`);
    }
    if (updateMask.some((m) => m !== "menus")) {
      throw new CoreError("INVALID_INPUT", "Only menus is updatable");
    }
    for (const menu of foodMenus.menus) {
      if (menu.labels.length === 0 || menu.sections.length === 0) {
        throw new GoogleApiError(400, { error: { message: "menu needs labels and sections" } });
      }
      for (const s of menu.sections) {
        if (s.labels.length === 0 || s.items.length === 0) {
          throw new GoogleApiError(400, { error: { message: "section needs labels and items" } });
        }
        for (const i of s.items) {
          if (i.labels.length === 0 || !i.attributes?.price) {
            throw new GoogleApiError(400, { error: { message: "item needs labels and a price" } });
          }
        }
      }
    }
    const next = { name: foodMenus.name, menus: structuredClone(foodMenus.menus) };
    this.foodMenus.set(foodMenus.name, next);
    return structuredClone(next);
  }

  /**
   * Test-only: Google (or a Maps user) changes what consumers see. `patch` + `mask` have the same
   * shape as updateLocation; the merchant's own location is not touched, and a later
   * updateLocation on the same path clears the suggestion (accept = patch; reject = patch back).
   */
  suggestGoogleChange(locationName: string, patch: Partial<GoogleLocation>, mask: string[]) {
    this.requireLocation(locationName);
    const map = this.suggestions.get(locationName) ?? new Map<string, unknown>();
    for (const path of mask) map.set(path, readPath(patch as Record<string, unknown>, path));
    this.suggestions.set(locationName, map);
  }

  /** Test-only: a customer posts a photo. Returns its resource name. */
  addCustomerMedia(
    parent: string,
    init: { profileName?: string; createTime?: string } = {},
  ): string {
    const id = `MockCustomer${String(this.nextMediaSeq++).padStart(4, "0")}`;
    const item: GoogleMediaItem = {
      name: `${parent}/media/${id}`,
      mediaFormat: "PHOTO",
      googleUrl: `https://lh3.example.test/customer/${id}`,
      thumbnailUrl: `https://lh3.example.test/customer/${id}=s200`,
      createTime: init.createTime ?? new Date().toISOString(),
      attribution: {
        profileName: init.profileName ?? "A Google User",
        profileUrl: `https://maps.example.test/contrib/${id}`,
        takedownUrl: `https://maps.example.test/takedown/${id}`,
      },
    };
    this.customerMedia.set(parent, [...(this.customerMedia.get(parent) ?? []), item]);
    return item.name!;
  }

  /** Test-only: set what getVoiceOfMerchantState returns. */
  setVoiceOfMerchantState(locationName: string, state: GoogleVoiceOfMerchantState) {
    this.voiceOfMerchant.set(locationName, structuredClone(state));
  }

  /** Test-only: set the admins `listLocationAdmins` returns for a location. */
  setLocationAdmins(locationName: string, admins: Omit<GoogleAdmin, "name">[]) {
    this.admins.set(
      locationName,
      admins.map((a, i) => ({ name: `${locationName}/admins/MockAdmin${i + 1}`, ...a })),
    );
  }

  /** Test-only: add a verification attempt to a location's history. */
  addVerification(locationName: string, v: Omit<GoogleVerification, "name">) {
    const list = this.verifications.get(locationName) ?? [];
    list.push({ name: `${locationName}/verifications/MockVerification${list.length + 1}`, ...v });
    this.verifications.set(locationName, list);
  }

  /**
   * Test-only: change a location as if someone edited it in the Google UI. Same mask semantics as
   * updateLocation; does not count as a client call.
   */
  editLocation(locationName: string, patch: Partial<GoogleLocation>, updateMask: string[]) {
    const loc = this.locations.find((l) => l.name === locationName);
    if (!loc) throw new CoreError("NOT_FOUND", `Unknown location ${locationName}`);
    for (const path of updateMask) {
      writePath(
        loc as unknown as Record<string, unknown>,
        path,
        readPath(patch as Record<string, unknown>, path),
      );
    }
  }

  /** Test-only: add a location (default hours Mon-Fri 09:00-17:00) so a test row can point at its own id. */
  addLocation(init: Pick<GoogleLocation, "name" | "title"> & Partial<GoogleLocation>) {
    this.locations.push({
      account: "accounts/100000000000000000001",
      languageCode: "en",
      phoneNumbers: { primaryPhone: "+1 555 010 0199" },
      categories: { primaryCategory: { name: "categories/gcid:dentist", displayName: "Dentist" } },
      websiteUri: "https://example.test/start",
      regularHours: {
        periods: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((d) => ({
          openDay: d,
          openTime: { hours: 9 },
          closeDay: d,
          closeTime: { hours: 17 },
        })),
      },
      ...structuredClone(init),
    });
  }

  /** Test-only: set (or with `null`, delete) an attribute as if edited in the Google UI. */
  editAttribute(locationName: string, attr: GoogleAttribute | { name: string; delete: true }) {
    const { key, list } = this.attributesFor(`${locationName}/attributes`);
    const rest = list.filter((a) => a.name !== attr.name);
    this.attributes.set(key, "delete" in attr ? rest : [...rest, structuredClone(attr)]);
  }

  /**
   * Test-only: add a review under `accountName`/`locationName` (`locations/{l}`), as if a customer
   * posted it on Google. Does not count as a client call. Returns the review name.
   */
  addReview(
    accountName: string,
    locationName: string,
    init: {
      starRating?: RawGoogleReview["starRating"];
      comment?: string;
      reviewerName?: string;
      isAnonymous?: boolean;
      createTime?: string;
      reply?: string;
    } = {},
  ): string {
    const id = `MockAdded${String(this.nextReviewSeq++).padStart(4, "0")}`;
    const createTime = init.createTime ?? new Date().toISOString();
    const review: RawGoogleReview = {
      name: `${accountName}/${locationName}/reviews/${id}`,
      reviewId: id,
      reviewer: init.isAnonymous
        ? { displayName: "A Google User", isAnonymous: true }
        : { displayName: init.reviewerName ?? "Test Reviewer", isAnonymous: false },
      starRating: init.starRating ?? "FIVE",
      createTime,
      updateTime: createTime,
      ...(init.comment !== undefined ? { comment: init.comment } : {}),
      ...(init.reply !== undefined
        ? { reviewReply: { comment: init.reply, updateTime: createTime } }
        : {}),
    };
    this.reviews.set(locationName, [...(this.reviews.get(locationName) ?? []), review]);
    return review.name;
  }

  /**
   * Test-only: change a review as if the customer edited it or the owner replied in the Google UI.
   * `updateTime` moves to now unless given. `reply: null` removes the reply.
   */
  updateReview(
    reviewName: string,
    patch: {
      starRating?: RawGoogleReview["starRating"];
      comment?: string;
      reply?: string | null;
      updateTime?: string;
    },
  ) {
    const r = this.findReview(reviewName);
    if (patch.starRating !== undefined) r.starRating = patch.starRating;
    if (patch.comment !== undefined) r.comment = patch.comment;
    const updateTime = patch.updateTime ?? new Date().toISOString();
    r.updateTime = updateTime;
    if (patch.reply === null) delete r.reviewReply;
    else if (patch.reply !== undefined) r.reviewReply = { comment: patch.reply, updateTime };
  }
}
