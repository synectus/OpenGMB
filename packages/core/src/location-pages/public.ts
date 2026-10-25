// packages/core/src/location-pages/public.ts
import { and, desc, eq, gte, isNotNull, ne, or, isNull, sql } from "drizzle-orm";
import { googleMedia, googlePosts, locationPages, locations, profileSnapshots, reviewLinks, reviews, workspaceReplySettings, type Db } from "@opengmb/db";
import { loadBranding } from "../branding";
import { snapshotFromJson } from "../profile/fields";
import { clip, shortName, SLUG_RE, WIDGET_MAX_TEXT } from "../review-links/pure";
import {
  categoryLabel, hoursRows, httpsOnly, mapsUrl,
  PAGE_MAX_PHOTOS, PAGE_MAX_POSTS, PAGE_MAX_REVIEWS, PAGE_MAX_SERVICES, PAGE_MAX_TEXT,
  type PageData,
} from "./pure";

export type PublicLocationPage = { data: PageData; regularHours: unknown; updatedAt: Date };

const serviceName = (s: unknown): string | null => {
  const f = (s as { freeFormServiceItem?: { label?: { displayName?: string } } }).freeFormServiceItem?.label?.displayName;
  if (f) return f;
  const id = (s as { structuredServiceItem?: { serviceTypeId?: string } }).structuredServiceItem?.serviceTypeId;
  return id ? categoryLabel(id.replace(/^job_type_id:/, "")) : null;
};

/**
 * The public page content, or null when the slug is unknown, the page is not published or the
 * location is inactive (all look the same: 404). Everything is read from stored data; Google is
 * never called. Review rules follow the R5 widget: only reviews with a comment, at or above the
 * widget's minimum rating (4 when there is no review link), and no review text at all for a
 * healthcare workspace or a badge-layout widget. Posts: live only.
 */
export async function locationPageData(db: Db, slug: string): Promise<PublicLocationPage | null> {
  if (!SLUG_RE.test(slug)) return null;
  const [row] = await db
    .select({ page: locationPages, loc: locations })
    .from(locationPages)
    .innerJoin(locations, eq(locations.id, locationPages.locationId))
    .where(and(eq(locationPages.slug, slug), eq(locationPages.published, true), eq(locations.status, "active")));
  if (!row) return null;
  const { page, loc } = row;

  const [snap] = await db
    .select({ data: profileSnapshots.data })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.locationId, loc.id))
    .orderBy(desc(profileSnapshots.takenAt), desc(profileSnapshots.id))
    .limit(1);
  const f = snap ? snapshotFromJson(snap.data).fields : {};
  const cats = f.categories as { primaryCategory?: { name: string }; additionalCategories?: { name: string }[] } | null | undefined;
  const phones = f.phoneNumbers as { primaryPhone?: string } | null | undefined;
  const hours = f.regularHours ?? null;
  const name = (f.title as string | null | undefined) ?? loc.title ?? loc.name;
  const address = loc.addressSummary;

  const [link] = await db.select().from(reviewLinks).where(eq(reviewLinks.locationId, loc.id));
  const [settings] = await db.select({ profile: workspaceReplySettings.profile }).from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, loc.workspaceId));
  const noText = link ? link.widgetLayout === "badge" : settings?.profile === "healthcare";
  const minRating = link?.widgetMinRating ?? 4;
  const [agg] = await db
    .select({ n: sql<number>`count(${reviews.starRating})::int`, avg: sql<string | null>`avg(${reviews.starRating})` })
    .from(reviews)
    .where(eq(reviews.locationId, loc.id));
  const shown = noText
    ? []
    : await db
        .select({ rating: reviews.starRating, comment: reviews.comment, reviewer: reviews.reviewerDisplayName, anon: reviews.reviewerIsAnonymous })
        .from(reviews)
        .where(and(eq(reviews.locationId, loc.id), gte(reviews.starRating, minRating), isNotNull(reviews.comment), ne(reviews.comment, "")))
        .orderBy(desc(reviews.createTime))
        .limit(PAGE_MAX_REVIEWS);

  const posts = await db
    .select({ summary: googlePosts.summary, mediaUrl: googlePosts.mediaUrl, ctaUrl: googlePosts.ctaUrl })
    .from(googlePosts)
    .where(and(eq(googlePosts.locationId, loc.id), or(isNull(googlePosts.state), eq(googlePosts.state, "LIVE")), ne(googlePosts.summary, "")))
    .orderBy(desc(googlePosts.googleCreatedAt))
    .limit(PAGE_MAX_POSTS);

  const photoRows = await db
    .select({ url: googleMedia.googleUrl, category: googleMedia.category, description: googleMedia.description })
    .from(googleMedia)
    .where(eq(googleMedia.locationId, loc.id))
    .orderBy(sql`${googleMedia.googleCreatedAt} desc nulls last`, desc(googleMedia.syncedAt), desc(googleMedia.id))
    .limit(PAGE_MAX_PHOTOS * 2);
  const photos = photoRows.flatMap((r) => {
    const url = httpsOnly(r.url);
    if (!url) return [];
    const kind = r.category ? r.category.replace(/_/g, " ").toLowerCase() : null;
    const alt = r.description?.trim() ? clip(r.description.trim(), 125) : kind ? `${name}, ${kind} photo` : `Photo of ${name}`;
    return [{ url, alt }];
  }).slice(0, PAGE_MAX_PHOTOS);

  const brand = await loadBranding(db, loc.orgId);
  const services = ((f.serviceItems as unknown[] | null | undefined) ?? []).map(serviceName).filter((s): s is string => !!s).slice(0, PAGE_MAX_SERVICES);

  return {
    regularHours: hours,
    updatedAt: page.updatedAt,
    data: {
      slug: page.slug,
      name,
      description: (f.description as string | null | undefined) ?? null,
      categories: [cats?.primaryCategory?.name, ...(cats?.additionalCategories ?? []).map((c) => c.name)].filter((c): c is string => !!c).map(categoryLabel),
      address,
      mapUrl: mapsUrl(name, address),
      phone: phones?.primaryPhone ?? loc.phone,
      website: httpsOnly(f.websiteUri as string | null | undefined),
      hours: hoursRows(hours),
      services,
      rating: agg?.avg == null ? null : Math.round(Number(agg.avg) * 10) / 10,
      reviewCount: agg?.n ?? 0,
      reviewNote: shown.length ? (minRating > 1 ? `Showing reviews rated ${minRating} stars and up, from Google` : "Showing a selection of recent reviews, from Google") : null,
      reviews: shown.map((r) => ({ rating: r.rating!, text: clip(r.comment!, WIDGET_MAX_TEXT), name: shortName(r.reviewer, r.anon) })),
      posts: posts.map((p) => ({ summary: clip(p.summary, PAGE_MAX_TEXT), imageUrl: httpsOnly(p.mediaUrl), linkUrl: httpsOnly(p.ctaUrl) })),
      photos,
      brand: { agencyName: brand.agencyName, logoUrl: httpsOnly(brand.logoUrl), primaryColor: brand.primaryColor },
    },
  };
}
