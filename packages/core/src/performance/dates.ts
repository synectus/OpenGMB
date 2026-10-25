/** UTC calendar-day helpers for the performance snapshots and reports. All dates are `YYYY-MM-DD`. */

const DAY_MS = 86_400_000;

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const parse = (s: string): Date => new Date(`${s}T00:00:00Z`);

export function isYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parse(s);
  return !Number.isNaN(d.getTime()) && ymd(d) === s;
}

export function addDays(day: string, n: number): string {
  return ymd(new Date(parse(day).getTime() + n * DAY_MS));
}

/** Inclusive number of days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / DAY_MS) + 1;
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function today(now: Date): string {
  return ymd(now);
}

export function yesterday(now: Date): string {
  return addDays(ymd(now), -1);
}

/** `YYYY-MM` of a day. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** `YYYY-MM` shifted by `n` months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Months `from`..`to` inclusive (`YYYY-MM`). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export const monthStart = (month: string): string => `${month}-01`;
export const monthEnd = (month: string): string => addDays(monthStart(addMonths(month, 1)), -1);

/** The calendar month before the one `now` falls in: the newest month with complete keyword data. */
export function lastCompleteMonth(now: Date): string {
  return addMonths(monthOf(ymd(now)), -1);
}

/** The same calendar day `n` months earlier, clamped to the end of a shorter month. */
export function subtractMonths(day: string, n: number): string {
  const target = addMonths(monthOf(day), -n);
  const dd = Number(day.slice(8, 10));
  const last = Number(monthEnd(target).slice(8, 10));
  return `${target}-${String(Math.min(dd, last)).padStart(2, "0")}`;
}

export type DayRange = { from: string; to: string };

/** The previous calendar month. */
export function lastMonthRange(now: Date): DayRange {
  const m = lastCompleteMonth(now);
  return { from: monthStart(m), to: monthEnd(m) };
}

/** The 30 complete days ending yesterday. */
export function last30DaysRange(now: Date): DayRange {
  const to = yesterday(now);
  return { from: addDays(to, -29), to };
}

/** The range of equal length immediately before `range`. */
export function previousRange(range: DayRange): DayRange {
  const n = daysBetween(range.from, range.to);
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
}
