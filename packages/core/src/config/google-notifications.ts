import { NOTIFICATION_TYPES } from "../pubsub/notification";

/**
 * Externally-owned facts for the Business Profile Notifications API (PS). Logic reads these, never
 * literals. Re-verify against the source URL and bump `verifiedOn`.
 * Source: https://mybusinessnotifications.googleapis.com/$discovery/rest?version=v1 (discovery document;
 * reference page https://developers.google.com/my-business/reference/notifications/rest/v1/NotificationSetting)
 */
export const GOOGLE_NOTIFICATIONS = {
  sourceUrl: "https://mybusinessnotifications.googleapis.com/$discovery/rest?version=v1",
  verifiedOn: "2026-10-25",
  /** rootUrl + v1. */
  baseUrl: "https://mybusinessnotifications.googleapis.com/v1",
  /** accounts.getNotificationSetting: GET v1/accounts/{id}/notificationSetting. accounts.updateNotificationSetting: PATCH same path. */
  settingPath: (accountName: string) => `${accountName}/notificationSetting`,
  /** The Google resource name of the account, `accounts/{id}`. */
  accountNamePattern: /^accounts\/[^/]+$/,
  /** NotificationSetting fields: name (required), pubsubTopic, notificationTypes. updateMask names the fields we write. */
  updateMask: "pubsubTopic,notificationTypes",
  /**
   * The types the worker handles (processGoogleNotification: NEW_REVIEW, UPDATED_REVIEW, GOOGLE_UPDATE).
   * Other values in the API's enum (NEW_CUSTOMER_MEDIA, NEW_QUESTION, ...) would only be dropped, so they are not requested.
   */
  notificationTypes: [...NOTIFICATION_TYPES] as string[],
  /** Google's publisher service account; needs roles/pubsub.publisher on the topic. */
  publisherServiceAccount: "mybusiness-api-pubsub@system.gserviceaccount.com",
  /** The Google Cloud API that must be enabled, as shown in the console. */
  apiName: "My Business Notifications API",
  /** A push counts as recent for the "Live" status when one arrived within this many days. */
  recentPushDays: 30,
  topicPattern: /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/,
} as const;
