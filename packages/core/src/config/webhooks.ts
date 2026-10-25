/**
 * Outgoing webhook settings. Every value is our own product choice unless a comment says what it
 * mirrors. Nothing here can switch the SSRF guard off.
 */

/** Events a subscription can ask for (v1). */
export const WEBHOOK_EVENTS = ["review.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Mirrors NEGATIVE_ALERT_MAX_AGE_DAYS: a review Google created longer ago than this is history, not news. */
export const WEBHOOK_REVIEW_MAX_AGE_DAYS = 14;

export const WEBHOOK_QUEUE = "webhook.deliver";
/** Same shape as the reply queues: about 2 hours of retries (30 s doubling, 8 retries). */
export const WEBHOOK_QUEUE_OPTIONS = { retryLimit: 8, retryDelay: 30, retryBackoff: true } as const;

/** Whole-request ceiling for one delivery attempt. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** At most this much of a receiver's response body is read; the rest is dropped. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 4096;
/** Deliveries in a row that must end failed before a subscription is turned off. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
export const WEBHOOK_MAX_ACTIVE_PER_ORG = 10;
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
/** Daily at 04:15 UTC. */
export const WEBHOOK_PURGE_CRON = "15 4 * * *";
export const WEBHOOK_PURGE_QUEUE = "webhook.purge";

/** Longest `last_error` code stored on a delivery. */
export const WEBHOOK_LAST_ERROR_MAX_CHARS = 300;
/** Standard Webhooks signature tolerance for verifyWebhook (5 minutes). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
