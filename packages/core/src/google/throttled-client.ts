import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { googleIdempotencyKeys, type Db } from "@opengmb/db";
import { canonicalJson } from "../audit";
import { CoreError } from "../errors";
import type {
  DailyMetric,
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
} from "./client";
import { recordGoogleCall } from "../monitoring/google-usage";
import { reportLimitEvent } from "../limits/alerts";
import { GoogleApiError, GoogleOrgLimitError, GoogleRateLimitError, GoogleRetriesExhaustedError } from "./errors";
import {
  LOCATION_EDIT_LIMIT,
  PostgresRateLimiter,
  ORG_LIMIT,
  ORG_WINDOW_MS,
  orgBucket,
  PROJECT_LIMIT,
  PROJECT_WINDOW_MS,
  currentProjectBucket,
  locationEditBucket,
  realClock,
  type Clock,
} from "./throttler";

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const MAX_RATE_LIMIT_RETRIES = 5;
export const MAX_SERVER_ERROR_RETRIES = 2;

type Bucket = { key: string; limit: number };

/** `locations/{l}` out of `accounts/{a}/locations/{l}[/...]` or `locations/{l}[/...]`, so every edit shares one bucket. */
function locationOf(name: string): string {
  const m = /(?:^|\/)(locations\/[^/]+)/.exec(name);
  if (!m) throw new CoreError("INVALID_INPUT", `Not a location resource name: ${name}`);
  return m[1]!;
}

/** Wraps a client so every method call (retries included) is counted per UTC day for the H2 quota view. */
function countingClient(inner: GoogleClient, db: Db): GoogleClient {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return async (...args: unknown[]) => {
        await recordGoogleCall(db, prop);
        return v.apply(target, args);
      };
    },
  });
}

export type WriteContext = { orgId: string; idempotencyKey: string };

/**
 * Decorator over any GoogleClient. When built with an `orgId` (the factory always does), every
 * attempt first takes a slot in that org's `org:<id>` bucket or throws `GoogleOrgLimitError` (H8, same
 * limiter in mock and live mode). Every call takes a slot in the shared `project` bucket
 * (limits from config/google-limits.ts). Writes also take `location-edit:<name>` first, so a location waiting on
 * its own limit does not burn project quota. 429s retry with exponential backoff + full jitter
 * (honouring Retry-After, the larger wins), 5xx retry twice, other errors surface immediately.
 * Each retry re-acquires quota because Google counts retries too.
 */
export class ThrottledGoogleClient {
  readonly inner: GoogleClient;
  private readonly clock: Clock;
  private readonly limiter: PostgresRateLimiter;

  constructor(
    inner: GoogleClient,
    private readonly db: Db,
    clock: Partial<Clock> = {},
    private readonly orgId?: string,
  ) {
    this.inner = countingClient(inner, db);
    this.clock = { ...realClock, ...clock };
    this.limiter = new PostgresRateLimiter(db, this.clock);
  }

