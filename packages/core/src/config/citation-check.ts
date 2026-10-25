/**
 * X2 NAP audit: limits for fetching a directory listing page. Every number is our own choice, not a
 * limit set by any directory. A run is started by a person (never scheduled) and costs nothing.
 */
export const CITATION_CHECK = {
  /** Whole request, connect to last byte. */
  timeoutMs: 8_000,
  /** Largest page body read; a bigger page is not checked. */
  maxBytes: 1_500_000,
  /** Redirect hops followed, each re-checked against the address block list. */
  maxRedirects: 3,
  /** Listings fetched by one "check all" run; the rest wait for the next run. */
  maxPerRun: 10,
  /** Pause between two fetches to the same host in one run. */
  perHostDelayMs: 2_000,
  /** Fetches to different hosts running at once in one run. */
  concurrency: 4,
  /** Wall time for one run; a listing not started when it is spent is left unchecked (counted as remaining). */
  runBudgetMs: 20_000,
  userAgent: "OpenGMB-ListingCheck/1.0 (reads one listing page the owner recorded, to compare name, address and phone)",
} as const;

export type CitationCheckLimits = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxPerRun: number;
  perHostDelayMs: number;
  concurrency: number;
  runBudgetMs: number;
  userAgent: string;
};
