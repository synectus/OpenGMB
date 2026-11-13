/**
 * SEO suite (SEO0 epic). External prices carry their source URL and the date they were read; logic never
 * holds a price literal. Our own choices are marked as such.
 */
export const SEO_PRICES = {
  labs: {
    /** DataForSEO Labs (Google), Live only: $0.012 per task + $0.00012 per returned item. */
    perTaskUsd: 0.012,
    perRowUsd: 0.00012,
    sourceUrl: "https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api",
    verifiedOn: "2026-11-12",
  },
  googleAdsLive: {
    /** Keywords Data, Google Ads, Live: $0.09 per task, up to 1,000 keywords per task. */
    perTaskUsd: 0.09,
    maxKeywordsPerTask: 1000,
    /** "no more than 12 requests per minute per account using Google Ads Live endpoints" (docs). */
    perMinutePerAccount: 12,
    sourceUrl: "https://dataforseo.com/pricing/keywords-data/google-ads",
    docsUrl: "https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/",
    verifiedOn: "2026-11-12",
  },
} as const;

export const SEO_ENDPOINTS = {
  labsSuggestions: "/v3/dataforseo_labs/google/keyword_suggestions/live",
  labsIdeas: "/v3/dataforseo_labs/google/keyword_ideas/live",
  adsSearchVolume: "/v3/keywords_data/google_ads/search_volume/live",
  /** + lowercase ISO country code; free (Task 0 feasibility). */
  adsLocations: "/v3/keywords_data/google_ads/locations/",
  docsUrl: "https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/",
  /** The date the four docs pages were read (SEO1 Task 0). */
  verifiedOn: "2026-11-13",
} as const;

/** Per provider call; the stale-run age below is derived from it. */
const PROVIDER_TIMEOUT_MS = 60_000;
/** The job waits at most this long for the next minute when the Ads allowance is full (a minute plus a margin). */
const ADS_SLOT_WAIT_MS = 61_000;

/** Our own choices. */
export const SEO_KEYWORDS = {
  defaultRows: 150,
  minRows: 20,
  maxRows: 300,
  /** A repeat of the same query inside this window reopens the stored result at $0. */
  cacheDays: 7,
  /** Platform-wide Google Ads Live calls per minute; under DataForSEO's 12. */
  adsCallsPerMinute: 10,
  /** Geotarget list refresh age, and the location types offered in the city picker. */
  registryMaxAgeDays: 30,
  cityTypes: ["City", "County", "Municipality", "DMA Region", "Region"],
  languageCode: "en",
  timeoutMs: PROVIDER_TIMEOUT_MS,
  /**
   * A run left `running` longer than this is claimed again by the job: the longest a live job can take is the three
   * provider calls (two Labs calls at once, then one Ads call), each up to timeoutMs, plus the 61 s wait for an Ads slot.
   */
  staleRunningMs: 3 * PROVIDER_TIMEOUT_MS + ADS_SLOT_WAIT_MS,
  /** The sweep fails a run still `queued` after this long (pg-boss gave up or the worker was down). */
  sweepQueuedAfterMs: 2 * 3_600_000,
  /** The sweep fails a run still `running` after this long (the job died while settling). */
  sweepRunningAfterMs: 30 * 60_000,
  /** Sweep schedule (UTC cron, every 10 minutes). */
  sweepCron: "*/10 * * * *",
} as const;
