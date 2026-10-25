// The one place the web app turns an instant into text. Client-safe (imports only @opengmb/core/time).
// The server builds it with getTimeFormat() (lib/time-format-server.ts); client components read it
// from <TimeFormatProvider> (components/time-format-provider.tsx). Both use makeTimeFormat, and
// always pass an explicit zone, never the server's or the browser's.
import {
  dayKey as coreDayKey,
  formatDate,
  formatDateTime,
  formatDayKey,
  formatTime,
  zoneLabel,
  type DateFormat,
} from "@opengmb/core/time";
import { UNKNOWN_DATE, isMissingTimestamp } from "./labels";

export type ZoneInfo = { id: string; timeZone: string; dateFormat: DateFormat };

/** Plain data, so a server component can pass it to the client provider. */
export type TimeFormatData = {
  zones: ZoneInfo[];
  /** The one client the page works in, or null under All clients. */
  workspaceId: string | null;
};

const FALLBACK = { timeZone: "UTC", dateFormat: "YYYY-MM-DD" as DateFormat };

export type TimeFormat = ReturnType<typeof makeTimeFormat>;

/**
 * `ws` is the workspace a row belongs to. Zone choice: the row's workspace, else the page's client,
 * else the org's zone when all clients share it, else UTC (shown with its label).
 * `mixed` is true when clients in scope differ in zone: times then carry a short label ("10:30 IST").
 */
export function makeTimeFormat(data: TimeFormatData) {
  const byId = new Map(data.zones.map((z) => [z.id, z]));
  const pageZone = data.workspaceId ? byId.get(data.workspaceId) : undefined;
  const distinct = new Set(data.zones.map((z) => z.timeZone));
  const distinctFormats = new Set(data.zones.map((z) => z.dateFormat));
  const mixed = !pageZone && distinct.size > 1;
  const shared =
    !pageZone && data.zones.length > 0 && distinct.size === 1 && distinctFormats.size === 1
      ? data.zones[0]
      : undefined;

  const pick = (ws?: string | null): { timeZone: string; dateFormat: DateFormat } =>
    (ws ? byId.get(ws) : undefined) ?? pageZone ?? shared ?? FALLBACK;
  const labelled = mixed;

  return {
    mixed,
    /** The zone a row is shown in. */
    zone: (ws?: string | null) => pick(ws).timeZone,
    dateFormat: (ws?: string | null) => pick(ws).dateFormat,
    /** "2026-10-19 05:00", or "2026-10-19 05:00 IST" when clients differ in zone. */
    dateTime: (iso: string | number | Date, ws?: string | null) =>
      isMissingTimestamp(iso) ? UNKNOWN_DATE : formatDateTime(iso, pick(ws), labelled),
    /** The date alone, in the client's date format. */
    date: (iso: string | number | Date, ws?: string | null) =>
      isMissingTimestamp(iso) ? UNKNOWN_DATE : formatDate(iso, pick(ws)),
    /** "05:00", or "05:00 IST" when clients differ in zone. */
    time: (iso: string | number | Date, ws?: string | null) =>
      isMissingTimestamp(iso)
        ? UNKNOWN_DATE
        : `${formatTime(iso, pick(ws).timeZone)}${labelled ? ` ${zoneLabel(pick(ws).timeZone, iso)}` : ""}`,
    /** `YYYY-MM-DD` of the instant's day in the client's zone: a sortable key, not for display. */
    dayKey: (iso: string | number | Date, ws?: string | null) => coreDayKey(iso, pick(ws).timeZone),
    /** Today's `YYYY-MM-DD` in the client's zone. */
    today: (ws?: string | null) => coreDayKey(Date.now(), pick(ws).timeZone),
    /** A `YYYY-MM-DD` key in the client's date format. */
    day: (key: string, ws?: string | null) => formatDayKey(key, pick(ws).dateFormat),
    /** The short zone name ("IST") for a note, for example "Times are shown in IST". */
    label: (ws?: string | null, at: string | number | Date = Date.now()) => zoneLabel(pick(ws).timeZone, at),
  };
}
