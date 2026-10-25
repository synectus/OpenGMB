/**
 * The notification digest sweep: hourly. A user's digest goes out on the first sweep at or after
 * DIGEST_LOCAL_HOUR in the user's digest zone (the zone of the workspace with most of their unread
 * items, see apps/worker/src/digest.ts), once per local date.
 */
export const DIGEST_CRON = "0 * * * *";
export const DIGEST_LOCAL_HOUR = 8;
