/**
 * Profile change watch (P5). Our own choices, not Google numbers, except where a source is given.
 */
export const PROFILE_WATCH_CONFIG = {
  /** Nightly snapshot fan-out (UTC). After the performance snapshot (03:00) so they do not compete for quota. */
  snapshotCron: "30 3 * * *",
  /** Customer-photo scan fan-out (UTC). */
  customerMediaCron: "45 3 * * *",
  /**
   * GOOGLE_UPDATE push: "The location has Google updates for review. The location_name field on the
   * notification will provide the resource name of the location with Google updates."
   * Source: https://mybusinessnotifications.googleapis.com/$discovery/rest?version=v1 (NotificationSetting.notificationTypes)
   * The push carries no field list: we call locations.getGoogleUpdated and read its diffMask.
   */
  googleUpdateSource: {
    sourceUrl:
      "https://developers.google.com/my-business/reference/notifications/rest/v1/NotificationSetting",
    verifiedOn: "2026-10-13",
  },
} as const;
