/**
 * Review request emails (R2).
 *
 * REVIEW_REQUEST_DAILY_LIMIT: most emails (first sends plus reminders) the whole server sends in any
 * rolling 24 hours. Source: Resend free plan, "limited to 100 emails per day" (3,000 a month),
 * https://resend.com/pricing, verified 2026-10-21. Digests, invites and reports share that quota.
 * Override with the REVIEW_REQUEST_DAILY_LIMIT environment variable on a paid plan.
 */
export const REVIEW_REQUEST_DAILY_LIMIT_DEFAULT = 100;
export function reviewRequestDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.REVIEW_REQUEST_DAILY_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : REVIEW_REQUEST_DAILY_LIMIT_DEFAULT;
}

/** Our own choice: mail goes out only from this local hour (inclusive) to the end hour (exclusive), in the client's time zone. */
export const SEND_FROM_HOUR = 8;
export const SEND_UNTIL_HOUR = 21;
/** Our own choice: the most emails one sweep sends, so a day's allowance is spread over the day. */
export const SWEEP_BATCH = 20;
/** Our own choice: failed sends are retried by later sweeps this many times. */
export const MAX_SEND_ATTEMPTS = 3;
/** Our own choice: people added in one go. */
export const MAX_RECIPIENTS_PER_IMPORT = 500;
export const REMINDER_DAYS_DEFAULT = 3;
export const REMINDER_DAYS_MIN = 1;
export const REMINDER_DAYS_MAX = 14;
/** Our own choice: the sweep runs every 5 minutes. */
export const REVIEW_REQUEST_SWEEP_QUEUE = "review-request.sweep";
export const REVIEW_REQUEST_SWEEP_CRON = "*/5 * * * *";

/**
 * Legal batch B (Q37): one client (workspace) may send at most this many review request emails (first
 * sends plus reminders) in any rolling 24 hours, so a large list is spread out and never looks like a
 * burst. Our own choice, below the server-wide allowance. Override with REVIEW_REQUEST_WORKSPACE_DAILY_LIMIT.
 */
export const REVIEW_REQUEST_WORKSPACE_DAILY_LIMIT_DEFAULT = 50;
export function reviewRequestWorkspaceDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.REVIEW_REQUEST_WORKSPACE_DAILY_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : REVIEW_REQUEST_WORKSPACE_DAILY_LIMIT_DEFAULT;
}

/**
 * How the uploader says the contacts were obtained (legal review Q16/Q20: record the list source at
 * upload). `phrase` completes the footer sentence "because you ... {business}". The 24 months comes
 * from the legal review's suggested limit. The labels and the acceptable-use rules the uploader
 * confirms are in the web messages (reviewsTools.emailCampaigns.source_* and rule1 to rule4).
 */
export const LIST_SOURCES = {
  purchase: { phrase: "bought from" },
  booking: { phrase: "booked with" },
  visit: { phrase: "visited" },
} as const;
export type ListSource = keyof typeof LIST_SOURCES;
export const LIST_SOURCE_KEYS = Object.keys(LIST_SOURCES) as [ListSource, ...ListSource[]];
