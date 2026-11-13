// packages/core/src/location-pages/pure.ts
import { GOOGLE_DAYS } from "../google/client";

export const PAGE_MAX_REVIEWS = 4;
export const PAGE_MAX_POSTS = 3;
export const PAGE_MAX_SERVICES = 20;
export const PAGE_MAX_PHOTOS = 12;
export const PAGE_MAX_TEXT = 280;

export type HoursRow = { day: string; text: string };

const DAY_LABEL: Record<string, string> = {
  MONDAY: "Monday", TUESDAY: "Tuesday", WEDNESDAY: "Wednesday", THURSDAY: "Thursday",
  FRIDAY: "Friday", SATURDAY: "Saturday", SUNDAY: "Sunday",
};

type Tod = { hours?: number; minutes?: number } | undefined;
type Period = { openDay: string; openTime?: Tod; closeDay?: string; closeTime?: Tod };
const DAY_MIN = 1440;
/** Google omits zero fields, so `{}` is 00:00 and `{ hours: 24 }` is 24:00. */
const minutes = (t: Tod) => (t?.hours ?? 0) * 60 + (t?.minutes ?? 0);
function clock(m: number): string {
  const h = Math.floor((m % DAY_MIN) / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** One opening window on a day. `end` counts minutes from that day's midnight and runs past 1440 when it ends on a later day. */
type Win = { start: number; end: number; all?: boolean };
const isAllDay = (w: Win) => w.all === true;

/**
 * Opening windows per day (index 0 = Monday). Google splits an overnight shift at midnight, so a window that
 * ends at midnight and one that starts at 00:00 the next day (Sunday wraps to Monday) become one window on the first day.
 */
function weekWindows(regularHours: unknown): Win[][] {
  const periods = ((regularHours as { periods?: Period[] } | null)?.periods ?? []);
  const week = GOOGLE_DAYS.filter((d) => d in DAY_LABEL) as string[];
  const days: Win[][] = week.map(() => []);
  for (const p of periods) {
    const i = week.indexOf(p.openDay);
    if (i < 0) continue;
    const start = minutes(p.openTime);
    const gap = p.closeDay && week.includes(p.closeDay) ? (week.indexOf(p.closeDay) - i + 7) % 7 : 0;
    let end = minutes(p.closeTime) + DAY_MIN * gap;
    if (end === start) {
      days[i]!.push({ start: 0, end: DAY_MIN, all: true });
      continue;
    }
    if (end < start) end += DAY_MIN;
    // A period that runs past midnight is cut into one piece per day; the merge pass below joins the pieces that continue a shift.
    for (let cur = start, n = 0; cur < end && n < 8; n++) {
      const d = Math.floor(cur / DAY_MIN);
      const pieceEnd = Math.min(end, (d + 1) * DAY_MIN);
      const w: Win = { start: cur - d * DAY_MIN, end: pieceEnd - d * DAY_MIN };
      if (w.start === 0 && w.end === DAY_MIN) w.all = true;
      days[(i + d) % 7]!.push(w);
      cur = pieceEnd;
    }
  }
  for (let i = 0; i < 7; i++) {
    for (const w of days[i]!) {
      if (isAllDay(w) || w.end % DAY_MIN !== 0) continue;
      const next = (i + w.end / DAY_MIN) % 7;
      const j = days[next]!.findIndex((n) => n !== w && n.start === 0 && !isAllDay(n) && n.end <= DAY_MIN && w.end + n.end - w.start < DAY_MIN);
      if (j < 0) continue;
      w.end += days[next]![j]!.end;
      days[next]!.splice(j, 1);
    }
  }
  for (const d of days) d.sort((a, b) => a.start - b.start);
  return days;
}

/** Monday to Sunday, one row each. A day without a period reads "Closed"; a 24-hour day reads "Open 24 hours". */
export function hoursRows(regularHours: unknown): HoursRow[] {
  const periods = ((regularHours as { periods?: unknown[] } | null)?.periods ?? []);
  if (periods.length === 0) return [];
  const week = GOOGLE_DAYS.filter((d) => d in DAY_LABEL);
  const days = weekWindows(regularHours);
  return week.map((d, i) => ({
    day: DAY_LABEL[d]!,
    text: days[i]!.length === 0
      ? "Closed"
      : days[i]!.map((w) => (isAllDay(w) ? "Open 24 hours" : `${clock(w.start)} to ${clock(w.end)}`)).join(", "),
  }));
}

/** `categories/gcid:physical_therapist` becomes "Physical therapist". Anything else is shown as given. */
export function categoryLabel(name: string): string {
  const raw = name.replace(/^categories\//, "").replace(/^gcid:/, "").replace(/_/g, " ").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : name;
}

export function mapsUrl(name: string, address: string | null): string {
  const q = [name, address].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Only https links are ever rendered as links or images on the public page. */
export function httpsOnly(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password ? x.toString() : null;
  } catch {
    return null;
  }
}

export type PageData = {
  slug: string;
  name: string;
  description: string | null;
  categories: string[];
  address: string | null;
  mapUrl: string;
  phone: string | null;
  website: string | null;
  hours: HoursRow[];
  services: string[];
  rating: number | null;
  reviewCount: number;
  reviewNote: string | null;
  reviews: { rating: number; text: string; name: string }[];
  posts: { summary: string; imageUrl: string | null; linkUrl: string | null }[];
  photos: { url: string; alt: string }[];
  brand: { agencyName: string; logoUrl: string | null; primaryColor: string | null };
};

const DAY_SCHEMA: Record<string, string> = Object.fromEntries(Object.entries(DAY_LABEL).map(([k, v]) => [k, `https://schema.org/${v}`]));
const hhmm = (m: number) => {
  const t = m === DAY_MIN ? m : m % DAY_MIN;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** schema.org LocalBusiness for the page. Only fields we hold; empty ones are left out. */
export function localBusinessJsonLd(d: PageData, pageUrl: string, regularHours: unknown): Record<string, unknown> {
  const week = weekWindows(regularHours);
  const out: Record<string, unknown> = { "@context": "https://schema.org", "@type": "LocalBusiness", "@id": `${pageUrl}#business`, name: d.name, url: pageUrl };
  if (d.description) out.description = d.description;
  if (d.address) out.address = d.address;
  if (d.phone) out.telephone = d.phone;
  if (d.website) out.sameAs = [d.website];
  const specs = GOOGLE_DAYS.flatMap((day, i) =>
    DAY_SCHEMA[day] ? week[i]!.map((w) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_SCHEMA[day], opens: hhmm(w.start), closes: hhmm(w.end) })) : [],
  );
  if (specs.length) out.openingHoursSpecification = specs;
  if (d.rating !== null && d.reviewCount > 0) {
    out.aggregateRating = { "@type": "AggregateRating", ratingValue: d.rating, reviewCount: d.reviewCount, bestRating: 5, worstRating: 1 };
  }
  return out;
}

/** JSON for an inline <script type="application/ld+json">: "<" is escaped so the data can never close the tag. */
export const safeJsonLd = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
