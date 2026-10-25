import type { GoogleClient } from "./client";
import { GoogleWritesDisabledError } from "./errors";

/**
 * Every `GoogleClient` method, classified. `satisfies` makes a new interface method a compile error
 * until it is listed here, so a write can never slip through the read-only wrapper unclassified.
 */
export const GOOGLE_CLIENT_METHOD_KINDS = {
  fetchDailyMetrics: "read",
  listMonthlySearchKeywords: "read",
  listAccounts: "read",
  listLocations: "read",
  getLocation: "read",
  updateLocation: "write",
  getAttributes: "read",
  updateAttributes: "write",
  listCategories: "read",
  batchGetCategories: "read",
  listAttributeMetadata: "read",
  listReviews: "read",
  getReview: "read",
  updateReply: "write",
  deleteReply: "write",
  createLocalPost: "write",
  updateLocalPost: "write",
  deleteLocalPost: "write",
  listLocalPosts: "read",
  getGoogleUpdated: "read",
  listMedia: "read",
  listCustomerMedia: "read",
  createMedia: "write",
  startMediaUpload: "write",
  uploadMediaBytes: "write",
  deleteMedia: "write",
  getNotificationSetting: "read",
  updateNotificationSetting: "write",
  getVoiceOfMerchantState: "read",
  listVerifications: "read",
  listLocationAdmins: "read",
  listPlaceActionLinks: "read",
  createPlaceActionLink: "write",
  updatePlaceActionLink: "write",
  deletePlaceActionLink: "write",
  getFoodMenus: "read",
  updateFoodMenus: "write",
} as const satisfies Record<keyof GoogleClient, "read" | "write">;

/**
 * Passes reads to `inner` and refuses every write before it reaches `inner`. Used for live mode
 * while `GOOGLE_BUSINESS_WRITES` is not `live`: real data in, nothing out to Google. A refused
 * write fails its job (the app records a failure, never a fake publish).
 */
// Methods are assigned in the constructor from the table above, so the class declares none itself.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface ReadOnlyGoogleClient extends GoogleClient {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ReadOnlyGoogleClient {
  constructor(readonly inner: GoogleClient) {
    const self = this as unknown as Record<string, unknown>;
    const target = inner as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [name, kind] of Object.entries(GOOGLE_CLIENT_METHOD_KINDS)) {
      self[name] =
        kind === "read"
          ? (...args: unknown[]) => target[name]!.apply(inner, args)
          : async () => {
              throw new GoogleWritesDisabledError(name);
            };
    }
  }
}
