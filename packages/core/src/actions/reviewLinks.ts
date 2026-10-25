// packages/core/src/actions/reviewLinks.ts
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { reviewLinkClicks, reviewLinks, reviews, workspaceReplySettings } from "@opengmb/db";
import { clientForLocation, googleNames, loadLocation } from "../locationOps/access";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { googleReviewUrl, PLACE_ID, REVIEW_LINK_LAYOUTS, uniqueSlug, widgetNote } from "../review-links/pure";

const widgetOut = z.object({
  enabled: z.boolean(),
  minRating: z.number().int().min(1).max(5),
  layout: z.enum(REVIEW_LINK_LAYOUTS),
  note: z.string(),
});
const clicksOut = z.object({ link: z.number().int(), qr: z.number().int(), sms: z.number().int(), email: z.number().int(), total: z.number().int() });
const profileOf = (p: string | undefined): "general" | "healthcare" | "legal" => (p === "healthcare" || p === "legal" ? p : "general");

export const reviewLinksGet = defineAction({
  name: "reviewLinks.get",
  description:
    "Review request tools for one location: its tracked review link (slug, the /go/<slug> path, Google's review form URL, widget settings and the sentence the widget shows about which reviews it displays), link opens in the last 30 UTC days by source (link, qr, sms, email; never matched to reviews), new reviews in the last 30 days, the average rating and count of all synced reviews, and the workspace reply profile. When no link exists yet, suggestedPlaceId is Google's place id for the location if Google could be read, else null. Read only. Needs review:read.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    location: z.object({ id: z.string(), name: z.string(), workspaceId: z.string() }),
    workspaceProfile: z.enum(["general", "healthcare", "legal"]),
    link: z.object({ slug: z.string(), trackedPath: z.string(), googlePlaceId: z.string(), googleReviewUrl: z.string(), widget: widgetOut }).nullable(),
    suggestedPlaceId: z.string().nullable(),
    clicks30d: clicksOut,
    newReviews30d: z.number().int(),
    summary: z.object({ avgRating: z.number().nullable(), count: z.number().int() }),
  }),
  permission: "review:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "review:read");
    const [link] = await db.select().from(reviewLinks).where(eq(reviewLinks.locationId, loc.id));
    const [settings] = await db.select({ profile: workspaceReplySettings.profile }).from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, loc.workspaceId));
    const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const rows = link
      ? await db
          .select({ source: reviewLinkClicks.source, n: sql<number>`coalesce(sum(${reviewLinkClicks.count}), 0)::int` })
          .from(reviewLinkClicks)
          .where(and(eq(reviewLinkClicks.linkId, link.id), gte(reviewLinkClicks.day, since)))
          .groupBy(reviewLinkClicks.source)
      : [];
    const by = (s: string) => rows.find((r) => r.source === s)?.n ?? 0;
    const clicks = { link: by("link"), qr: by("qr"), sms: by("sms"), email: by("email"), total: 0 };
    clicks.total = clicks.link + clicks.qr + clicks.sms + clicks.email;
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [agg] = await db
      .select({
        n: sql<number>`count(*)::int`,
        avg: sql<string | null>`avg(${reviews.starRating})`,
        recent: sql<number>`(count(*) filter (where ${reviews.createTime} >= ${cutoff}::timestamptz))::int`,
      })
      .from(reviews)
      .where(eq(reviews.locationId, loc.id));
    let suggestedPlaceId: string | null = null;
    if (!link) {
      try {
        const client = await clientForLocation(db, actor, loc);
        const g = await client.getLocation(googleNames(loc).locationName, { readMask: "name,metadata" });
        const id = g.metadata?.placeId;
        suggestedPlaceId = id && PLACE_ID.test(id) ? id : null;
      } catch {
        suggestedPlaceId = null; // not linked, not connected or Google down: the person pastes one
      }
    }
    return {
      location: { id: loc.id, name: loc.name, workspaceId: loc.workspaceId },
      workspaceProfile: profileOf(settings?.profile),
      link: link
        ? {
            slug: link.slug,
            trackedPath: `/go/${link.slug}`,
            googlePlaceId: link.googlePlaceId,
            googleReviewUrl: googleReviewUrl(link.googlePlaceId),
            widget: { enabled: link.widgetEnabled, minRating: link.widgetMinRating, layout: link.widgetLayout, note: widgetNote(link.widgetMinRating, link.widgetLayout) },
          }
        : null,
      suggestedPlaceId,
      clicks30d: clicks,
      newReviews30d: agg?.recent ?? 0,
      summary: { avgRating: agg?.avg == null ? null : Math.round(Number(agg.avg) * 10) / 10, count: agg?.n ?? 0 },
    };
  },
});

