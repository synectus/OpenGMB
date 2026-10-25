import type { GoogleTimeOfDay, GoogleTimePeriod } from "../google/client";

const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

import { localParts } from "../time/format";

/**
 * Google's day name for `now` in a time zone: the workspace's, since locations store no zone of
 * their own (F4: at 10:30 IST on a Monday it is still Sunday in UTC).
 */
export const zonedDay = (now: Date, timeZone: string) => DAYS[localParts(now, timeZone).weekday]!;

const toMinutes = (t: GoogleTimeOfDay) => (t.hours ?? 0) * 60 + (t.minutes ?? 0);
const WEEK = 7 * 24 * 60;

/**
 * Whether regular hours put `now` inside an opening period, reading the clock in `timeZone`.
 * Periods may cross midnight (closeDay after openDay), run to 24:00, or wrap Saturday to Sunday.
 * Null when no hours are set. Special hours (holidays) are not considered.
 */
export function isOpenNow(periods: GoogleTimePeriod[], now: Date, timeZone: string): boolean | null {
  if (!periods.length) return null;
  const l = localParts(now, timeZone);
  const t = l.weekday * 1440 + l.hour * 60 + l.minute;
  return periods.some((x) => {
    const od = DAYS.indexOf(x.openDay as (typeof DAYS)[number]);
    const cd = DAYS.indexOf(x.closeDay as (typeof DAYS)[number]);
    if (od < 0 || cd < 0) return false;
    const open = od * 1440 + toMinutes(x.openTime);
    let close = cd * 1440 + toMinutes(x.closeTime);
    if (close <= open) close += WEEK;
    return (t >= open && t < close) || (t + WEEK >= open && t + WEEK < close);
  });
}

const hhmm = (t: GoogleTimeOfDay) =>
  `${String(t.hours ?? 0).padStart(2, "0")}:${String(t.minutes ?? 0).padStart(2, "0")}`;

/** "08:00 to 12:00, 14:00 to 18:00" for the periods that open on `day`, or null when none do. */
export function hoursOn(periods: GoogleTimePeriod[], day: string): string | null {
  const today = periods
    .filter((x) => x.openDay === day)
    .sort((a, b) => hhmm(a.openTime).localeCompare(hhmm(b.openTime)));
  return today.length ? today.map((x) => `${hhmm(x.openTime)} to ${hhmm(x.closeTime)}`).join(", ") : null;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
