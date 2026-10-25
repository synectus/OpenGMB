/**
 * A2: draft-on-arrival limits. Our own product choices, not Google or Anthropic numbers.
 * maxPerSync: the most AI drafts one review sync can queue (one sync is one location of one
 * organization), so a burst of reviews cannot run up an unbounded bill. The rest wait for a person
 * (they are still "needs reply" on Home) or for the "Draft replies with AI" button.
 * maxAgeDays: a sync does not draft for a review Google created longer ago than this, so a backfill
 * (a long outage, a truncated first import) never drafts a location's history.
 * retryLimit: pg-boss retries of one draft job after a transient AI or database failure.
 */
export const DRAFT_ON_ARRIVAL = {
  maxPerSync: 25,
  maxAgeDays: 14,
  retryLimit: 3,
} as const;