export const reviewLinksSave = defineAction({
  name: "reviewLinks.save",
  description:
    "Create or update the tracked review link of an active location. Creating needs placeId (Google place id, letters, digits, - and _, 10 to 300 characters) and generates the public slug. Later calls change only the fields passed: placeId, widgetEnabled (the website widget is off until turned on), widgetMinRating (1 shows every rating, 4 shows 4 and 5 stars; the widget always states it), widgetLayout (grid, list, carousel, badge). A healthcare workspace starts with the badge layout (rating and count, no review text). Does not write to Google. Needs review:draft (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    placeId: z.string().trim().regex(PLACE_ID, "Not a Google place id").optional(),
    widgetEnabled: z.boolean().optional(),
    widgetMinRating: z.number().int().min(1).max(5).optional(),
    widgetLayout: z.enum(REVIEW_LINK_LAYOUTS).optional(),
  }),
  output: z.object({ slug: z.string(), created: z.boolean() }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "review:draft");
    if (loc.status !== "active") throw new CoreError("INVALID_INPUT", "Location is not active");
    const [existing] = await tx.select().from(reviewLinks).where(eq(reviewLinks.locationId, loc.id));
    const changes = {
      ...(input.placeId ? { googlePlaceId: input.placeId } : {}),
      ...(input.widgetEnabled !== undefined ? { widgetEnabled: input.widgetEnabled } : {}),
      ...(input.widgetMinRating !== undefined ? { widgetMinRating: input.widgetMinRating } : {}),
      ...(input.widgetLayout ? { widgetLayout: input.widgetLayout } : {}),
    };
    if (existing) {
      await tx.update(reviewLinks).set({ ...changes, updatedAt: new Date() }).where(eq(reviewLinks.id, existing.id));
      await audit({ action: "review_link.updated", entityType: "review_link", entityId: existing.id, before: { widgetEnabled: existing.widgetEnabled, widgetMinRating: existing.widgetMinRating, widgetLayout: existing.widgetLayout }, after: { slug: existing.slug, ...changes } });
      return { slug: existing.slug, created: false };
    }
    if (!input.placeId) throw new CoreError("INVALID_INPUT", "A Google place id is needed to create the link");
    const [settings] = await tx.select({ profile: workspaceReplySettings.profile }).from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, loc.workspaceId));
    const slug = await uniqueSlug(loc.name, async (s) => {
      const [taken] = await tx.select({ id: reviewLinks.id }).from(reviewLinks).where(eq(reviewLinks.slug, s));
      return Boolean(taken);
    });
    const [row] = await tx
      .insert(reviewLinks)
      .values({
        orgId: actor.orgId,
        workspaceId: loc.workspaceId,
        locationId: loc.id,
        slug,
        googlePlaceId: input.placeId,
        widgetEnabled: input.widgetEnabled ?? false,
        widgetMinRating: input.widgetMinRating ?? 4,
        widgetLayout: input.widgetLayout ?? (settings?.profile === "healthcare" ? "badge" : "grid"),
        createdBy: actor.userId,
      })
      .returning({ id: reviewLinks.id });
    await audit({ action: "review_link.created", entityType: "review_link", entityId: row!.id, after: { slug, locationId: loc.id } });
    return { slug, created: true };
  },
});
