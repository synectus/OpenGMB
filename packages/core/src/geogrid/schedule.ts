import { GEOGRID_DEFAULTS } from "../config/geogrid";

export type GridSchedule = "manual" | "daily" | "weekly" | "monthly";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The next time a config last scheduled at `last` is due; null for manual configs. */
export function nextDueAt(schedule: GridSchedule, last: Date): Date | null {
  switch (schedule) {
    case "manual":
      return null;
    case "daily":
      return new Date(last.getTime() + DAY_MS);
    case "weekly":
      return new Date(last.getTime() + 7 * DAY_MS);
    case "monthly": {
      const d = new Date(last.getTime());
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    }
  }
}

/**
 * Due when never scheduled, or when the next due time is at most `scheduleToleranceMs` away
 * (so a cron that fires a few minutes early never skips a period).
 */
export function isDue(schedule: GridSchedule, last: Date | null, now: Date): boolean {
  if (schedule === "manual") return false;
  if (!last) return true;
  const next = nextDueAt(schedule, last)!;
  return now.getTime() >= next.getTime() - GEOGRID_DEFAULTS.scheduleToleranceMs;
}

/** Hour (UTC) of the daily schedule job. Must match GRID_SCHEDULE_CRON in run.ts (a test pins it). */
export const GRID_SCHEDULE_HOUR_UTC = 5;

/**
 * When the schedule job will next enqueue this config: the first daily tick at or after the time
 * it becomes due (`nextDueAt - scheduleToleranceMs`, as `isDue` decides), or after `now` when it
 * is already due. Null for manual configs.
 */
export function nextScheduledRunAt(
  schedule: GridSchedule,
  last: Date | null,
  now: Date,
): Date | null {
  if (schedule === "manual") return null;
  const due = last
    ? nextDueAt(schedule, last)!.getTime() - GEOGRID_DEFAULTS.scheduleToleranceMs
    : now.getTime();
  const from = new Date(Math.max(due, now.getTime()));
  const tick = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), GRID_SCHEDULE_HOUR_UTC),
  );
  if (tick.getTime() < from.getTime()) tick.setUTCDate(tick.getUTCDate() + 1);
  return tick;
}
