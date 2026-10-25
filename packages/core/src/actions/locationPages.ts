// packages/core/src/actions/locationPages.ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import { locationPages } from "@opengmb/db";
import { loadLocation } from "../locationOps/access";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { uniqueSlug } from "../review-links/pure";

const pageOut = z.object({ slug: z.string(), path: z.string(), published: z.boolean(), publishedAt: z.string().nullable() });
const pathOf = (slug: string) => `/l/${slug}`;

export const locationPagesGet = defineAction({
  name: "locationPages.get",
  description:
    "The public landing page of one location: whether it is published, its slug and its path (/l/<slug> on the app's address). The page is off until someone publishes it and shows only data OpenGMB already holds. page is null when it was never published. Read only. Needs location:read.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ locationId: z.string(), page: pageOut.nullable() }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const [p] = await db.select().from(locationPages).where(eq(locationPages.locationId, loc.id));
    return { locationId: loc.id, page: p ? { slug: p.slug, path: pathOf(p.slug), published: p.published, publishedAt: p.publishedAt?.toISOString() ?? null } : null };
  },
});

export const locationPagesSet = defineAction({
  name: "locationPages.set",
  description:
    "Publish or unpublish the public landing page of an active location (published true or false). The first publish creates the page and its public slug; unpublishing keeps the slug and makes the address return 404 and stay out of search. The page shows the profile (name, categories, description, hours, address, phone, website, services), recent reviews with a comment (the review widget's rules apply), recent Google posts and the agency branding. Does not write to Google. Needs location:manage (owner, admin, manager).",
  input: z.object({ locationId: z.uuid(), published: z.boolean() }),
  output: pageOut,
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "location:manage");
    if (input.published && loc.status !== "active") throw new CoreError("INVALID_INPUT", "Location is not active");
    const [existing] = await tx.select().from(locationPages).where(eq(locationPages.locationId, loc.id));
    const now = new Date();
    const shape = (p: { slug: string; published: boolean; publishedAt: Date | null }) => ({ slug: p.slug, path: pathOf(p.slug), published: p.published, publishedAt: p.publishedAt?.toISOString() ?? null });
    if (existing) {
      if (existing.published === input.published) return shape(existing);
      const [p] = await tx
        .update(locationPages)
        .set({ published: input.published, updatedAt: now, ...(input.published ? { publishedAt: now, publishedBy: actor.userId } : {}) })
        .where(eq(locationPages.id, existing.id))
        .returning();
      await audit({ action: input.published ? "location_page.published" : "location_page.unpublished", entityType: "location_page", entityId: existing.id, before: { published: existing.published }, after: { published: input.published, slug: existing.slug } });
      return shape(p!);
    }
    if (!input.published) return { slug: "", path: "", published: false, publishedAt: null };
    const slug = await uniqueSlug(loc.title ?? loc.name, async (s) => {
      const [taken] = await tx.select({ id: locationPages.id }).from(locationPages).where(eq(locationPages.slug, s));
      return Boolean(taken);
    });
    const [p] = await tx
      .insert(locationPages)
      .values({ orgId: actor.orgId, workspaceId: loc.workspaceId, locationId: loc.id, slug, published: true, publishedAt: now, publishedBy: actor.userId })
      .returning();
    await audit({ action: "location_page.published", entityType: "location_page", entityId: p!.id, after: { published: true, slug, locationId: loc.id } });
    return shape(p!);
  },
});
