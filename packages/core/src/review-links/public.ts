// packages/core/src/review-links/public.ts
import { and, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { locations, reviewLinkClicks, reviewLinks, reviews, type Db } from "@opengmb/db";
import { clip, googleReviewUrl, shortName, SLUG_RE, WIDGET_MAX_REVIEWS, WIDGET_MAX_TEXT, widgetNote, type ReviewLinkLayout, type ReviewLinkSource } from "./pure";

/**
 * The public redirect. Looks the slug up, counts the open (never blocking the redirect when the
 * counter fails) and returns Google's review form URL, or null for an unknown slug. No actor, no
 * audit row: it is public and high volume. Stores a count per (link, UTC day, source) and nothing else.
 */
export async function resolveReviewLink(
  db: Db,
  slug: string,
  o: { source: ReviewLinkSource; count: boolean; now?: Date },
): Promise<string | null> {
  if (!SLUG_RE.test(slug)) return null;
  const [link] = await db
    .select({ id: reviewLinks.id, orgId: reviewLinks.orgId, placeId: reviewLinks.googlePlaceId })
    .from(reviewLinks)
    .where(eq(reviewLinks.slug, slug));
  if (!link) return null;
  if (o.count) {
    try {
      await db
        .insert(reviewLinkClicks)
        .values({ orgId: link.orgId, linkId: link.id, day: (o.now ?? new Date()).toISOString().slice(0, 10), source: o.source, count: 1 })
        .onConflictDoUpdate({
          target: [reviewLinkClicks.linkId, reviewLinkClicks.day, reviewLinkClicks.source],
          set: { count: sql`${reviewLinkClicks.count} + 1` },
        });
    } catch (e) {
      console.error("[review-links] click not counted", e);
    }
  }
  return googleReviewUrl(link.placeId);
}

export type WidgetData = {
  name: string;
  /** Average over every synced review, not only the ones shown. */
  rating: number | null;
  count: number;
  layout: ReviewLinkLayout;
  minRating: number;
  note: string;
  reviews: { rating: number; text: string; name: string }[];
};

/** The public widget answer, or null when the slug is unknown, the widget is off or the location is inactive (all look the same). */
export async function widgetData(db: Db, slug: string): Promise<WidgetData | null> {
  if (!SLUG_RE.test(slug)) return null;
  const [row] = await db
    .select({ link: reviewLinks, name: locations.name, title: locations.title })
    .from(reviewLinks)
    .innerJoin(locations, eq(locations.id, reviewLinks.locationId))
    .where(and(eq(reviewLinks.slug, slug), eq(reviewLinks.widgetEnabled, true), eq(locations.status, "active")));
  if (!row) return null;
  const { link } = row;
  const [agg] = await db
    .select({ n: sql<number>`count(*)::int`, avg: sql<string | null>`avg(${reviews.starRating})` })
    .from(reviews)
    .where(eq(reviews.locationId, link.locationId));
  const shown =
    link.widgetLayout === "badge"
      ? []
      : await db
          .select({ rating: reviews.starRating, comment: reviews.comment, reviewer: reviews.reviewerDisplayName, anon: reviews.reviewerIsAnonymous })
          .from(reviews)
          .where(and(eq(reviews.locationId, link.locationId), gte(reviews.starRating, link.widgetMinRating), isNotNull(reviews.comment), ne(reviews.comment, "")))
          .orderBy(desc(reviews.createTime))
          .limit(WIDGET_MAX_REVIEWS);
  return {
    name: row.title ?? row.name,
    rating: agg?.avg === null || agg === undefined ? null : Math.round(Number(agg.avg) * 10) / 10,
    count: agg?.n ?? 0,
    layout: link.widgetLayout,
    minRating: link.widgetMinRating,
    note: widgetNote(link.widgetMinRating, link.widgetLayout),
    reviews: shown.map((r) => ({ rating: r.rating!, text: clip(r.comment!, WIDGET_MAX_TEXT), name: shortName(r.reviewer, r.anon) })),
  };
}
