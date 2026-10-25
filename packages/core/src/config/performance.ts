/**
 * Externally-owned numbers for the Business Profile Performance API (PR1-PR3). Logic reads these,
 * never repeats the literals. Re-verify against the source and bump `verifiedOn` when you do.
 */
export const PERFORMANCE_CONFIG = {
  /**
   * How far back Google serves daily metrics, in months. The first snapshot of a location backfills
   * this far.
   * Source: Google Business Profile Help ("Performance data is available for the last 18 months")
   * and the project spec. NOT stated on the Performance API reference pages
   * (https://developers.google.com/my-business/reference/performance/rest, checked 2026-10-12).
   * Confirmed live on 2026-10-18: a backfill of 2025-04-17..2026-10-17 in one call was accepted and
   * returned data for the oldest month.
   */
  retentionMonths: {
    value: 18,
    sourceUrl: "https://support.google.com/business/answer/9918010",
    verifiedOn: "2026-10-18",
  },
  /**
   * The nightly snapshot re-fetches this many most recent complete days (yesterday and the days
   * before it), not just yesterday: Google finalises recent days late, and the upsert is idempotent.
   * Our own choice, not a Google number.
   */
  refreshDays: 3,
  /**
   * monthlyRange pageSize: "defaults to 100 and has a maximum of 100".
   * Source: https://developers.google.com/my-business/reference/performance/rest/v1/locations.searchkeywords.impressions.monthly/list
   */
  keywordsPageSize: {
    value: 100,
    sourceUrl:
      "https://developers.google.com/my-business/reference/performance/rest/v1/locations.searchkeywords.impressions.monthly/list",
    verifiedOn: "2026-10-12",
  },
  /** Our own bound: stop following nextPageToken after this many pages per month. */
  maxKeywordPages: 20,
  /** Nightly snapshot schedule (UTC). */
  snapshotCron: "0 3 * * *",
  /** Monthly report time: the 1st of the month at 09:00 in the client's time zone (minute hour day-of-month); set 2026-10-19, was 14:00 UTC. */
  monthlyReportCron: "0 9 1 * *",
  /** The worker sweeps hourly; a definition is due when its workspace's local time has reached monthlyReportCron. */
  monthlyReportSweepCron: "0 * * * *",
  /** Reports: PDF size cap in bytes (stored as bytea), and the cap for base64 over MCP. */
  reportPdfMaxBytes: 5 * 1024 * 1024,
  reportMcpMaxBytes: 1024 * 1024,
  /** Public report link: default and longest life. A link always expires (legal review Q33c). */
  shareLinkDefaultDays: 7,
  shareLinkMaxDays: 30,
  monthlyEmailLinkDays: 30,
} as const;
