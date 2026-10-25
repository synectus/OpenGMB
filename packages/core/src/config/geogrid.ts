/**
 * Geo-grid numbers that are not ours to choose. Each external fact carries its source and the date
 * it was checked. Logic reads these; it never holds a literal price.
 */
export const GEOGRID_PRICING = {
  dataforseo_standard: {
    /** USD per task (one grid point x one keyword, up to 100 results, Standard queue). */
    perTaskUsd: 0.0006,
    sourceUrl: "https://dataforseo.com/pricing/serp/google-maps-serp-api",
    verifiedOn: "2026-10-12",
    status: "verified" as const,
    note: "Read from the public pricing page on 2026-10-12 (page text summarised by a fetch tool, not eyeballed). Depth above 100 multiplies; we request depth 20, so one unit per task.",
  },
  dataforseo_serp: {
    /** USD per SERP page (10 results), Standard queue. A keyword-rank task asks for GEOGRID_SERP.depth results, so it buys depth / 10 pages. */
    perTaskUsd: 0.0006,
    sourceUrl: "https://dataforseo.com/pricing/serp/google-organic-serp-api",
    verifiedOn: "2026-10-24",
    status: "verified" as const,
    note: "Google Organic SERP API: Standard $0.0006, Priority $0.0012 per SERP of 10 results; each extra 10 results adds one SERP (pricing page, 2026-10-24).",
  },
  places_relevance: {
    /** Places API (New) Text Search, Essentials, IDs-only field mask: no charge. */
    perTaskUsd: 0,
    sourceUrl: "https://developers.google.com/maps/billing-and-pricing/pricing",
    verifiedOn: "2026-10-24",
    status: "verified" as const,
    note: "Text Search Essentials (IDs Only): unlimited free usage (pricing page)",
  },
} as const;

/**
 * Scan speed on DataForSEO runs (Maps rank). "fast" is the same task_post with `priority: 2`; the
 * price and typical wait are DataForSEO's, read from the pricing page and task_post docs. A later
 * "instant" speed (Live endpoint) is a separate follow-up and is deliberately not listed here.
 */
export const GEOGRID_SPEEDS = {
  standard: {
    /** USD per task, Standard queue (same figure as GEOGRID_PRICING.dataforseo_standard). */
    perTaskUsd: GEOGRID_PRICING.dataforseo_standard.perTaskUsd,
    /** task_post `priority` value; 1 is the default, so it is never sent. */
    priority: 1,
    typicalMinutes: 5,
    sourceUrl: "https://dataforseo.com/pricing/serp/google-maps-serp-api",
    verifiedOn: "2026-10-24",
    status: "verified" as const,
    note: "Standard queue: $0.0006 per SERP, about 5 minutes on average (pricing page, 2026-10-24).",
  },
  fast: {
    perTaskUsd: 0.0012,
    /** task_post docs: priority 1 = normal (default), 2 = high, "you will be additionally charged". */
    priority: 2,
    typicalMinutes: 1,
    sourceUrl: "https://dataforseo.com/pricing/serp/google-maps-serp-api",
    priorityFieldSourceUrl: "https://docs.dataforseo.com/v3/serp/google/maps/task_post/",
    verifiedOn: "2026-10-24",
    status: "verified" as const,
    note: "Priority queue: $0.0012 per SERP, up to 1 minute on average (pricing page, 2026-10-24). Sent as task_post priority: 2.",
  },
} as const;
/**
 * Keyword rank (K4): DataForSEO SERP Google Organic. Same queue speeds and per-page prices as Maps
 * (GEOGRID_SPEEDS); one task buys `pages` SERP pages. Docs: https://docs.dataforseo.com/v3/serp/google/organic/task_post/
 * (verified 2026-10-24): depth is billed per 10 results; location_coordinate is "latitude,longitude,radius".
 */
export const GEOGRID_SERP = {
  depth: 20,
  pages: 2,
  /** Sent after the coordinates. The docs example is 200 and say the range is 199 to 199999; the unit is not stated clearly, so the docs example is used. */
  coordinateRadius: 200,
  device: "mobile",
  sourceUrl: "https://docs.dataforseo.com/v3/serp/google/organic/task_post/",
  verifiedOn: "2026-10-24",
} as const;

export const GRID_SPEEDS = ["standard", "fast"] as const;
export type GridSpeed = (typeof GRID_SPEEDS)[number];
export const DEFAULT_GRID_SPEED: GridSpeed = "standard";

