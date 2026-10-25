import { z } from "zod";

import { localParts } from "../time/format";
import { wallToUtc } from "../time/wall";

/**
 * Recurrence for a scheduled post. With `timeZone` (the workspace's zone when the series was
 * scheduled) each occurrence keeps the anchor's local wall-clock time, so a post scheduled for 09:00
 * local stays at 09:00 across a daylight-saving change (a time that does not exist that day moves
 * forward by the gap; see wallToUtc). Without it (series created before F4) arithmetic is in UTC and
 * a local time drifts by an hour across a change. Occurrence `n` is computed from the
 * stored `anchor` (the first send), never chained from the previous one, so a monthly series from
 * 31 Jan gives 28 Feb then 31 Mar. `count` is the total number of sends INCLUDING the first;
 * `until` is inclusive. At least one of them is required, so nothing recurs forever.
 */
export const recurrenceInput = z
  .object({
    freq: z.enum(["weekly", "monthly"]),
    interval: z.number().int().min(1).max(52).default(1),
    until: z.iso.datetime({ offset: true }).optional(),
    count: z.number().int().min(2).max(366).optional(),
  })
  .refine((r) => r.until !== undefined || r.count !== undefined, {
    message: "Recurrence needs until or count",
  });

export type Recurrence = {
  freq: "weekly" | "monthly";
  interval: number;
  until?: string;
  count?: number;
  /** ISO time of occurrence 0. */
  anchor: string;
  /** IANA zone the series steps in; unset means UTC. Set by posts.schedule, never by a caller. */
  timeZone?: string;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Occurrence `n` (0 = the anchor). Ignores count and until. */
export function occurrenceAt(rec: Recurrence, n: number): Date {
  const anchor = new Date(rec.anchor);
  if (rec.timeZone && rec.timeZone !== "UTC") return zonedOccurrenceAt(rec, anchor, n, rec.timeZone);
  if (rec.freq === "weekly") return new Date(anchor.getTime() + n * rec.interval * WEEK_MS);
  const months = anchor.getUTCMonth() + n * rec.interval;
  const year = anchor.getUTCFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** Whether occurrence `n` exists (inside count and until). */
export function occurrenceExists(rec: Recurrence, n: number): boolean {
  if (rec.count !== undefined && n >= rec.count) return false;
  if (rec.until !== undefined && occurrenceAt(rec, n).getTime() > Date.parse(rec.until)) {
    return false;
  }
  return true;
}

/**
 * The occurrence after `after`. With `now`, occurrences at or before `now` are skipped (a worker
 * that was down does not flood a location with catch-up posts); `skipped` says how many.
 */
export function nextOccurrence(
  rec: Recurrence,
  after: number,
  now?: Date,
): { index: number; at: Date; skipped: number } | null {
  let skipped = 0;
  for (let n = after + 1; n < after + 100_000; n++) {
    if (!occurrenceExists(rec, n)) return null;
    const at = occurrenceAt(rec, n);
    if (now && at.getTime() <= now.getTime()) {
      skipped++;
      continue;
    }
    return { index: n, at, skipped };
  }
  return null;
}

/** Occurrences from index `from` whose time is in [start, end), at most `max` of them. */
export function expandOccurrences(
  rec: Recurrence,
  from: number,
  window: { start: Date; end: Date },
  max: number,
): { index: number; at: Date }[] {
  const out: { index: number; at: Date }[] = [];
  for (let n = from; out.length < max && occurrenceExists(rec, n); n++) {
    const at = occurrenceAt(rec, n);
    if (at.getTime() >= window.end.getTime()) break;
    if (at.getTime() >= window.start.getTime()) out.push({ index: n, at });
  }
  return out;
}

function zonedOccurrenceAt(rec: Recurrence, anchor: Date, n: number, timeZone: string): Date {
  const a = localParts(anchor, timeZone);
  const ms = anchor.getUTCMilliseconds();
  let y: number;
  let m: number;
  let d: number;
  if (rec.freq === "weekly") {
    const t = new Date(Date.UTC(a.year, a.month - 1, a.day + n * rec.interval * 7));
    y = t.getUTCFullYear();
    m = t.getUTCMonth() + 1;
    d = t.getUTCDate();
  } else {
    const months = a.month - 1 + n * rec.interval;
    y = a.year + Math.floor(months / 12);
    m = (((months % 12) + 12) % 12) + 1;
    d = Math.min(a.day, new Date(Date.UTC(y, m, 0)).getUTCDate());
  }
  return new Date(wallToUtc(y, m, d, a.hour, a.minute, timeZone, a.second).getTime() + ms);
}
