/**
 * H2 monitoring settings. All of these are our own choices, not Google numbers, so there is no
 * source URL: change them here. ALERT_EMAIL (read at send time) is where alert mail goes.
 */
export const MONITORING = {
  /** At most one alert email per distinct error in this window, so an error loop cannot flood the inbox. */
  alertWindowMs: 60 * 60 * 1000,
  /** How often the worker writes its heartbeat and looks for jobs that failed for good. */
  workerTickMs: 60_000,
  /** A heartbeat older than this means the worker is down. Five missed ticks. */
  workerStaleMs: 5 * 60_000,
  /** How often the web server checks the heartbeat. */
  webCheckMs: 60_000,
  /** Distinct errors kept on the System health page. */
  recentErrorsShown: 20,
  /** Days of Google call counts shown. */
  googleUsageDays: 14,
} as const;

/** The address alert mail goes to, or null when none is set (alerts are then only logged). */
export function alertEmail(env: Record<string, string | undefined> = process.env): string | null {
  return env.ALERT_EMAIL?.trim() || null;
}
