import { localParts } from "./format";

/** Offset of the zone from UTC at an instant, in ms (positive east of Greenwich). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const l = localParts(ms, timeZone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const DAY = 86_400_000;

/**
 * The UTC instant of a wall-clock time in a zone. `year`/`month` (1-12)/`day` may overflow; they
 * are normalised like Date.UTC. Rules at daylight-saving changes: a time that does not exist (the
 * clock skips it) moves forward by the length of the gap; a time that happens twice takes the first.
 */
export function wallToUtc(
  y: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
  second = 0,
): Date {
  const guess = Date.UTC(y, month - 1, day, hour, minute, second);
  const before = zoneOffsetMs(guess - DAY, timeZone);
  const after = zoneOffsetMs(guess + DAY, timeZone);
  const valid = [before, after]
    .map((o) => ({ o, t: guess - o }))
    .filter(({ o, t }) => zoneOffsetMs(t, timeZone) === o)
    .map(({ t }) => t);
  if (valid.length) return new Date(Math.min(...valid));
  return new Date(guess - before);
}

/** "2026-10-19T09:00" (a datetime-local value) or "2026-10-19 09:00" read in the zone. Null when malformed. */
export function zonedWallToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59) return null;
  return wallToUtc(y!, mo!, d!, h!, mi!, timeZone, s ?? 0);
}

/** The instant a calendar day (`YYYY-MM-DD`) starts in the zone. */
export function startOfZonedDay(key: string, timeZone: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return wallToUtc(y, m, d, 0, 0, timeZone);
}

/** Inverse of zonedWallToUtc for a datetime-local input: "2026-10-19T09:00". */
export function utcToWall(v: string | number | Date, timeZone: string): string {
  const l = localParts(v, timeZone);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${l.year}-${p(l.month)}-${p(l.day)}T${p(l.hour)}:${p(l.minute)}`;
}
