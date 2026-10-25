import { ZONE_LABEL_LOCALE, type DateFormat } from "../config/time-zones";

/** What a formatter needs. The zone is always explicit: never the server's or the browser's. */
export type TimeDisplay = { timeZone: string; dateFormat: DateFormat };

export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
};

const dtf = new Map<string, Intl.DateTimeFormat>();
function parts(timeZone: string): Intl.DateTimeFormat {
  let f = dtf.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    dtf.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toDate = (v: string | number | Date): Date => (v instanceof Date ? v : new Date(v));

/** The wall-clock parts of an instant in a zone. */
export function localParts(v: string | number | Date, timeZone: string): LocalParts {
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${String(v)}`);
  const o: Record<string, string> = {};
  for (const p of parts(timeZone).formatToParts(d)) o[p.type] = p.value;
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: WEEKDAYS.indexOf(o.weekday!),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of the instant's calendar day in the zone (sortable, used as a bucket key). */
export function dayKey(v: string | number | Date, timeZone: string): string {
  const l = localParts(v, timeZone);
  return `${l.year}-${p2(l.month)}-${p2(l.day)}`;
}

export function formatDate(v: string | number | Date, d: TimeDisplay): string {
  return formatDayKey(dayKey(v, d.timeZone), d.dateFormat);
}

/** Re-render a `YYYY-MM-DD` key in a date format. */
export function formatDayKey(key: string, fmt: DateFormat): string {
  const [y, m, day] = key.split("-");
  if (fmt === "DD/MM/YYYY") return `${day}/${m}/${y}`;
  if (fmt === "MM/DD/YYYY") return `${m}/${day}/${y}`;
  return key;
}

/** `HH:mm`, 24 hour. */
export function formatTime(v: string | number | Date, timeZone: string): string {
  const l = localParts(v, timeZone);
  return `${p2(l.hour)}:${p2(l.minute)}`;
}

/** `2026-10-19 05:00` (or `19/10/2026 05:00`), with ` IST` when `label` is set. */
export function formatDateTime(v: string | number | Date, d: TimeDisplay, label = false): string {
  const s = `${formatDate(v, d)} ${formatTime(v, d.timeZone)}`;
  return label ? `${s} ${zoneLabel(d.timeZone, v)}` : s;
}

/** Short zone name at an instant: "IST", "CDT", "AEDT", "BST", "UTC". Falls back to "UTC+5:30". */
export function zoneLabel(timeZone: string, at: string | number | Date = Date.now()): string {
  if (timeZone === "UTC") return "UTC";
  const locale = ZONE_LABEL_LOCALE.find((z) => timeZone.startsWith(z.prefix))?.locale ?? "en-US";
  const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
    .formatToParts(toDate(at))
    .find((p) => p.type === "timeZoneName")?.value;
  if (!name) return timeZone;
  return name.startsWith("GMT") ? name.replace("GMT", "UTC") : name;
}
