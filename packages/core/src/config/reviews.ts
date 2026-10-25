/**
 * Review sync polling. Our own choice, not a Google number: every 2 hours (at :15, off the :00 and
 * :30 marks the other schedules use). Each run costs about 1 to 2 Google requests per location
 * (review list pages of 50), well inside the 300/min quota. Pub/Sub push is the faster path once set up.
 */
export const REVIEWS_CONFIG = {
  syncCron: "15 */2 * * *",
  /**
   * Most rows one reviews.export returns (the result carries a truncated flag past it). Our own choice,
   * not a Google number: the CSV is built in memory and returned as one string, and 10,000 reviews is
   * a few MB, comfortably more than one workspace needs in one file. Narrow the filters to go further.
   */
  exportMaxRows: 10_000,
} as const;
