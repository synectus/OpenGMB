// packages/core/src/review-links/pure.ts
import { randomBytes } from "node:crypto";
import { GOOGLE_REVIEW_LINK } from "../config/review-link-tool";
import { CoreError } from "../errors";

export const REVIEW_LINK_SOURCES = ["link", "qr", "sms", "email"] as const;
export type ReviewLinkSource = (typeof REVIEW_LINK_SOURCES)[number];
export const REVIEW_LINK_LAYOUTS = ["grid", "list", "carousel", "badge"] as const;
export type ReviewLinkLayout = (typeof REVIEW_LINK_LAYOUTS)[number];

/** Same shape check as geogrid quick scan. */
export const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
/** Our choice: reviews the widget shows, and the longest text it shows. */
export const WIDGET_MAX_REVIEWS = 6;
export const WIDGET_MAX_TEXT = 240;

export const googleReviewUrl = (placeId: string) =>
  GOOGLE_REVIEW_LINK.template.replace("{placeId}", encodeURIComponent(placeId));

export function slugBase(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : "location";
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const randomSuffix = () => [...randomBytes(4)].map((b) => ALPHABET[b % 36]).join("");

export async function uniqueSlug(
  name: string,
  isTaken: (slug: string) => Promise<boolean>,
  rand: () => string = randomSuffix,
): Promise<string> {
  const base = slugBase(name);
  if (!(await isTaken(base))) return base;
  for (let i = 0; i < 10; i++) {
    const s = `${base}-${rand()}`;
    if (!(await isTaken(s))) return s;
  }
  throw new CoreError("CONFLICT", "Could not find a free slug for this link");
}

export const parseSource = (v: string | null | undefined): ReviewLinkSource =>
  (REVIEW_LINK_SOURCES as readonly string[]).includes(v ?? "") ? (v as ReviewLinkSource) : "link";

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|skype|curl|wget|python-requests|headlesschrome|google-pagerenderer|mediapartners|linkexpanding/i;
/** Messaging apps and mail scanners open links to build previews; those are not customers. No user agent counts as a bot. */
export const isLikelyBot = (ua: string | null | undefined) => !ua || BOT.test(ua);

/**
 * The line under the widget, generated on the server and shown verbatim by widget.js. With a
 * minimum it says so; without one it says "a selection". It never says all reviews.
 */
export function widgetNote(minRating: number, layout: ReviewLinkLayout): string {
  if (layout === "badge") return "Rating from Google";
  return minRating > 1 ? `Showing reviews rated ${minRating}★ and up · from Google` : "Showing a selection of recent reviews · from Google";
}

export function shortName(name: string | null | undefined, anonymous: boolean): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (anonymous || parts.length === 0) return "A Google user";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
