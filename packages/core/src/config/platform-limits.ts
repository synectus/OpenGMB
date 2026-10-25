import { AI_DEFAULTS } from "./ai-models";
import { GEOGRID_PLATFORM_CAP } from "./geogrid";
import { intFromEnv } from "../limits/window";

/**
 * OPS1 platform limits. The two editable ones (Settings > Integrations) are stored in
 * the platform settings; the database value wins, then the environment value, then the default here.
 * Everything else below is our own choice (not an external number), changeable by environment value.
 */
export const PLATFORM_LIMIT_KEYS = ["ai_monthly_budget_usd", "dfs_daily_cap_usd", "dfs_balance_alert_usd"] as const;
export type PlatformLimitKey = (typeof PLATFORM_LIMIT_KEYS)[number];

export const PLATFORM_LIMITS: Record<
  PlatformLimitKey,
  { env: string; default: number; max: number; unit: "month" | "day" | "balance" }
> = {
  ai_monthly_budget_usd: { env: "AI_MONTHLY_BUDGET_USD", default: AI_DEFAULTS.platformMonthlyBudgetUsd, max: 100_000, unit: "month" },
  dfs_daily_cap_usd: { env: "DFS_PLATFORM_DAILY_CAP_USD", default: GEOGRID_PLATFORM_CAP.dailyUsd, max: 100_000, unit: "day" },
  /** Alert when the DataForSEO account balance falls below this many USD. */
  dfs_balance_alert_usd: { env: "DFS_BALANCE_ALERT_USD", default: 20, max: 100_000, unit: "balance" },
};

/** Share of a cap that raises the first alert. */
export const LIMIT_ALERTS = {
  warnFraction: 0.8,
  /** Counts as 100%: spend within this share of the cap, because the guard refuses at spent plus a worst-case call and spend can stall just under it. */
  fullFraction: 0.99,
} as const;

/** Per-hour event counts that raise one alert per hour. */
export function eventAlertLimits(env: Record<string, string | undefined> = process.env) {
  return {
    googleOrgLimitedPerHour: intFromEnv("ALERT_GOOGLE_ORG_LIMIT_PER_HOUR", 20, env),
    emailFailuresPerHour: intFromEnv("ALERT_EMAIL_FAILURES_PER_HOUR", 5, env),
  };
}

/** DataForSEO account data endpoint: GET, balance at tasks[0].result[0].money.balance. */
export const DFS_USER_DATA = {
  path: "/v3/appendix/user_data",
  sourceUrl: "https://docs.dataforseo.com/v3/appendix/user_data/",
  verifiedOn: "2026-10-25",
} as const;

/**
 * Per-account (organization) actions per UTC day for free-to-us actions that draw on a shared quota.
 * Our own conservative choices, high above normal use.
 */
export const ACCOUNT_DAILY_KINDS = ["relevance_points", "stock_search", "citation_check", "google_sync"] as const;
export type AccountDailyKind = (typeof ACCOUNT_DAILY_KINDS)[number];

export function accountDailyCaps(env: Record<string, string | undefined> = process.env): Record<AccountDailyKind, number> {
  return {
    /** Grid points (points x keywords) of manual Places relevance scans. */
    relevance_points: intFromEnv("ACCOUNT_DAILY_RELEVANCE_POINTS", 5000, env),
    /** Pixabay searches that reached Pixabay (cache hits are free). */
    stock_search: intFromEnv("ACCOUNT_DAILY_STOCK_SEARCHES", 300, env),
    /** Citation listing pages fetched. */
    citation_check: intFromEnv("ACCOUNT_DAILY_CITATION_CHECKS", 300, env),
    /** Manual Google review or post syncs. */
    google_sync: intFromEnv("ACCOUNT_DAILY_GOOGLE_SYNCS", 100, env),
  };
}

export const ACCOUNT_DAILY_LABELS: Record<AccountDailyKind, string> = {
  relevance_points: "relevance-check scans",
  stock_search: "stock photo searches",
  citation_check: "citation checks",
  google_sync: "manual Google syncs",
};

/** Sign-ups from one IP per hour (production). */
export const signupPerIpPerHour = (env: Record<string, string | undefined> = process.env) =>
  intFromEnv("AUTH_SIGNUP_PER_IP_PER_HOUR", 20, env);