/** USD per task. Speed only changes DataForSEO sources; the relevance check is free at any speed. */
export function taskPriceUsd(driverId: keyof typeof GEOGRID_PRICING, speed: GridSpeed = DEFAULT_GRID_SPEED): number {
  if (driverId === "dataforseo_standard") return GEOGRID_SPEEDS[speed].perTaskUsd;
  if (driverId === "dataforseo_serp") return GEOGRID_SPEEDS[speed].perTaskUsd * GEOGRID_SERP.pages;
  return GEOGRID_PRICING[driverId].perTaskUsd;
}

/** DataForSEO hosts and paths (https://docs.dataforseo.com/v3/serp/google/maps/task_post/, verified 2026-10-24). */
export const DATAFORSEO_ENDPOINTS = {
  hosts: ["https://api.dataforseo.com", "https://sandbox.dataforseo.com"] as const,
  taskPost: "/v3/serp/google/maps/task_post",
  taskGet: "/v3/serp/google/maps/task_get/advanced/", // + task id
  /** Keyword rank (K4), verified 2026-10-24: https://docs.dataforseo.com/v3/serp/google/organic/task_post/ and .../organic/task_get/advanced/ */
  serpTaskPost: "/v3/serp/google/organic/task_post",
  serpTaskGet: "/v3/serp/google/organic/task_get/advanced/", // + task id
  userData: "/v3/appendix/user_data",
  maxTasksPerPost: 100,
  maxTagChars: 255,
  sourceUrl: "https://docs.dataforseo.com/v3/serp/google/maps/task_post/",
  verifiedOn: "2026-10-24",
} as const;

/** https://docs.dataforseo.com/v3/appendix/errors/, verified 2026-10-24. */
export const DFS_ERROR_CLASSES = {
  account: [40100, 40104, 40200, 40201, 40203, 40207, 40210],
  retryable: [40202, 40209, 50000, 50301, 50303, 50401],
  notReady: [40601, 40602],
  sourceUrl: "https://docs.dataforseo.com/v3/appendix/errors/",
  verifiedOn: "2026-10-24",
} as const;

/** Our choice (D1), not an external fact: DataForSEO cost on OUR key per UTC day, all orgs. */
export const GEOGRID_PLATFORM_CAP = {
  dailyUsd: 5,
  decidedBy: "project owner",
  decidedOn: "2026-10-24",
} as const;

/** Our own product choices. */
export const GEOGRID_DEFAULTS = {
  /** Resale markup on the driver cost. OpenSEO reference, our choice. */
  markupPercent: 28,
  /** Monthly spend cap per org until an owner/admin changes it. Our choice. */
  monthlyBudgetUsd: 25,
  /** Results requested and stored per point. */
  depth: 20,
  /** A target not found in the top `depth` counts as depth + 1 in average rank. */
  notFoundRank: 21,
  maxKeywordsPerConfig: 5,
  /** Keywords one location can track for keyword rank (K4). Our choice; each is one search per check. */
  maxRankKeywords: 25,
  minRadiusM: 100,
  maxRadiusM: 50_000,
  /** DataForSEO Maps `location_coordinate` zoom: at 15 one search covers ~2 km, so a 9x9 / 5 km grid found the business at 3 of 81 points (run 4a808c4c, 2026-10-24); 13 covers ~8 km. */
  mapsZoom: 13,
  /** Sent as `search_this_area`; DataForSEO defaults it to true, which restricts results to the zoom viewport, unlike a person typing a search in the Maps app (https://docs.dataforseo.com/v3/serp/google/maps/task_post/). */
  mapsSearchThisArea: false,
  /**
   * A submitted task with no pingback and no result after this long is fetched anyway (a pingback
   * can be lost). Our choice; DataForSEO's Standard-queue target is 45 minutes (pricing page).
   */
  staleTaskAfterMs: 15 * 60 * 1000,
  /** After this long a still-empty task is failed ("no_result"), so the run can settle. Our choice. */
  giveUpTaskAfterMs: 3 * 60 * 60 * 1000,
  /** A due schedule is tolerated this early (ms), so a daily cron jitter never skips a day. */
  scheduleToleranceMs: 60 * 60 * 1000,
} as const;

export const GEOGRID_DRIVER_LABELS = {
  /** No queue named: the queue is per run (see the run's speed), not per data source. */
  dataforseo_standard: "DataForSEO Google Maps",
  places_relevance: "Relevance check (not Maps rank)",
  dataforseo_serp: "DataForSEO Google Search",
} as const;

/** Every 10 minutes: fetch results for submitted tasks whose pingback never arrived. */
export const GRID_SWEEP_CRON = "*/10 * * * *";
