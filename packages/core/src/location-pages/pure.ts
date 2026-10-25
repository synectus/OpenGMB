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
function clock(t: Tod): string {
  const h = t?.hours ?? 0;
  const m = t?.minutes ?? 0;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h % 24 >= 12 ? "PM" : "AM"}`;
}

/** Monday to Sunday, one row each. A day without a period reads "Closed"; a 24-hour day reads "Open 24 hours". */
export function hoursRows(regularHours: unknown): HoursRow[] {
  const periods = ((regularHours as { periods?: unknown[] } | null)?.periods ?? []) as {
    openDay: string; openTime?: Tod; closeDay: string; closeTime?: Tod;
  }[];
  if (periods.length === 0) return [];
  const week = GOOGLE_DAYS.filter((d) => d in DAY_LABEL);
  return week.map((d) => {
    const mine = periods.filter((p) => p.openDay === d);
    const text = mine.length === 0
      ? "Closed"
      : mine
          .map((p) => {
            const o = clock(p.openTime);
            const c = clock(p.closeTime);
            return o === c ? "Open 24 hours" : `${o} to ${c}`;
          })
          .join(", ");
    return { day: DAY_LABEL[d]!, text };
  });
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
const hhmm = (t: Tod) => `${String(t?.hours ?? 0).padStart(2, "0")}:${String(t?.minutes ?? 0).padStart(2, "0")}`;

/** schema.org LocalBusiness for the page. Only fields we hold; empty ones are left out. */
export function localBusinessJsonLd(d: PageData, pageUrl: string, regularHours: unknown): Record<string, unknown> {
  const periods = ((regularHours as { periods?: unknown[] } | null)?.periods ?? []) as {
    openDay: string; openTime?: Tod; closeTime?: Tod;
  }[];
  const out: Record<string, unknown> = { "@context": "https://schema.org", "@type": "LocalBusiness", "@id": `${pageUrl}#business`, name: d.name, url: pageUrl };
  if (d.description) out.description = d.description;
  if (d.address) out.address = d.address;
  if (d.phone) out.telephone = d.phone;
  if (d.website) out.sameAs = [d.website];
  if (periods.length) {
    out.openingHoursSpecification = periods
      .filter((p) => DAY_SCHEMA[p.openDay])
      .map((p) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_SCHEMA[p.openDay], opens: hhmm(p.openTime), closes: hhmm(p.closeTime) }));
  }
  if (d.rating !== null && d.reviewCount > 0) {
    out.aggregateRating = { "@type": "AggregateRating", ratingValue: d.rating, reviewCount: d.reviewCount, bestRating: 5, worstRating: 1 };
  }
  return out;
}

/** JSON for an inline <script type="application/ld+json">: "<" is escaped so the data can never close the tag. */
export const safeJsonLd = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