  private async run<T>(buckets: Bucket[], call: () => Promise<T>): Promise<T> {
    let rateLimited = 0;
    let serverErrors = 0;
    for (let attempts = 1; ; attempts++) {
      if (this.orgId) {
        // H8: fail fast, before any project slot is taken, so an over-limit org burns nothing shared.
        const { retryAfterMs } = await this.limiter.tryAcquire(orgBucket(this.orgId), ORG_LIMIT, ORG_WINDOW_MS);
        if (retryAfterMs > 0) {
          reportLimitEvent("google_org_limited");
          throw new GoogleOrgLimitError(retryAfterMs);
        }
      }
      for (const b of buckets) await this.limiter.acquire(b.key, b.limit, PROJECT_WINDOW_MS);
      try {
        return await call();
      } catch (e) {
        let retryAfterMs = 0;
        let retry: number;
        if (e instanceof GoogleRateLimitError) {
          if (rateLimited >= MAX_RATE_LIMIT_RETRIES)
            throw new GoogleRetriesExhaustedError(attempts, e);
          retryAfterMs = e.retryAfterMs ?? 0;
          retry = rateLimited++;
        } else if (e instanceof GoogleApiError && e.status >= 500) {
          if (serverErrors >= MAX_SERVER_ERROR_RETRIES) throw e;
          retry = serverErrors++;
        } else {
          throw e;
        }
        const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retry);
        await this.clock.sleep(Math.max(retryAfterMs, Math.floor(this.clock.random() * ceiling)));
      }
    }
  }

  private readonly project: Bucket[] = [{ key: currentProjectBucket(), limit: PROJECT_LIMIT }];

  listAccounts(): Promise<ListAccountsResponse> {
    return this.run(this.project, () => this.inner.listAccounts());
  }

  listLocations(
    accountName: string,
    opts?: { readMask?: string; pageToken?: string; pageSize?: number },
  ): Promise<ListLocationsResponse> {
    return this.run(this.project, () => this.inner.listLocations(accountName, opts));
  }

  getLocation(locationName: string, opts?: { readMask?: string }): Promise<GoogleLocation> {
    return this.run(this.project, () => this.inner.getLocation(locationName, opts));
  }

  getAttributes(name: string): Promise<GoogleAttributes> {
    return this.run(this.project, () => this.inner.getAttributes(name));
  }

  /** Reads take project quota only; there is no idempotency key for reads. */
  listReviews(
    accountName: string,
    locationId: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListReviewsResponse> {
    return this.run(this.project, () => this.inner.listReviews(accountName, locationId, opts));
  }

  /** Performance API reads: project quota only. */
  fetchDailyMetrics(
    locationName: string,
    metrics: readonly DailyMetric[],
    startDate: string,
    endDate: string,
  ): Promise<FetchDailyMetricsResponse> {
    return this.run(this.project, () =>
      this.inner.fetchDailyMetrics(locationName, metrics, startDate, endDate),
    );
  }

  listMonthlySearchKeywords(
    locationName: string,
    startMonth: string,
    endMonth: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListSearchKeywordsResponse> {
    return this.run(this.project, () =>
      this.inner.listMonthlySearchKeywords(locationName, startMonth, endMonth, opts),
    );
  }

  getReview(reviewName: string): Promise<GoogleReview> {
    return this.run(this.project, () => this.inner.getReview(reviewName));
  }

  /**
   * Idempotent write. Same key + same request: the stored response is returned with no Google call.
   * Same key + different request, or same key still in flight: CONFLICT. If Google fails, the
   * pending row is removed so the caller can retry with the same key.
   */
  private async idempotentWrite<T>(
    request: unknown,
    ctx: WriteContext,
    buckets: Bucket[],
    call: () => Promise<T>,
  ): Promise<T> {
    const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
    const key = { orgId: ctx.orgId, key: ctx.idempotencyKey };
    const where = and(
      eq(googleIdempotencyKeys.orgId, key.orgId),
      eq(googleIdempotencyKeys.key, key.key),
    );

    const [claimed] = await this.db
      .insert(googleIdempotencyKeys)
      .values({ ...key, requestHash, status: "pending" })
      .onConflictDoNothing()
      .returning({ key: googleIdempotencyKeys.key });
    if (!claimed) {
      const [existing] = await this.db.select().from(googleIdempotencyKeys).where(where);
      // Deleted between the insert and the select (failed first attempt): treat as in progress.
      if (!existing) throw new CoreError("CONFLICT", "Idempotency key is in progress");
      if (existing.requestHash !== requestHash) {
        throw new CoreError("CONFLICT", "Idempotency key was already used for a different request");
      }
      if (existing.status === "done") return existing.response as T;
      throw new CoreError("CONFLICT", "Idempotency key is in progress");
    }

    let result: T;
    try {
      result = await this.run(buckets, call);
    } catch (e) {
      await this.db
        .delete(googleIdempotencyKeys)
        .where(and(where, eq(googleIdempotencyKeys.status, "pending")));
      throw e;
    }
    // If this write fails the row stays pending: Google already applied the edit, so blocking
    // a blind retry (CONFLICT "in progress") is safer than repeating it.
    await this.db
      .update(googleIdempotencyKeys)
      .set({ status: "done", response: result })
      .where(where);
    return result;
  }

  /** Profile edit: takes the per-location edit bucket, then project quota. Callers must be `profile/publish.ts`. */
  updateLocation(
    locationName: string,
    patch: Partial<GoogleLocation>,
    updateMask: string[],
    ctx: WriteContext,
  ): Promise<GoogleLocation> {
    return this.idempotentWrite(
      { locationName, patch, updateMask },
      ctx,
      [{ key: locationEditBucket(locationName), limit: LOCATION_EDIT_LIMIT }, ...this.project],
      () => this.inner.updateLocation(locationName, patch, updateMask),
    );
  }

  /**
   * Attribute edit: an edit of the same location, so it shares the per-location edit bucket with
   * updateLocation (`locationName` is `locations/{l}`; the attributes resource is
   * `locations/{l}/attributes`). Callers must be `profile/publish.ts`.
   */
  updateAttributes(
    locationName: string,
    attributes: GoogleAttributes,
    attributeMask: string[],
    ctx: WriteContext,
  ): Promise<GoogleAttributes> {
    return this.idempotentWrite(
      { locationName, attributes, attributeMask },
      ctx,
      [{ key: locationEditBucket(locationName), limit: LOCATION_EDIT_LIMIT }, ...this.project],
      () => this.inner.updateAttributes(`${locationName}/attributes`, attributes, attributeMask),
    );
  }

  listCategories(
    opts: Parameters<GoogleClient["listCategories"]>[0],
  ): Promise<ListCategoriesResponse> {
    return this.run(this.project, () => this.inner.listCategories(opts));
  }

  batchGetCategories(
    opts: Parameters<GoogleClient["batchGetCategories"]>[0],
  ): Promise<{ categories: GoogleCategoryMetadata[] }> {
    return this.run(this.project, () => this.inner.batchGetCategories(opts));
  }

  listAttributeMetadata(
    opts: Parameters<GoogleClient["listAttributeMetadata"]>[0],
  ): Promise<ListAttributeMetadataResponse> {
    return this.run(this.project, () => this.inner.listAttributeMetadata(opts));
  }

  /**
   * Reply write (reviews.updateReply). Project quota + idempotency only: a review reply is not a
   * profile edit, so it does NOT take the per-location edit bucket (GOOGLE_LIMITS.locationEditsPerMinute
   * is for location profile data). Callers must be `reviews/publish.ts`; the code-enforcement test
   * fails on any other `.updateReply(` call. Key convention: `reply:<replyId>`.
   */
  updateReply(
    reviewName: string,
    comment: string,
    ctx: WriteContext,
  ): Promise<{ comment: string; updateTime: string }> {
    return this.idempotentWrite({ reviewName, comment }, ctx, this.project, () =>
      this.inner.updateReply(reviewName, comment),
    );
  }

  /**
   * Reply delete (reviews.deleteReply). Project quota + idempotency, no per-location edit bucket
   * (same reasoning as updateReply). Key convention: `delete:<reviewId>:<publishedReplyId>`.
   */
  async deleteReply(reviewName: string, ctx: WriteContext): Promise<void> {
    await this.idempotentWrite({ reviewName, delete: true }, ctx, this.project, async () => {
      await this.inner.deleteReply(reviewName);
      return { ok: true };
    });
  }

  /** Reads take project quota only. */
  listLocalPosts(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListLocalPostsResponse> {
    return this.run(this.project, () => this.inner.listLocalPosts(parent, opts));
  }

  /**
   * Post writes (createLocalPost / updateLocalPost / deleteLocalPost) take project quota +
   * idempotency only, not the per-location edit bucket: that bucket is for profile data edits
   * (GOOGLE_LIMITS.locationEditsPerMinute); Google's limits page lists no separate per-location
   * limit for posts. Callers must be `posts/publish.ts`; the enforcement test fails on any other
   * call. Key convention: `post:<postId>:<locationId>:<occurrence>`.
   */
  createLocalPost(
    parent: string,
    post: GoogleLocalPost,
    ctx: WriteContext,
  ): Promise<GoogleLocalPost> {
    return this.idempotentWrite({ parent, post }, ctx, this.project, () =>
      this.inner.createLocalPost(parent, post),
    );
  }

  updateLocalPost(
    postName: string,
    patch: Partial<GoogleLocalPost>,
    updateMask: string[],
    ctx: WriteContext,
  ): Promise<GoogleLocalPost> {
    return this.idempotentWrite({ postName, patch, updateMask }, ctx, this.project, () =>
      this.inner.updateLocalPost(postName, patch, updateMask),
    );
  }

  /** Key convention: `postdelete:<postTargetId>`. */
  async deleteLocalPost(postName: string, ctx: WriteContext): Promise<void> {
    await this.idempotentWrite({ postName, delete: true }, ctx, this.project, async () => {
      await this.inner.deleteLocalPost(postName);
      return { ok: true };
    });
  }

  /** Reads: project quota only. */
  getGoogleUpdated(
    locationName: string,
    opts?: { readMask?: string },
  ): Promise<GoogleUpdatedLocation> {
    return this.run(this.project, () => this.inner.getGoogleUpdated(locationName, opts));
  }

  listMedia(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListMediaResponse> {
    return this.run(this.project, () => this.inner.listMedia(parent, opts));
  }

  listCustomerMedia(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListMediaResponse> {
    return this.run(this.project, () => this.inner.listCustomerMedia(parent, opts));
  }

  getNotificationSetting(accountName: string): Promise<GoogleNotificationSetting> {
    return this.run(this.project, () => this.inner.getNotificationSetting(accountName));
  }

  /** A PATCH of a fixed value is naturally repeatable, so it takes project quota only (no idempotency key). */
  updateNotificationSetting(
    accountName: string,
    setting: GoogleNotificationSetting,
    updateMask: string,
  ): Promise<GoogleNotificationSetting> {
    return this.run(this.project, () =>
      this.inner.updateNotificationSetting(accountName, setting, updateMask),
    );
  }

  getVoiceOfMerchantState(locationName: string): Promise<GoogleVoiceOfMerchantState> {
    return this.run(this.project, () => this.inner.getVoiceOfMerchantState(locationName));
  }

  listLocationAdmins(parent: string): Promise<{ admins: GoogleAdmin[] }> {
    return this.run(this.project, () => this.inner.listLocationAdmins(parent));
  }

  listVerifications(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<ListVerificationsResponse> {
    return this.run(this.project, () => this.inner.listVerifications(parent, opts));
  }

  getFoodMenus(name: string): Promise<GoogleFoodMenus> {
    return this.run(this.project, () => this.inner.getFoodMenus(name));
  }

  listPlaceActionLinks(
    parent: string,
    opts?: { pageToken?: string; pageSize?: number; placeActionType?: string },
  ): Promise<ListPlaceActionLinksResponse> {
    return this.run(this.project, () => this.inner.listPlaceActionLinks(parent, opts));
  }

  /**
   * Photo and place-action-link writes change the listing, so they take the same per-location edit
   * bucket as profile edits (`locations/{l}`, whatever the resource spelling) plus project quota,
   * and are idempotent. Callers must be `media/publish.ts` and `placeActions/publish.ts`; the
   * enforcement test fails on any other call. Key conventions: `media:<opId>`, `placeaction:<opId>`.
   */
  private editBuckets(name: string): Bucket[] {
    return [
      { key: locationEditBucket(locationOf(name)), limit: LOCATION_EDIT_LIMIT },
      ...this.project,
    ];
  }

  createMedia(parent: string, item: GoogleMediaItem, ctx: WriteContext): Promise<GoogleMediaItem> {
    return this.idempotentWrite({ parent, item }, ctx, this.editBuckets(parent), () =>
      this.inner.createMedia(parent, item),
    );
  }

  /**
   * Photo bytes: startUpload, upload and create are ONE idempotent write (one key, the per-location
   * edit bucket, retried as a whole on 429/5xx), so a retry after success returns the stored
   * MediaItem instead of uploading again. The request hash covers the sha256 of the bytes, not
   * the bytes. Callers must be `media/publish.ts`.
   */
  uploadMedia(
    parent: string,
    item: Omit<GoogleMediaItem, "dataRef" | "sourceUrl">,
    file: { bytes: Uint8Array; contentType: string; sha256: string },
    ctx: WriteContext,
  ): Promise<GoogleMediaItem> {
    return this.idempotentWrite(
      { parent, item, upload: { sha256: file.sha256, contentType: file.contentType } },
      ctx,
      this.editBuckets(parent),
      async () => {
        const dataRef: GoogleMediaDataRef = await this.inner.startMediaUpload(parent);
        await this.inner.uploadMediaBytes(dataRef, file.bytes, file.contentType);
        return this.inner.createMedia(parent, { ...item, dataRef });
      },
    );
  }

  async deleteMedia(mediaName: string, ctx: WriteContext): Promise<void> {
    await this.idempotentWrite(
      { mediaName, delete: true },
      ctx,
      this.editBuckets(mediaName),
      async () => {
        await this.inner.deleteMedia(mediaName);
        return { ok: true };
      },
    );
  }

  createPlaceActionLink(
    parent: string,
    link: GooglePlaceActionLink,
    ctx: WriteContext,
  ): Promise<GooglePlaceActionLink> {
    return this.idempotentWrite({ parent, link }, ctx, this.editBuckets(parent), () =>
      this.inner.createPlaceActionLink(parent, link),
    );
  }

  updatePlaceActionLink(
    name: string,
    patch: Partial<GooglePlaceActionLink>,
    updateMask: string[],
    ctx: WriteContext,
  ): Promise<GooglePlaceActionLink> {
    return this.idempotentWrite({ name, patch, updateMask }, ctx, this.editBuckets(name), () =>
      this.inner.updatePlaceActionLink(name, patch, updateMask),
    );
  }

  async deletePlaceActionLink(name: string, ctx: WriteContext): Promise<void> {
    await this.idempotentWrite({ name, delete: true }, ctx, this.editBuckets(name), async () => {
      await this.inner.deletePlaceActionLink(name);
      return { ok: true };
    });
  }

  /** Key convention `foodmenu:<opId>`; callers must be `foodMenus/publish.ts`. */
  updateFoodMenus(
    foodMenus: GoogleFoodMenus,
    updateMask: string[],
    ctx: WriteContext,
  ): Promise<GoogleFoodMenus> {
    return this.idempotentWrite(
      { foodMenus, updateMask },
      ctx,
      this.editBuckets(foodMenus.name),
      () => this.inner.updateFoodMenus(foodMenus, updateMask),
    );
  }
}
